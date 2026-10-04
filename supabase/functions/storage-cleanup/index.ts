// storage-cleanup — B5 bounded orphan-object cleanup for `company-documents`,
// plus expired-temporary-document hygiene.
//
// What it does: enumerates Storage objects under ONE tenant's prefix, classifies
// each against the application's own document convention and database state, and
// (only in apply mode) deletes confirmed stale orphans — bounded per invocation.
// Separately, it lists expired temporary documents (`expires_at` passed) and,
// only in apply mode, deletes them through the existing `delete-document`
// action — reusing that primitive's exact semantics (document → chunks
// cascade → object → jobs) rather than inventing a second deleter.
//
// Safety model:
//  - Caller JWT (gateway verify_jwt on) + membership of the requested tenant.
//    dry-run: any member. apply: owner/admin only.
//  - The client names a tenant, never a path. Object paths are derived from the
//    tenant prefix; nothing outside it is ever examined or touched.
//  - Runs entirely on the caller's JWT: RLS applies to every database read and
//    to the Storage listing/removal. No service_role is used here.
//  - Anything ambiguous (folder rows, unknown age, unrecognized path, foreign
//    prefix) is classified `unsafe` and preserved. Skip rather than delete.
//  - Deletion is re-checked against a fresh document reference read, capped at
//    MAX_DELETES_PER_CALL, and is idempotent: a rerun finds nothing new.
//  - Expired temporary documents are classified and reported separately from
//    ordinary orphans, and are deleted only through `delete-document` (never
//    by raw object removal, which would strand chunk rows). Persistent
//    documents (`expires_at IS NULL`), unexpired temporaries, and any document
//    with an active ingestion job are never touched here. Retrieval-time
//    expiry filtering — not this sweep — is the access boundary; a failed
//    sweep degrades to storage hygiene, never to exposure.
//
// Logs are metadata only (counts, tenant, mode, timing). No paths, no secrets,
// no signed URLs, no authorization headers.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { requestTooLarge } from "../_shared/request-size.ts";
import {
  classifyAll,
  CLEANUP_VERSION,
  DEFAULT_MAX_AGE_MS,
  type StorageObjectInfo,
} from "../_shared/orphan-policy.ts";

const BUCKET = "company-documents";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bounds: a bad or huge listing can never trigger an unrestricted operation.
const MAX_FOLDERS = 500;
const MAX_OBJECTS = 2000;
const LIST_PAGE = 1000;
const DEFAULT_MAX_DELETES = 25;
const HARD_MAX_DELETES = 100;
const DELETE_CHUNK = 20;
const REPORT_SAMPLE = 50;

type ListEntry = {
  name: string;
  id: string | null;
  created_at?: string | null;
  metadata: { size?: unknown } | null;
};

