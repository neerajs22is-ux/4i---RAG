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
// - documents.status reaches 'ready' ONLY after chunks persist with content.
// - Updates (changed content_hash) replace the chunk set; deletes cascade.
// - Logs metadata only (ids, counts, sizes, hashes). Never content/secrets.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText } from "npm:unpdf@1.8.1";

const BUCKET = "company-documents";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const PIPELINE_TAG = "none-v1";
const INSERT_BATCH = 100;

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
  status: string; content_hash: string | null;
};

async function failJob(db: Db, jobId: string, docId: string, message: string) {
  const err = message.slice(0, 500);
  await db.from("ingest_jobs").update({ status: "failed", last_error: err }).eq("id", jobId);
  await db.from("documents").update({ status: "failed" }).eq("id", docId);
  return err;
}

// Shared process pipeline. All failures are recorded on the job + document;
// 'ready' is set only after chunks persist.
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

  // 3. Chunk per page with provenance. IDs bind pipeline tag + tenant + path
  // + page + content, so re-runs and retries address identical rows.
  const contentHash = await sha256Hex(fullText.replace(/\s+/g, " ").trim());
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

  // 6. Only now mark ready.
  const { error: docErr } = await db.from("documents").update({
    page_count: totalPages,
    content_hash: contentHash,
    embedding_model: PIPELINE_TAG,
    status: "ready",
  }).eq("id", doc.id);
  if (docErr) {
    const err = await fail(`document finalize failed for ${doc.storage_path}: ${docErr.message}`);
    return { ok: false as const, error: err };
  }
  await db.from("ingest_jobs").update({ status: "succeeded", last_error: null }).eq("id", job.id);
  return {
    ok: true as const, idempotent: false, document_id: doc.id, job_id: job.id,
    chunks: rows.length, inserted_attempted: attempted, removed_stale: removedStale,
    page_count: totalPages, content_hash: contentHash,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

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
    if (action === "ingest") {
      const tenantId = String(body.tenant_id ?? "");
      const storagePath = String(body.storage_path ?? "");
      const fileName = String(body.file_name ?? "document.pdf").slice(0, 200);
      if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
      if (!tenantPathOk(tenantId, storagePath)) {
        return json(400, { ok: false, error: "storage_path must be tenants/<tenant_id>/.../*.pdf" });
      }
      if (!(await requireMember(tenantId))) return json(403, { ok: false, error: "not a member of this tenant" });

      let doc: Doc | null = null;
      {
        const { data, error } = await db.from("documents")
          .select("id, tenant_id, storage_path, file_name, status, content_hash")
          .eq("tenant_id", tenantId)
          .eq("storage_path", storagePath)
          .limit(1);
        if (error) return json(500, { ok: false, error: error.message });
        doc = (data?.[0] as Doc) ?? null;
      }
      if (!doc) {
        const { data, error } = await db.from("documents").insert({
          tenant_id: tenantId,
          file_name: fileName,
          storage_path: storagePath,
          status: "pending",
          created_by: caller,
        }).select("id, tenant_id, storage_path, file_name, status, content_hash").single();
        if (error && (error as { code?: string }).code === "23505") {
          // Lost a registration race: re-read the winner's row and continue.
          const { data: raced, error: reErr } = await db.from("documents")
            .select("id, tenant_id, storage_path, file_name, status, content_hash")
            .eq("tenant_id", tenantId)
            .eq("storage_path", storagePath)
            .limit(1);
          if (reErr || !raced?.[0]) return json(500, { ok: false, error: "document register race unresolved" });
          doc = raced[0] as Doc;
        } else if (error || !data) {
          return json(500, { ok: false, error: error?.message ?? "document register failed" });
        } else {
          doc = data as Doc;
        }
      }
      const { data: job, error: jobErr } = await db.from("ingest_jobs").insert({
        tenant_id: tenantId,
        document_id: (doc as Doc).id,
        status: "pending",
      }).select("id, attempts").single();
      if (jobErr || !job) return json(500, { ok: false, error: jobErr?.message ?? "job create failed" });

      const result = await processDocument(db, job as Job, doc as Doc);
      log({ tenant_id: tenantId, document_id: (doc as Doc).id, job_id: (job as Job).id, ok: result.ok });
      return json(result.ok ? 200 : 500, result);
    }

    if (action === "retry") {
      const jobId = String(body.job_id ?? "");
      if (!UUID_RE.test(jobId)) return json(400, { ok: false, error: "invalid job_id" });
      const { data: job, error: jobErr } = await db.from("ingest_jobs")
        .select("id, tenant_id, document_id, attempts").eq("id", jobId).single();
      if (jobErr || !job) return json(404, { ok: false, error: "job not found" });
      const { data: doc, error: docErr } = await db.from("documents")
        .select("id, tenant_id, storage_path, file_name, status, content_hash")
        .eq("id", (job as { document_id: string }).document_id).single();
      if (docErr || !doc) return json(404, { ok: false, error: "document not found" });
      if (!(await requireMember((doc as Doc).tenant_id))) {
        return json(403, { ok: false, error: "not a member of this tenant" });
      }
      const result = await processDocument(db, job as Job, doc as Doc);
      log({ job_id: jobId, ok: result.ok });
      return json(result.ok ? 200 : 500, result);
    }

    if (action === "delete-document") {
      const documentId = String(body.document_id ?? "");
      if (!UUID_RE.test(documentId)) return json(400, { ok: false, error: "invalid document_id" });
      const { data: doc, error: docErr } = await db.from("documents")
        .select("id, tenant_id, storage_path").eq("id", documentId).single();
      if (docErr || !doc) return json(404, { ok: false, error: "document not found" });
      const d = doc as { id: string; tenant_id: string; storage_path: string };
      if (!(await requireMember(d.tenant_id))) {
        return json(403, { ok: false, error: "not a member of this tenant" });
      }
      const { count: chunkCount } = await db.from("chunks")
        .select("chunk_id", { count: "exact", head: true }).eq("document_id", d.id);
      const { error: delErr } = await db.from("documents").delete().eq("id", d.id);
      if (delErr) return json(500, { ok: false, error: delErr.message });
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

    return json(400, { ok: false, error: "unknown action (ingest|retry|delete-document)" });
  } catch (e) {
    return json(500, { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : "internal error" });
  }
});
