// ingest-pdf — Phase 2A production ingestion slice.
//
// Pipeline: private Storage PDF -> documents + ingest_jobs state -> proven
// Edge parser (unpdf, page-preserving) -> 1000/200 chunks -> chunks rows.
//
// Phase 2A scope: NO Bedrock, NO embeddings. chunks.embedding stays NULL and
// chunk_ids carry the 'none-v1' pipeline tag so the embedding phase can tell
// unembedded rows apart (it must backfill/replace them, never reinterpret).
//
// Security posture: every data-plane call runs as the CALLER's JWT, so
// PostgreSQL RLS + Storage policies enforce tenant isolation on top of the
// explicit membership checks below (defense in depth). No service_role is
// used anywhere in this function. NOTE: service_role currently holds no
// grants on the application tables (Supabase does not auto-grant); any
// future service_role consumer (e.g. usage counter writer) needs its own
// grants migration — do not assume it can read/write these tables.
//
// Safety properties:
// - Stateless worker; retries converge (deterministic chunk_ids + INSERT ..
//   ON CONFLICT DO NOTHING + stale-chunk delete by ID set).
// - documents.status reaches 'ready' ONLY via the embed-worker, after chunks
//   persist with content AND embeddings (parse alone leaves pending).
// - Updates (changed content_hash) replace the chunk set; deletes cascade.
// - Logs metadata only (ids, counts, sizes, hashes). Never content/secrets.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText } from "npm:unpdf@1.8.1";
import { tempExpiresAt } from "../_shared/temp-scope.ts";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { enforceCostGate } from "../_shared/cost-control.ts";
import { requestTooLarge } from "../_shared/request-size.ts";

const BUCKET = "company-documents";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const PIPELINE_TAG = "none-v1";
const INSERT_BATCH = 100;

// --- B3 upload-safety limits (approved in the UI Pass 4 audit §15) ----------
// Enforced server-side on every ingest call. `file_size` (Storage metadata) is
// the authoritative storage-budget input; nothing here trusts a caller value.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 26,214,400 — plan ceiling is 50 MB
const MAX_TENANT_STORAGE_BYTES = 400 * 1024 * 1024; // 40% of the 1 GB quota
const MAX_TENANT_DOCUMENTS = 60; // active documents (pending | ready)
const MAX_TENANT_CHUNKS = 20000; // ≈220 MB of the 500 MB database budget
const MAX_PROCESSING_JOBS = 1; // the worker claims one job at a time
const MAX_PENDING_JOBS = 3;
// M-2: content bounds before in-memory parse/chunk (decompression-bomb guard).
// Generous ceilings that no legitimate 25 MB PDF hits; only crafted abuse does.
const MAX_PDF_PAGES = 2000;
const MAX_EXTRACTED_CHARS = 10_000_000;

