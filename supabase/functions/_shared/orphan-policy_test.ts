// Unit tests for the B5 orphan policy. Pure functions only.
// Run: deno test supabase/functions/_shared/orphan-policy_test.ts

import {
  classifyAll,
  classifyObject,
  DEFAULT_MAX_AGE_MS,
  documentPathPrefix,
  isConventionalDocumentPath,
  type PolicyInput,
  type StorageObjectInfo,
} from "./orphan-policy.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = Date.parse("2026-09-17T12:00:00Z");
const OLD = "2026-09-10T12:00:00Z"; // 7 days old
const FRESH = "2026-09-17T11:30:00Z"; // 30 minutes old

function obj(name: string, createdAt: string | null = OLD, size: number | null = 100): StorageObjectInfo {
  return { name, size, created_at: createdAt };
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tenantId: TENANT,
    referencedPaths: new Set<string>(),
    activePaths: new Set<string>(),
    objects: [],
    now: NOW,
    ...overrides,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const DOC = `tenants/${TENANT}/docs/phase3c3/incometax.pdf`;

Deno.test("path convention accepts real document paths", () => {
  assert(isConventionalDocumentPath(TENANT, DOC), "docs/ path should pass");
  assert(isConventionalDocumentPath(TENANT, `tenants/${TENANT}/docs/a/b/c/x.pdf`), "nested path should pass");
});

Deno.test("path convention rejects foreign, non-doc and non-pdf paths", () => {
  assert(!isConventionalDocumentPath(TENANT, `tenants/22222222-2222-2222-2222-222222222222/docs/a.pdf`), "other tenant");
  assert(!isConventionalDocumentPath(TENANT, `tenants/${TENANT}/a.pdf`), "no docs/ segment");
  assert(!isConventionalDocumentPath(TENANT, `tenants/${TENANT}/docs/a/notes.txt`), "not a pdf");
  assert(!isConventionalDocumentPath(TENANT, `tenants/${TENANT}/docs/../secret.pdf`), "dot-dot");
  assert(!isConventionalDocumentPath(TENANT, `tenants/${TENANT}/docs/`), "empty name");
});

Deno.test("referenced object is valid and preserved", () => {
  const r = classifyObject(input({ referencedPaths: new Set([DOC]) }), obj(DOC));
  assert(r.classification === "valid", `expected valid, got ${r.classification}`);
  assert(r.reason === "document-referenced", r.reason);
});

Deno.test("referenced failed document still protects its object", () => {
  const r = classifyObject(input({ referencedPaths: new Set([DOC]) }), obj(DOC));
  assert(r.classification === "valid", "failed docs keep their object for retry");
});

Deno.test("active ingestion job protects an unreferenced path", () => {
  const r = classifyObject(input({ activePaths: new Set([DOC]) }), obj(DOC));
  assert(r.classification === "active", `expected active, got ${r.classification}`);
});

Deno.test("young unreferenced object is preserved", () => {
  const r = classifyObject(input(), obj(DOC, FRESH));
  assert(r.classification === "too_young", `expected too_young, got ${r.classification}`);
});

Deno.test("old unreferenced conventional object is an orphan", () => {
  const r = classifyObject(input(), obj(DOC));
  assert(r.classification === "orphan", `expected orphan, got ${r.classification}`);
  assert(r.age_hours !== null && r.age_hours > 24, `age ${r.age_hours}`);
});

Deno.test("just-inside-threshold object is preserved", () => {
  const atThreshold = new Date(NOW - DEFAULT_MAX_AGE_MS + 60_000).toISOString();
  const r = classifyObject(input(), obj(DOC, atThreshold));
  assert(r.classification === "too_young", `expected too_young, got ${r.classification}`);
});

Deno.test("unrecognized path never becomes an orphan", () => {
  const r = classifyObject(input(), obj(`tenants/${TENANT}/loose/file.pdf`));
  assert(r.classification === "unsafe" && r.reason === "unrecognized-path", r.reason);
});

Deno.test("folder placeholders are unsafe", () => {
  const r = classifyObject(input(), obj(`tenants/${TENANT}/docs/folder`, OLD, null));
  assert(r.classification === "unsafe" && r.reason === "no-object-metadata", r.reason);
});

Deno.test("unknown age is unsafe", () => {
  const r = classifyObject(input(), obj(DOC, null));
  assert(r.classification === "unsafe" && r.reason === "unknown-age", r.reason);
});

Deno.test("classifyAll returns counts and only orphan paths", () => {
  const result = classifyAll(input({
    referencedPaths: new Set([DOC]),
    activePaths: new Set([`tenants/${TENANT}/docs/active/a.pdf`]),
    objects: [
      obj(DOC),
      obj(`tenants/${TENANT}/docs/orphan1/a.pdf`),
      obj(`tenants/${TENANT}/docs/fresh/a.pdf`, FRESH),
      obj(`tenants/${TENANT}/docs/active/a.pdf`),
      obj(`tenants/${TENANT}/other/a.pdf`),
    ],
  }));
  assert(result.counts.valid === 1, `valid ${result.counts.valid}`);
  assert(result.counts.orphan === 1, `orphan ${result.counts.orphan}`);
  assert(result.counts.too_young === 1, `too_young ${result.counts.too_young}`);
  assert(result.counts.active === 1, `active ${result.counts.active}`);
  assert(result.counts.unsafe === 1, `unsafe ${result.counts.unsafe}`);
  assert(result.orphans.length === 1 && result.orphans[0].includes("orphan1"), JSON.stringify(result.orphans));
});

Deno.test("prefix helper matches the ingest-pdf convention", () => {
  assert(documentPathPrefix(TENANT) === `tenants/${TENANT}/docs/`, documentPathPrefix(TENANT));
});
