// edit-message — H-1/L-5: server-authorized linear edit + truncate.
//
// The browser previously performed message edits as two direct PostgREST
// calls (UPDATE content, DELETE tail) authorized only by tenant membership:
// any member could rewrite or wipe any conversation. This function is now
// the only supported edit path:
//
//   caller JWT -> auth.getUser -> membership -> rate limit ->
//   public.edit_message RPC (ownership + atomic update+truncate in one
//   transaction) -> 200 with edited_id.
//
// Ownership: conversation author or workspace manager (owner/admin).
// Only role='user' rows may be rewritten; assistant answers are replaced by
// regeneration (/ask), never edited in place. Content is 1..1000 chars
// (matches /ask). Delete set must belong to the same conversation/tenant
// and never includes the edited row itself (enforced in the RPC).
// Errors are static codes (M-9); detail stays server-side in logs.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { enforceCostGate } from "../_shared/cost-control.ts";
import { requestTooLarge } from "../_shared/request-size.ts";

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
  const tenantId = String(body.tenant_id ?? "");
  const conversationId = String(body.conversation_id ?? "");
  const messageId = String(body.message_id ?? "");
  const content = String(body.content ?? "");
  const deleteIds = Array.isArray(body.delete_ids)
    ? (body.delete_ids as unknown[]).map(String)
    : [];
  if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
  if (!UUID_RE.test(conversationId)) return json(400, { ok: false, error: "invalid conversation_id" });
  if (!UUID_RE.test(messageId)) return json(400, { ok: false, error: "invalid message_id" });
  if (!content.trim() || content.length > 1000) {
    return json(400, { ok: false, error: "invalid content" });
  }
  if (deleteIds.length > 100) return json(400, { ok: false, error: "delete set too large" });
  if (deleteIds.some((id) => !UUID_RE.test(id))) {
    return json(400, { ok: false, error: "invalid delete_ids" });
  }

  // P0 (D83): throttle edit bursts per tenant+user. No provider call happens
  // in this handler (no kill switch, no slot); the client-side regeneration
  // goes through /ask and is gated there.
  {
    const blocked = await enforceCostGate(db, tenantId, caller, "edit-message");
    if (blocked) return json(blocked.status, blocked.body);
  }

  const { data, error } = await db.rpc("edit_message", {
    p_tenant_id: tenantId,
    p_conversation_id: conversationId,
    p_message_id: messageId,
    p_content: content,
    p_delete_ids: deleteIds,
  });
  if (error) {
    const msg = String(error.message ?? "");
    console.error(JSON.stringify({ scope: "edit-message", code: error.code ?? null }));
    // Ownership/validation failures from the RPC surface as 403/404/400
    // without leaking internals; unexpected failures are static 500.
    if (/only the conversation owner|not a member/i.test(msg)) {
      return json(403, { ok: false, error: "not authorized to edit this conversation" });
    }
    if (/message not found|conversation not found/i.test(msg)) {
      return json(404, { ok: false, error: "message not found" });
    }
    if (/invalid content|only user messages|delete set|too large/i.test(msg)) {
      return json(400, { ok: false, error: "invalid edit request" });
    }
    return json(500, { ok: false, error: "edit failed" });
  }
  const row = (Array.isArray(data) ? data[0] : data) as { edited_id?: string } | null;
  return json(200, { ok: true, edited_id: row?.edited_id ?? messageId });
});