// RecursiveCharacterTextSplitter-equivalent (chars). Same behavior proven in
// the Phase 2 POCs; do not retune here.
function chunkText(text: string, size: number, overlap: number): string[] {
  const seps = ["\n\n", "\n", " ", ""];
  function splitOn(t: string, idx: number): string[] {
    if (t.length <= size) return [t];
    const sep = seps[idx];
    if (sep === "") {
      const out: string[] = [];
      for (let i = 0; i < t.length; i += size - overlap) out.push(t.slice(i, i + size));
      return out;
    }
    const parts = t.split(sep).filter((p) => p !== "");
    const out: string[] = [];
    let cur = "";
    for (const p of parts) {
      const cand = cur ? cur + sep + p : p;
      if (cand.length > size) {
        if (cur) out.push(cur);
        if (p.length > size) out.push(...splitOn(p, idx + 1));
        else cur = p;
      } else cur = cand;
    }
    if (cur) out.push(cur);
    return out;
  }
  return splitOn(text, 0).filter((c) => c.length > 0);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// deno-lint-ignore no-explicit-any
type Db = any;
type Job = { id: string; attempts: number };
type Doc = {
  id: string; tenant_id: string; storage_path: string; file_name: string;
  status: string; content_hash: string | null; file_size: number | null;
};

// Rejections that need a specific HTTP status (mapped in the handler).
type FailureCode = "duplicate" | "chunk_budget";

/** Authoritative object size from Storage metadata — never a caller value. */
async function objectSize(db: Db, path: string): Promise<number | null> {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return null;
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await db.storage.from(BUCKET).list(dir, {
    search: name,
    limit: 100,
  });
  if (error) return null;
  const hit = (data ?? []).find((o: { name?: string }) => o.name === name) as
    | { metadata?: { size?: unknown } }
    | undefined;
  const size = hit?.metadata?.size;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

async function failJob(db: Db, jobId: string, docId: string, message: string) {
  const err = message.slice(0, 500);
  await db.from("ingest_jobs").update({ status: "failed", last_error: err }).eq("id", jobId);
  await db.from("documents").update({ status: "failed" }).eq("id", docId);
  return err;
}

/**
 * Fire-and-forget post-parse trigger for the embedding worker.
 *
 * Called only after `processDocument` has durably persisted chunks and
 * finalized the document row — that durable state IS the parse-complete
 * signal, so the worker can safely claim the named job immediately instead of
 * waiting for the next cron tick. Uses the existing server-to-server gate
 * (WORKER_CRON_KEY, project-scoped Edge secret, never browser-visible).
 *
 * Never throws, never delays the ingest response, never changes its outcome:
 * if the trigger is unavailable for any reason, the per-minute cron sweep
 * picks the job up exactly as before.
 */
function triggerEmbedWorker(jobId: string): void {
  const run = async (): Promise<void> => {
    try {
      const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
      const key = Deno.env.get("WORKER_CRON_KEY") ?? "";
      if (!base || !key) return;
      await fetch(`${base}/functions/v1/embed-worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-worker-key": key },
        body: JSON.stringify({ job_id: jobId }),
      });
    } catch {
      // Ignored by contract: the cron sweep is the backstop.
    }
  };
  try {
    const runtime = (globalThis as {
      EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (runtime?.waitUntil) {
      runtime.waitUntil(run());
    } else {
      void run();
    }
  } catch {
    // Ignored by contract: the cron sweep is the backstop.
  }
}

// Shared process pipeline. All failures are recorded on the job + document;
// parse success leaves the job processing and the document pending — 'ready'
// is set only by the embed-worker once embeddings complete.
async function processDocument(db: Db, job: Job, doc: Doc) {
  await db.from("ingest_jobs").update({
    status: "processing",
    attempts: (job.attempts ?? 0) + 1,
    last_error: null,
  }).eq("id", job.id);

  const fail = (msg: string) => failJob(db, job.id, doc.id, msg);

  // 1. Server-side download from the private bucket (caller JWT; RLS applies).
  const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(doc.storage_path);
  if (dlErr || !blob) {
    const e = await fail(`download failed for ${doc.storage_path}: ${dlErr?.message ?? "unknown"}`);
    return { ok: false as const, error: e };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // M-2: server magic-byte gate. Client MIME/extension is spoofable; only
  // the bytes are authoritative. HTML/JS polyglots renamed ".pdf" fail
  // closed here instead of entering the chunk pipeline as trusted evidence.
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x25 || // %
    bytes[1] !== 0x50 || // P
    bytes[2] !== 0x44 || // D
    bytes[3] !== 0x46 || // F
    bytes[4] !== 0x2d // -
  ) {
    const err = await fail(`not a PDF (magic-byte mismatch) in ${doc.storage_path}`);
    return { ok: false as const, error: err };
  }

  // 2. Parse (page-preserving).
  let pages: string[];
  let totalPages: number;
  try {
    const res = await extractText(bytes, { mergePages: false });
    pages = Array.isArray(res.text) ? res.text : [res.text];
    totalPages = res.totalPages ?? pages.length;
  } catch (e) {
    const err = await fail(`PDF parse failed for ${doc.storage_path}: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false as const, error: err };
  }
  const fullText = pages.join("\n");
  if (!pages.length || fullText.trim().length === 0) {
    const err = await fail(`no extractable text in ${doc.storage_path} (scanned/image-only PDFs need OCR, not enabled)`);
    return { ok: false as const, error: err };
  }
  // M-2: resource bounds before chunking in memory. Checked here (not just
  // the downstream chunk-count budget) so a crafted many-page or
  // highly-compressible PDF cannot OOM/timeout the Edge parse.
  if (totalPages > MAX_PDF_PAGES) {
    const err = await fail(`too many pages (${totalPages} > ${MAX_PDF_PAGES}) in ${doc.storage_path}`);
    return { ok: false as const, error: err };
  }
  if (fullText.length > MAX_EXTRACTED_CHARS) {
    const err = await fail(`extracted text too large (${fullText.length} > ${MAX_EXTRACTED_CHARS}) in ${doc.storage_path}`);
    return { ok: false as const, error: err };
  }

  // 3. Chunk per page with provenance. IDs bind pipeline tag + tenant + path
  // + page + content, so re-runs and retries address identical rows.
  const contentHash = await sha256Hex(fullText.replace(/\s+/g, " ").trim());

  // 3b. Duplicate policy (deterministic). Identity is the extracted-content
  // hash, not the path or file name, so the same source uploaded twice under
  // different names cannot become two RAG documents. Only ACTIVE duplicates
  // block; a failed duplicate row never prevents a retry.
  const { data: dup, error: dupErr } = await db.from("documents")
    .select("id, file_name, status")
    .eq("tenant_id", doc.tenant_id)
    .eq("content_hash", contentHash)
    .neq("id", doc.id)
    .in("status", ["pending", "ready"])
    .limit(1);
  if (dupErr) {
    const err = await fail(`duplicate check failed for ${doc.storage_path}: ${dupErr.message}`);
    return { ok: false as const, error: err };
  }
  if (dup && dup.length > 0) {
    const other = dup[0] as { file_name: string };
    const err = await fail(
      `duplicate of ${other.file_name}: identical content is already indexed in this workspace`,
    );
    return { ok: false as const, error: err, code: "duplicate" as FailureCode };
  }

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) continue;
    for (const c of chunkText(page, CHUNK_SIZE, CHUNK_OVERLAP)) {
      const chunkId = await sha256Hex(
        `${PIPELINE_TAG}|${doc.tenant_id}|${doc.storage_path}|${i + 1}|${c}`,
      );
      rows.push({
        chunk_id: chunkId,
        tenant_id: doc.tenant_id,
        document_id: doc.id,
        file_name: doc.file_name,
        page: i + 1,
        content: c,
        embedding: null,
      });
    }
  }
  if (!rows.length) {
    const err = await fail(`chunking produced zero chunks for ${doc.storage_path}`);
    return { ok: false as const, error: err };
  }

  // 4. Idempotent fast path: same content already ready => verified no-op.
  if (doc.status === "ready" && doc.content_hash === contentHash) {
    const { count } = await db.from("chunks")
      .select("chunk_id", { count: "exact", head: true })
      .eq("document_id", doc.id);
    await db.from("ingest_jobs").update({ status: "succeeded", last_error: null }).eq("id", job.id);
    return {
      ok: true as const, idempotent: true, document_id: doc.id, job_id: job.id,
      chunks: count ?? 0, inserted: 0, removed_stale: 0,
    };
  }

  // 4b. Workspace chunk budget — authoritative count checked immediately
  // before persistence. This document's own chunks are excluded (a re-ingest
  // replaces them rather than adding to them).
  const { count: otherChunks, error: cbErr } = await db.from("chunks")
    .select("chunk_id", { count: "exact", head: true })
    .eq("tenant_id", doc.tenant_id)
    .neq("document_id", doc.id);
  if (cbErr) {
    const err = await fail(`chunk budget check failed for ${doc.storage_path}: ${cbErr.message}`);
    return { ok: false as const, error: err };
  }
  const tenantChunks = otherChunks ?? 0;
  if (tenantChunks + rows.length > MAX_TENANT_CHUNKS) {
    const err = await fail(
      `workspace chunk budget exceeded: ${tenantChunks} existing + ${rows.length} new > ${MAX_TENANT_CHUNKS}`,
    );
    return { ok: false as const, error: err, code: "chunk_budget" as FailureCode };
  }

  // 5. Insert (conflict-safe) then delete stale IDs outside the new set, so
  // retries and crashes converge instead of duplicating or leaking.
  let attempted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const { error } = await db.from("chunks").upsert(batch, {
      onConflict: "chunk_id",
      ignoreDuplicates: true,
    });
    if (error) {
      const err = await fail(`chunk persist failed for ${doc.storage_path}: ${error.message}`);
      return { ok: false as const, error: err };
    }
    attempted += batch.length;
  }
  const newIds = new Set(rows.map((r) => r.chunk_id as string));
  const { data: existing, error: listErr } = await db.from("chunks")
    .select("chunk_id").eq("document_id", doc.id);
  if (listErr) {
    const err = await fail(`chunk verify failed for ${doc.storage_path}: ${listErr.message}`);
    return { ok: false as const, error: err };
  }
  const stale = (existing ?? []).map((r: { chunk_id: string }) => r.chunk_id).filter((id: string) => !newIds.has(id));
  let removedStale = 0;
  if (stale.length) {
    const { error, count } = await db.from("chunks")
      .delete({ count: "exact" })
      .eq("document_id", doc.id)
      .in("chunk_id", stale);
    if (error) {
      const err = await fail(`stale chunk cleanup failed for ${doc.storage_path}: ${error.message}`);
      return { ok: false as const, error: err };
    }
    removedStale = count ?? 0;
  }

  // 6. Parse complete — but NOT ready: embeddings are still pending. The
  // document stays pending and the job stays processing; the embed-worker
  // (Cron-driven) marks both succeeded/ready once no NULL embeddings remain.
  const { error: docErr } = await db.from("documents").update({
    page_count: totalPages,
    content_hash: contentHash,
    embedding_model: PIPELINE_TAG,
    status: "pending",
  }).eq("id", doc.id);
  if (docErr) {
    const err = await fail(`document finalize failed for ${doc.storage_path}: ${docErr.message}`);
    return { ok: false as const, error: err };
  }
  await db.from("ingest_jobs").update({ status: "processing", last_error: null }).eq("id", job.id);
  return {
    ok: true as const, idempotent: false, document_id: doc.id, job_id: job.id,
    chunks: rows.length, inserted_attempted: attempted, removed_stale: removedStale,
    page_count: totalPages, content_hash: contentHash, embedding_pending: true,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
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
  const action = body.action;

  async function requireMember(tenantId: string): Promise<boolean> {
    const { data } = await db.from("memberships")
      .select("tenant_id")
      .eq("tenant_id", tenantId)
      .eq("user_id", caller)
      .limit(1);
    return !!data && data.length > 0;
  }
  function tenantPathOk(tenantId: string, p: string): boolean {
    return p.startsWith(`tenants/${tenantId}/`) && p.endsWith(".pdf") && !p.includes("..");
  }
  const log = (extra: Record<string, unknown>) =>
    console.log(JSON.stringify({ fn: "ingest-pdf", action, caller, ...extra }));

  try {
    if (action === "ingest" || action === "ingest-temp") {
      // Temporary chat files (`ingest-temp`) share the entire persistent
      // pipeline below — limits, parsing, chunking, jobs, worker. The only
      // differences: the conversation must exist in this tenant (validated
      // server-side here), and the created row carries the conversation
      // binding plus a 24 h expiry instead of NULL/NULL.
      const temporary = action === "ingest-temp";
      const tenantId = String(body.tenant_id ?? "");
      const storagePath = String(body.storage_path ?? "");
      const fileName = String(body.file_name ?? "document.pdf").slice(0, 200);
      if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
      if (!tenantPathOk(tenantId, storagePath)) {
        return json(400, { ok: false, error: "storage_path must be tenants/<tenant_id>/.../*.pdf" });
      }
      if (!(await requireMember(tenantId))) return json(403, { ok: false, error: "not a member of this tenant" });

      // P0 cost controls (D83): kill switch + minute/daily gate (tenant +
      // user) before Storage/parse/embed-queue spend. No provider call happens
      // in this handler (the worker embeds), so no slot is claimed here —
      // the embed-worker holds the provider slot for the actual Jina calls.
      {
        const blocked = await enforceCostGate(db, tenantId, caller, "ingest-pdf");
        if (blocked) return json(blocked.status, blocked.body);
      }

      let tempConversationId: string | null = null;
      let tempExpiresAtIso: string | null = null;
      if (temporary) {
        tempConversationId = String(body.conversation_id ?? "");
        if (!UUID_RE.test(tempConversationId)) {
          return json(400, { ok: false, error: "invalid conversation_id" });
        }
        const { data: conv, error: convErr } = await db.from("conversations")
          .select("id").eq("id", tempConversationId).eq("tenant_id", tenantId).limit(1);
        if (convErr) {
          console.error(JSON.stringify({ scope: "db-error", context: "conversation read failed", code: convErr.code, detail: convErr.message.slice(0, 200) }));
          return json(500, { ok: false, error: "conversation read failed" });
        }
        if (!conv || conv.length === 0) {
          return json(404, { ok: false, error: "conversation not found" });
        }
        tempExpiresAtIso = tempExpiresAt(Date.now());
      }

      // B3 — ingestion concurrency: at most 1 active + 3 pending jobs.
      const { count: processingJobs } = await db.from("ingest_jobs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).eq("status", "processing");
      const { count: pendingJobs } = await db.from("ingest_jobs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).eq("status", "pending");
      if ((processingJobs ?? 0) >= MAX_PROCESSING_JOBS || (pendingJobs ?? 0) >= MAX_PENDING_JOBS) {
        return json(409, {
          ok: false,
          error: `workspace is already ingesting (${processingJobs ?? 0} active, ${pendingJobs ?? 0} pending); wait for it to finish`,
        });
      }

      // B3 — authoritative file size from Storage metadata (never the caller's).
      const size = await objectSize(db, storagePath);
      if (size === null) {
        return json(400, { ok: false, error: "could not determine the uploaded file size" });
      }
      if (size > MAX_FILE_BYTES) {
        return json(413, {
          ok: false,
          error: `file is ${(size / (1024 * 1024)).toFixed(1)} MB; the limit is 25 MB`,
        });
      }

      let doc: Doc | null = null;
      {
        const { data, error } = await db.from("documents")
          .select("id, tenant_id, storage_path, file_name, status, content_hash, file_size, expires_at")
          .eq("tenant_id", tenantId)
          .eq("storage_path", storagePath)
          .limit(1);
        if (error) {
          console.error(JSON.stringify({ scope: "db-error", context: "document read failed", code: error.code, detail: error.message.slice(0, 200) }));
          return json(500, { ok: false, error: "document read failed" });
        }
        doc = (data?.[0] as Doc) ?? null;
      }
      if (temporary && doc && (doc as Doc & { expires_at: string | null }).expires_at === null) {
        // Temporary and persistent rows never mix: an already-persistent path
        // keeps its scope; re-upload under a fresh path for a temporary copy.
        return json(400, { ok: false, error: "storage path is already registered as a persistent document" });
      }

      // B3 — document count (new documents only) and storage budget.
      if (!doc) {
        const { count: activeDocs } = await db.from("documents")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .in("status", ["pending", "ready"]);
        if ((activeDocs ?? 0) >= MAX_TENANT_DOCUMENTS) {
          return json(409, {
            ok: false,
            error: `workspace document limit reached (${MAX_TENANT_DOCUMENTS})`,
          });
        }
      }
      {
        const { data: sizeRows, error: sizeErr } = await db.from("documents")
          .select("file_size")
          .eq("tenant_id", tenantId);
        if (sizeErr) {
          console.error(JSON.stringify({ scope: "db-error", context: "storage budget read failed", code: sizeErr.code, detail: sizeErr.message.slice(0, 200) }));
          return json(500, { ok: false, error: "storage budget read failed" });
        }
        const usedBytes = (sizeRows ?? []).reduce(
          (sum: number, row: { file_size?: number | null }) => sum + (row.file_size ?? 0),
          0,
        );
        const projected = usedBytes - (doc?.file_size ?? 0) + size;
        if (projected > MAX_TENANT_STORAGE_BYTES) {
          return json(507, {
            ok: false,
            error: `workspace storage budget exceeded: ${(projected / (1024 * 1024)).toFixed(0)} MB of ${MAX_TENANT_STORAGE_BYTES / (1024 * 1024)} MB`,
          });
        }
      }
      if (doc && doc.file_size !== size) {
        // Re-ingest of the same object: keep the authoritative size current.
        await db.from("documents").update({ file_size: size }).eq("id", doc.id);
      }
      if (!doc) {
        const { data, error } = await db.from("documents").insert({
          tenant_id: tenantId,
          file_name: fileName,
          storage_path: storagePath,
          status: "pending",
          file_size: size,
          created_by: caller,
          conversation_id: tempConversationId,
          expires_at: tempExpiresAtIso,
        }).select("id, tenant_id, storage_path, file_name, status, content_hash, file_size").single();
        if (error && (error as { code?: string }).code === "23505") {
          // Lost a registration race: re-read the winner's row and continue.
          const { data: raced, error: reErr } = await db.from("documents")
            .select("id, tenant_id, storage_path, file_name, status, content_hash, file_size")
            .eq("tenant_id", tenantId)
            .eq("storage_path", storagePath)
            .limit(1);
          if (reErr || !raced?.[0]) {
            console.error(JSON.stringify({ scope: "db-error", context: "document register race unresolved" }));
            return json(500, { ok: false, error: "document register failed" });
          }
          doc = raced[0] as Doc;
        } else if (error || !data) {
          console.error(JSON.stringify({ scope: "db-error", context: "document register failed", code: (error as { code?: string } | null)?.code ?? null }));
          return json(500, { ok: false, error: "document register failed" });
        } else {
          doc = data as Doc;
        }
      }
      const { data: job, error: jobErr } = await db.from("ingest_jobs").insert({
        tenant_id: tenantId,
        document_id: (doc as Doc).id,
        status: "pending",
      }).select("id, attempts").single();
      if (jobErr || !job) {
        console.error(JSON.stringify({ scope: "db-error", context: "job create failed", code: (jobErr as { code?: string } | null)?.code ?? null }));
        return json(500, { ok: false, error: "job create failed" });
      }

      const result = await processDocument(db, job as Job, doc as Doc);
      log({ tenant_id: tenantId, document_id: (doc as Doc).id, job_id: (job as Job).id, ok: result.ok });
      if (!result.ok && "code" in result) return json(409, result);
      if (result.ok && !result.idempotent) {
        // Parse-complete state is durable: start embedding without waiting
        // for the next cron tick. Fire-and-forget — never affects this
        // response, and the cron sweep recovers if the trigger is lost.
        // (Already-ready no-ops need no trigger: nothing is left to embed.)
        triggerEmbedWorker((job as Job).id);
      }
      return json(result.ok ? 200 : 500, result);
    }

    if (action === "retry") {
      const jobId = String(body.job_id ?? "");
      if (!UUID_RE.test(jobId)) return json(400, { ok: false, error: "invalid job_id" });
      const { data: job, error: jobErr } = await db.from("ingest_jobs")
        .select("id, tenant_id, document_id, attempts").eq("id", jobId).single();
      if (jobErr || !job) return json(404, { ok: false, error: "job not found" });
      const { data: doc, error: docErr } = await db.from("documents")
        .select("id, tenant_id, storage_path, file_name, status, content_hash, file_size")
        .eq("id", (job as { document_id: string }).document_id).single();
      if (docErr || !doc) return json(404, { ok: false, error: "document not found" });
      if (!(await requireMember((doc as Doc).tenant_id))) {
        return json(403, { ok: false, error: "not a member of this tenant" });
      }
      const result = await processDocument(db, job as Job, doc as Doc);
      log({ job_id: jobId, ok: result.ok });
      if (!result.ok && "code" in result) return json(409, result);
      if (result.ok && !result.idempotent) {
        // Same post-parse trigger as the ingest path: the retry just
        // re-persisted parse-complete state, so embedding can start now.
        triggerEmbedWorker(jobId);
      }
      return json(result.ok ? 200 : 500, result);
    }

    if (action === "promote") {
      // Temporary → persistent promotion. Server-side only: the caller names
      // a document, never the scope values. Membership of the document's
      // tenant is re-checked, and only a row that is actually temporary can
      // be promoted. Clearing both columns makes it an ordinary persistent
      // document in place — storage, chunks and embeddings are preserved, no
      // second copy is created. (Attaching it to a Space afterwards uses the
      // existing source-attach flow.)
      // M-5: promotion widens a conversation file to the whole workspace, so
      // only the uploader or a workspace manager may promote. Any-member
      // promotion let one member persist another's private temp file.
      const documentId = String(body.document_id ?? "");
      if (!UUID_RE.test(documentId)) return json(400, { ok: false, error: "invalid document_id" });
      const { data: doc, error: docErr } = await db.from("documents")
        .select("id, tenant_id, expires_at, conversation_id, created_by").eq("id", documentId).single();
      if (docErr || !doc) return json(404, { ok: false, error: "document not found" });
      const d = doc as { id: string; tenant_id: string; expires_at: string | null; created_by: string | null };
      const { data: prow } = await db.from("memberships")
        .select("role").eq("tenant_id", d.tenant_id).eq("user_id", caller).limit(1);
      const prole = (prow?.[0] as { role?: string } | undefined)?.role;
      if (!prow || prow.length === 0) {
        return json(403, { ok: false, error: "not a member of this tenant" });
      }
      if (d.created_by !== caller && prole !== "owner" && prole !== "admin") {
        return json(403, { ok: false, error: "only the uploader or a workspace manager can save this file" });
      }
      if (d.expires_at === null) {
        return json(400, { ok: false, error: "not a temporary document" });
      }
      // M-5: cap TTL abuse at promotion time — an expired temp cannot be
      // promoted back to life; re-upload instead.
      const { data: fresh } = await db.from("documents")
        .select("expires_at").eq("id", d.id).single();
      const freshExp = (fresh as { expires_at: string | null } | null)?.expires_at ?? null;
      if (freshExp !== null && Date.parse(freshExp) <= Date.now()) {
        return json(400, { ok: false, error: "temporary file has expired" });
      }
      const { error: promoteErr } = await db.from("documents")
        .update({ expires_at: null, conversation_id: null })
        .eq("id", d.id);
      if (promoteErr) {
        console.error(JSON.stringify({ scope: "db-error", context: "promote failed", code: promoteErr.code }));
        return json(500, { ok: false, error: "promote failed" });
      }
      log({ action: "promote", document_id: d.id, ok: true });
      return json(200, { ok: true, document_id: d.id });
    }

    if (action === "delete-document") {
      const documentId = String(body.document_id ?? "");
      if (!UUID_RE.test(documentId)) return json(400, { ok: false, error: "invalid document_id" });
      const { data: doc, error: docErr } = await db.from("documents")
        .select("id, tenant_id, storage_path, created_by").eq("id", documentId).single();
      if (docErr || !doc) return json(404, { ok: false, error: "document not found" });
      const d = doc as { id: string; tenant_id: string; storage_path: string; created_by: string | null };
      // H-3/M-12: deletion destroys shared corpus + Storage originals.
      // Only the uploader or a workspace manager may delete; any-member
      // delete let one member wipe another's documents.
      const { data: drow } = await db.from("memberships")
        .select("role").eq("tenant_id", d.tenant_id).eq("user_id", caller).limit(1);
      const drole = (drow?.[0] as { role?: string } | undefined)?.role;
      if (!drow || drow.length === 0) {
        return json(403, { ok: false, error: "not a member of this tenant" });
      }
      if (d.created_by !== caller && drole !== "owner" && drole !== "admin") {
        return json(403, { ok: false, error: "only the uploader or a workspace manager can delete this file" });
      }
      const { count: chunkCount } = await db.from("chunks")
        .select("chunk_id", { count: "exact", head: true }).eq("document_id", d.id);
      const { error: delErr } = await db.from("documents").delete().eq("id", d.id);
      if (delErr) {
        console.error(JSON.stringify({ scope: "db-error", context: "document delete failed", code: delErr.code }));
        return json(500, { ok: false, error: "document delete failed" });
      }
      let objectRemoved = false;
      const { error: objErr } = await db.storage.from(BUCKET).remove([d.storage_path]);
      objectRemoved = !objErr;
      await db.from("ingest_jobs").delete().eq("document_id", d.id);
      log({ document_id: d.id, chunks_removed: chunkCount ?? 0, object_removed: objectRemoved });
      return json(200, {
        ok: true, document_id: d.id,
        chunks_removed: chunkCount ?? 0, object_removed: objectRemoved,
      });
    }

    return json(400, { ok: false, error: "unknown action (ingest|ingest-temp|retry|promote|delete-document)" });
  } catch (e) {
    // M-9: static envelope for direct callers; detail stays server-side.
    console.error(JSON.stringify({ scope: "internal", fn: "ingest-pdf", detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) }));
    return json(500, { ok: false, error: "internal error" });
  }
});