Deno.serve(async (req: Request): Promise<Response> => {
  const t0 = performance.now();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  const preflight = corsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  // Anonymous-abuse hardening: reject clearly oversized requests BEFORE
  // auth/body parsing — header read only, no DB, no provider, no counter.
  if (requestTooLarge(req)) return json(413, { ok: false, error: "request too large" });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { ok: false, error: "missing bearer token" });
  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data: udata, error: uerr } = await db.auth.getUser(jwt);
  if (uerr || !udata?.user) return json(401, { ok: false, error: "invalid token" });
  const caller = udata.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const tenantId = String(body.tenant_id ?? "");
  if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
  const mode = String(body.mode ?? "dry-run");
  if (mode !== "dry-run" && mode !== "apply") {
    return json(400, { ok: false, error: "mode must be dry-run|apply" });
  }
  const requestedMax = Number(body.max_deletes ?? DEFAULT_MAX_DELETES);
  const maxDeletes = Math.min(
    HARD_MAX_DELETES,
    Math.max(1, Number.isFinite(requestedMax) ? Math.floor(requestedMax) : DEFAULT_MAX_DELETES),
  );

  const { data: mem } = await db.from("memberships")
    .select("role").eq("tenant_id", tenantId).eq("user_id", caller).limit(1);
  if (!mem || mem.length === 0) return json(403, { ok: false, error: "not a member of this tenant" });
  const role = String((mem[0] as { role?: string }).role ?? "");
  if (mode === "apply" && role !== "owner" && role !== "admin") {
    return json(403, { ok: false, error: "apply requires owner or admin" });
  }

  // 1. Enumerate every object under this tenant's prefix (bounded BFS).
  const queue: string[] = [`tenants/${tenantId}`];
  const objects: StorageObjectInfo[] = [];
  let foldersScanned = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (foldersScanned >= MAX_FOLDERS || objects.length >= MAX_OBJECTS) {
      truncated = true;
      break;
    }
    const prefix = queue.shift() as string;
    foldersScanned++;
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await db.storage.from(BUCKET).list(prefix, { limit: LIST_PAGE, offset });
      if (error) {
        console.error(JSON.stringify({ scope: "storage", context: "list failed" }));
        return json(500, { ok: false, error: "storage list failed" });
      }
      const entries = (data ?? []) as ListEntry[];
      for (const entry of entries) {
        const full = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null || entry.metadata === null) {
          queue.push(full); // folder placeholder — never an object of ours
        } else {
          objects.push({
            name: full,
            size: typeof entry.metadata.size === "number" ? entry.metadata.size : null,
            created_at: entry.created_at ?? null,
          });
        }
        if (objects.length >= MAX_OBJECTS) { truncated = true; break; }
      }
      if (truncated || entries.length < LIST_PAGE) break;
    }
  }

  // 2. Reference sets from the database (caller JWT; RLS applies).
  const { data: docs, error: docErr } = await db.from("documents")
    .select("id, storage_path").eq("tenant_id", tenantId);
  if (docErr) {
    console.error(JSON.stringify({ scope: "db-error", context: "documents read failed" }));
    return json(500, { ok: false, error: "documents read failed" });
  }
  const pathById = new Map((docs ?? []).map((d: { id: string; storage_path: string }) => [d.id, d.storage_path]));
  const referencedPaths = new Set((docs ?? []).map((d: { storage_path: string }) => d.storage_path));

  const { data: jobs, error: jobErr } = await db.from("ingest_jobs")
    .select("document_id").eq("tenant_id", tenantId).in("status", ["pending", "processing"]);
  if (jobErr) {
    console.error(JSON.stringify({ scope: "db-error", context: "jobs read failed" }));
    return json(500, { ok: false, error: "jobs read failed" });
  }
  const activePaths = new Set(
    (jobs ?? [])
      .map((j: { document_id: string }) => pathById.get(j.document_id))
      .filter((p: string | undefined): p is string => typeof p === "string"),
  );

  // 3. Classify.
  const result = classifyAll({
    tenantId,
    referencedPaths,
    activePaths,
    objects,
    now: Date.now(),
    maxAgeMs: DEFAULT_MAX_AGE_MS,
  });

  // 4. Apply: delete only orphans, re-checked against a fresh reference read.
  const deleted: string[] = [];
  const deleteErrors: string[] = [];
  if (mode === "apply" && result.orphans.length > 0) {
    const planned = result.orphans.slice(0, maxDeletes);
    const { data: fresh, error: freshErr } = await db.from("documents")
      .select("storage_path").eq("tenant_id", tenantId).in("storage_path", planned);
    if (freshErr) {
      console.error(JSON.stringify({ scope: "db-error", context: "recheck failed" }));
      return json(500, { ok: false, error: "recheck failed" });
    }
    const nowReferenced = new Set((fresh ?? []).map((d: { storage_path: string }) => d.storage_path));
    const safe = planned.filter((path) => !nowReferenced.has(path));
    for (let i = 0; i < safe.length; i += DELETE_CHUNK) {
      const chunk = safe.slice(i, i + DELETE_CHUNK);
      const { data: removed, error: rmErr } = await db.storage.from(BUCKET).remove(chunk);
      if (rmErr) {
        console.error(JSON.stringify({ scope: "storage", context: "remove failed" }));
        deleteErrors.push("remove failed");
        continue;
      }
      const removedNames = new Set((removed ?? []).map((o: { name: string }) => o.name));
      for (const path of chunk) {
        if (removedNames.has(path)) deleted.push(path);
        else deleteErrors.push(`not removed: ${path}`);
      }
    }
  }

  // 5. Expired temporary documents: row-driven, classified separately from
  // ordinary orphaned objects above (which this section never touches).
  // Eligibility is conservative: expired AND no active ingestion job AND
  // re-verified immediately before deletion. Failed tombstones are eligible
  // too — expiry, not status, is the criterion.
  const TEMP_MAX_DELETES = 25;
  let tempFound = 0;
  let tempDeleted = 0;
  const tempErrors: string[] = [];
  const tempCandidates: string[] = [];
  {
    const nowIso = new Date().toISOString();
    const { data: expired, error: expiredErr } = await db.from("documents")
      .select("id, storage_path")
      .eq("tenant_id", tenantId)
      .not("expires_at", "is", null)
      .lte("expires_at", nowIso)
      .limit(100);
    if (expiredErr) {
      console.error(JSON.stringify({ scope: "db-error", context: "expired temp read failed" }));
      return json(500, { ok: false, error: "expired temp read failed" });
    }
    const rows = (expired ?? []) as Array<{ id: string; storage_path: string }>;
    tempFound = rows.length;
    for (const row of rows.slice(0, REPORT_SAMPLE)) tempCandidates.push(row.storage_path);
    if (mode === "apply" && tempFound > 0) {
      const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      if (!supabaseUrl || !anonKey) {
        return json(500, { ok: false, error: "platform configuration unavailable" });
      }
      let remaining = TEMP_MAX_DELETES;
      for (const row of rows) {
        if (remaining <= 0) break;
        // A document with an active job needs attention, not silent deletion.
        const { data: activeJobs } = await db.from("ingest_jobs")
          .select("id").eq("document_id", row.id).in("status", ["pending", "processing"]).limit(1);
        if (activeJobs && activeJobs.length > 0) continue;
        // Fresh re-read: still the same expired temporary document?
        const { data: fresh } = await db.from("documents")
          .select("id, tenant_id, expires_at").eq("id", row.id).limit(1);
        const current = (fresh ?? [])[0] as
          | { id: string; tenant_id: string; expires_at: string | null }
          | undefined;
        if (
          !current || current.tenant_id !== tenantId ||
          current.expires_at === null || current.expires_at > nowIso
        ) {
          continue;
        }
        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/ingest-pdf`, {
            method: "POST",
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "delete-document", document_id: current.id }),
          });
          if (!r.ok) {
            tempErrors.push(`expired temp delete failed: ${r.status}`);
            continue;
          }
          tempDeleted++;
          remaining--;
        } catch {
          tempErrors.push("expired temp delete failed");
        }
      }
    }
  }

  const sample = [...result.classified]
    .sort((a, b) => priority(b.classification) - priority(a.classification))
    .slice(0, REPORT_SAMPLE)
    .map((row) => ({
      name: row.name, classification: row.classification,
      reason: row.reason, age_hours: row.age_hours, size: row.size,
    }));

  const totalMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify({
    fn: "storage-cleanup", version: CLEANUP_VERSION, mode, tenant_id: tenantId, role,
    examined: objects.length, truncated,
    counts: result.counts,
    orphans_found: result.orphans.length,
    deleted: deleted.length,
    delete_errors: deleteErrors.length,
    expired_temp_found: tempFound,
    expired_temp_deleted: tempDeleted,
    expired_temp_errors: tempErrors.length,
    total_ms: totalMs,
  }));

  return json(200, {
    ok: true,
    version: CLEANUP_VERSION,
    mode,
    tenant_id: tenantId,
    bucket: BUCKET,
    checked_at: new Date().toISOString(),
    age_threshold_hours: DEFAULT_MAX_AGE_MS / 3_600_000,
    bounds: {
      folders_scanned: foldersScanned,
      objects_examined: objects.length,
      truncated,
      max_deletes: maxDeletes,
    },
    counts: {
      examined: objects.length,
      orphans: result.orphans.length,
      deleted: deleted.length,
      skipped: objects.length - result.orphans.length,
    },
    classified: result.counts,
    candidates: sample,
    orphan_paths: result.orphans.slice(0, REPORT_SAMPLE),
    deleted_paths: deleted,
    delete_errors: deleteErrors,
    expired_temp_documents: {
      found: tempFound,
      deleted: tempDeleted,
      delete_errors: tempErrors,
      candidates: tempCandidates,
    },
    total_ms: totalMs,
  });
});

function priority(classification: string): number {
  switch (classification) {
    case "orphan": return 5;
    case "unsafe": return 4;
    case "active": return 3;
    case "too_young": return 2;
    default: return 1;
  }
}
