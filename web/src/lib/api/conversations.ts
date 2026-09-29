import { ApiError, normalizePostgrestError } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  ConversationRow,
  MembershipRow,
  MessageRow,
} from "@/lib/api/types";

/**
 * Conversation and membership reads.
 *
 * These go straight to PostgREST with the caller's session: Row Level Security
 * is the authorization boundary, so the client cannot widen its own access.
 * `/ask` owns turning a question into stored messages; it also creates the
 * conversation itself when none is given.
 */

/** Workspaces (tenants) the signed-in user belongs to, with display names. */
export async function listMemberships(userId: string): Promise<MembershipRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("memberships")
    .select("tenant_id, role, tenants(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  const normalized = normalizePostgrestError(error, "memberships");
  if (normalized) throw normalized;
  return (data ?? []) as MembershipRow[];
}

/**
 * Create a conversation.
 *
 * This is the one conversation write the browser performs, and only for the
 * temporary-file attach flow (D60): a temporary file is bound to a
 * conversation that must already exist, and attaching one can happen before
 * the first question. The row is created under RLS
 * (`conversations_insert_members`), so the browser cannot create one outside
 * its own workspace, and `/ask` appends to it exactly as it does to a
 * conversation it created itself.
 */
export async function createConversation(
  tenantId: string,
  userId: string,
  title: string,
): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .from("conversations")
    .insert({ tenant_id: tenantId, user_id: userId, title: title.slice(0, 80) })
    .select("id")
    .single();

  const normalized = normalizePostgrestError(error, "conversations");
  if (normalized) throw normalized;
  return (data as { id: string }).id;
}

export async function listConversations(
  tenantId: string,
  limit = 50,
): Promise<ConversationRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  const normalized = normalizePostgrestError(error, "conversations");
  if (normalized) throw normalized;
  return (data ?? []) as ConversationRow[];
}

export async function listMessages(
  conversationId: string,
): Promise<MessageRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select("id, conversation_id, role, content, label, sources, model_ids, timings, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const normalized = normalizePostgrestError(error, "messages");
  if (normalized) throw normalized;
  return (data ?? []) as MessageRow[];
}

/**
 * Deleting a conversation is supported by policy, but is not exposed in the UI
 * yet (no confirmation flow). Kept here so the capability is explicit.
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("conversations")
    .delete()
    .eq("id", conversationId);
  const normalized = normalizePostgrestError(error, "conversations");
  if (normalized) throw normalized;
}

/**
 * Message edit support (linear edit + truncate + regenerate).
 *
 * The schema keeps no history: messages are plain linear rows ordered by
 * `created_at`, and RLS permits member update/delete (`messages_update_members`,
 * `messages_delete_members` — "append-mostly by convention", corrections
 * allowed). These two helpers are the only message mutations the browser
 * performs for editing; `/ask` itself still owns appending new rows.
 *
 * Both scope every write by `tenant_id` in addition to the row id, so a
 * caller can never touch another workspace's rows even if an id were guessed.
 */

/** Replace a user message's content in place (position and timestamps kept). */
export async function updateMessageContent(
  tenantId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("messages")
    .update({ content })
    .eq("id", messageId)
    .eq("tenant_id", tenantId);
  const normalized = normalizePostgrestError(error, "messages");
  if (normalized) throw normalized;
}

/**
 * Remove an explicit set of message rows (the stale tail after an edit).
 * Takes row ids — resolved from a fresh `listMessages` read — rather than a
 * timestamp window, so rapid successive writes can never over-delete. An
 * empty list is a no-op (PostgREST rejects empty `.in()` filters).
 */
export async function deleteMessagesByIds(
  tenantId: string,
  conversationId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const { error } = await getSupabaseClient()
    .from("messages")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("tenant_id", tenantId)
    .in("id", messageIds);
  const normalized = normalizePostgrestError(error, "messages");
  if (normalized) throw normalized;
}

export { ApiError };
