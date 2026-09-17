// B5 — orphan-object policy (pure, testable).
//
// Decides whether a Storage object inside the `company-documents` bucket may be
// deleted. It never performs I/O and never decides on its own to delete: the
// caller supplies the object inventory and the two database-derived reference
// sets, and every decision is a deterministic function of those inputs.
//
// Conservative by construction. Anything that does not map cleanly to the
// application's document convention is classified `unsafe` and preserved:
// a wrong guess must never delete a valid object.

export const CLEANUP_VERSION = "b5-v1";
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export type StorageObjectInfo = {
  /** Full object key inside the bucket, e.g. `tenants/<tid>/docs/x/a.pdf`. */
  name: string;
  /** Bytes, from Storage metadata; null for folder placeholders. */
  size: number | null;
  /** ISO timestamp from Storage metadata; null when unknown. */
  created_at: string | null;
};

export type Classification = "valid" | "too_young" | "active" | "orphan" | "unsafe";

export type ClassifiedObject = {
  name: string;
  classification: Classification;
  reason: string;
  age_hours: number | null;
  size: number | null;
};

export type PolicyInput = {
  tenantId: string;
  /** `documents.storage_path` for every document of the tenant (any status). */
  referencedPaths: Set<string>;
  /** Paths of documents with a pending/processing ingestion job. */
  activePaths: Set<string>;
  objects: StorageObjectInfo[];
  now: number;
  maxAgeMs?: number;
};

/** The path shape the application itself writes: tenants/<tid>/docs/.../*.pdf */
export function documentPathPrefix(tenantId: string): string {
  return `tenants/${tenantId}/docs/`;
}

/**
 * True only for paths that the application's own upload/ingest convention
 * produces. `ingest-pdf` additionally requires the `.pdf` suffix and rejects
 * `..` segments; the `docs/` segment is what every real document object uses.
 */
export function isConventionalDocumentPath(tenantId: string, path: string): boolean {
  const prefix = documentPathPrefix(tenantId);
  if (!path.startsWith(prefix)) return false;
  if (!path.endsWith(".pdf")) return false;
  if (path.includes("..")) return false;
  return path.length > prefix.length + 4;
}

export function classifyObject(input: PolicyInput, object: StorageObjectInfo): ClassifiedObject {
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const base = { name: object.name, size: object.size };

  // Folder placeholders and anything without real object metadata are never
  // candidates: Storage folder rows are not deletable objects of ours.
  if (object.size === null) {
    return { ...base, classification: "unsafe", reason: "no-object-metadata", age_hours: null };
  }

  // Must look exactly like a document object this application writes.
  if (!isConventionalDocumentPath(input.tenantId, object.name)) {
    return { ...base, classification: "unsafe", reason: "unrecognized-path", age_hours: null };
  }

  // Referenced by ANY document row (pending, ready or failed): the object
  // belongs to a document the user can see, retry or delete themselves.
  if (input.referencedPaths.has(object.name)) {
    return { ...base, classification: "valid", reason: "document-referenced", age_hours: ageHours(input.now, object.created_at) };
  }

  // Defense in depth: an in-flight ingestion job must never lose its source.
  // (Today a job always has a document row, so this is redundant — kept so the
  // rule holds even if that ever changes.)
  if (input.activePaths.has(object.name)) {
    return { ...base, classification: "active", reason: "active-ingestion-job", age_hours: ageHours(input.now, object.created_at) };
  }

  const age = ageHours(input.now, object.created_at);
  if (age === null) {
    return { ...base, classification: "unsafe", reason: "unknown-age", age_hours: null };
  }

  // A fresh upload may simply not be registered yet: never delete it.
  if (input.now - Date.parse(object.created_at as string) < maxAgeMs) {
    return { ...base, classification: "too_young", reason: "younger-than-threshold", age_hours: age };
  }

  return { ...base, classification: "orphan", reason: "unreferenced-and-stale", age_hours: age };
}

function ageHours(now: number, createdAt: string | null): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round(((now - t) / 3_600_000) * 10) / 10);
}

export type PolicyResult = {
  classified: ClassifiedObject[];
  counts: Record<Classification, number>;
  /** Orphan paths in inventory order — the only deletable candidates. */
  orphans: string[];
};

export function classifyAll(input: PolicyInput): PolicyResult {
  const classified = input.objects.map((object) => classifyObject(input, object));
  const counts: Record<Classification, number> = {
    valid: 0, too_young: 0, active: 0, orphan: 0, unsafe: 0,
  };
  for (const row of classified) counts[row.classification] += 1;
  return {
    classified,
    counts,
    orphans: classified.filter((r) => r.classification === "orphan").map((r) => r.name),
  };
}
