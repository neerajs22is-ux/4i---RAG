import {
  getSupabaseAnonKey,
  getSupabaseClient,
  getSupabaseUrl,
} from "@/lib/supabase/client";
import { ApiError, apiErrorKindForStatus, normalizeApiError } from "@/lib/api/errors";

/**
 * Edge Function transport.
 *
 * One small helper, no framework. Every call:
 *  - attaches the caller's JWT as a Bearer token plus the publishable `apikey`
 *    header (exactly what the Edge Functions expect);
 *  - performs **at most one** session refresh + retry on 401, mirroring the
 *    discipline used by the backend and the evaluation runner — no retry loops;
 *  - converts every failure into a normalised `ApiError` whose message is safe
 *    to render;
 *  - never logs tokens, bodies or provider details.
 *
 * The browser never talks to Mantle or Voyage: all model work stays behind the
 * Edge Functions, which hold those credentials.
 */

type CallOptions = {
  /** Bounded timeout; the ask pipeline can legitimately take ~30s. */
  timeoutMs?: number;
};

/**
 * Our own Edge Functions answer with a bounded `{ ok: false, error }` envelope.
 * That text is our own copy ("file is 26.0 MB; the limit is 25 MB"), so it is
 * shown for the limit/validation statuses. 5xx payloads are never surfaced:
 * they can carry infrastructure detail.
 */
function safeEnvelopeDetail(status: number, payload: unknown): string | null {
  if (status !== 400 && status !== 409 && status !== 413 && status !== 507) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const message = (payload as { error?: unknown }).error;
  return typeof message === "string" && message.trim().length > 0 ? message.slice(0, 200) : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function callFunction<T>(
  name: string,
  body: Record<string, unknown>,
  options: CallOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const supabase = getSupabaseClient();

  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError("auth", { source: name });
  let token = data.session.access_token;

  const endpoint = `${getSupabaseUrl()}/functions/v1/${name}`;

  const attempt = async (): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: getSupabaseAnonKey(),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res: Response;
  try {
    res = await attempt();
  } catch (error) {
    throw normalizeApiError(error, name);
  }

  // Exactly one refresh + retry when the token was rejected.
  if (res.status === 401) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (!refreshed.session) throw new ApiError("auth", { source: name });
    token = refreshed.session.access_token;
    try {
      res = await attempt();
    } catch (error) {
      throw normalizeApiError(error, name);
    }
  }

  const payload = await readJson(res);

  if (!res.ok) {
    throw new ApiError(apiErrorKindForStatus(res.status), {
      status: res.status,
      source: name,
      cause: payload,
      detail: safeEnvelopeDetail(res.status, payload),
    });
  }

  return payload as T;
}

/* ------------------------------------------------------------------- /ask */

import type { AskResponse, QueryChunksResponse } from "@/lib/api/types";

export type AskInput = {
  tenantId: string;
  query: string;
  conversationId?: string | null;
  /**
   * Notebook scope. When present the backend resolves the notebook's selected,
   * non-archived documents and retrieves only from those; the browser never
   * passes a document list of its own.
   */
  notebookId?: string | null;
};

/** Ask a grounded question. Returns the full documented response contract. */
export function ask(
  { tenantId, query, conversationId, notebookId }: AskInput,
  options?: CallOptions,
): Promise<AskResponse> {
  return callFunction<AskResponse>(
    "ask",
    {
      tenant_id: tenantId,
      query,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(notebookId ? { notebook_id: notebookId } : {}),
    },
    options,
  );
}

export type QueryChunksInput = {
  tenantId: string;
  query: string;
  /** Optional retrieval overrides; defaults live on the backend. */
  finalK?: number;
  /** Optional notebook scope, resolved server-side (see `AskInput.notebookId`). */
  notebookId?: string | null;
};

/**
 * Retrieve evidence only (no generation). Useful for the evidence workspace
 * and for inspecting what retrieval returned for a question.
 */
export function queryChunks(
  { tenantId, query, finalK, notebookId }: QueryChunksInput,
  options?: CallOptions,
): Promise<QueryChunksResponse> {
  return callFunction<QueryChunksResponse>(
    "query-chunks",
    {
      tenant_id: tenantId,
      query,
      ...(finalK ? { final_k: finalK } : {}),
      ...(notebookId ? { notebook_id: notebookId } : {}),
    },
    options,
  );
}
