/**
 * Error normalisation.
 *
 * Everything the frontend can fail at — Supabase auth, Edge Function calls,
 * PostgREST queries, the network — is reduced to a small closed set of kinds
 * with a fixed, user-facing message.
 *
 * Hard rules:
 *  - never surface a raw driver message, provider detail, stack trace or
 *    credential to the user;
 *  - keep the structured cause (kind + HTTP status) for diagnostics;
 *  - do not log session tokens (see `lib/api/client.ts`).
 */

export type ApiErrorKind =
  | "auth" // no session, or the session was rejected (401)
  | "authorization" // signed in but not permitted (403, or no workspace)
  | "validation" // the request itself was rejected (400)
  | "not-found" // 404
  | "throttled" // 429 — the answer model is rate-limited
  | "conflict" // 409 — the workspace state does not allow this right now
  | "backend" // 5xx — our side failed
  | "network" // the request never completed
  | "config" // the frontend environment is not configured
  | "unknown";

const MESSAGES: Record<ApiErrorKind, string> = {
  auth: "Your session has ended. Please sign in again.",
  authorization: "You do not have access to this workspace.",
  validation: "That request could not be sent. Check it and try again.",
  "not-found": "That item could not be found.",
  throttled: "The answer service is busy right now. Try again in a moment.",
  conflict: "This workspace is already processing a document. Try again when it finishes.",
  backend: "Something went wrong on our side. Try again.",
  network: "The service could not be reached from your browser. This is a service or network issue, not an account problem.",
  config: "This deployment is not configured yet. Contact your administrator.",
  unknown: "Something unexpected happened. Try again.",
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status when the failure came from a response. */
  readonly status: number | null;
  /** Edge Function name or table involved — safe, no query or payload. */
  readonly source: string | null;
  /**
   * A short message from **our own** Edge Function envelope (limits, duplicate
   * rejection, upload cancellation). Never a driver, provider or stack message:
   * see `safeEnvelopeDetail` in `client.ts`, which only reads our `error`
   * field for our validation/limit statuses.
   */
  readonly detail: string | null;

  constructor(
    kind: ApiErrorKind,
    options: {
      status?: number | null;
      source?: string | null;
      cause?: unknown;
      detail?: string | null;
    } = {},
  ) {
    super(MESSAGES[kind]);
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.source = options.source ?? null;
    this.detail = options.detail ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Message safe to render. Never includes backend text. */
  get userMessage(): string {
    return MESSAGES[this.kind];
  }
}

export function apiErrorKindForStatus(status: number): ApiErrorKind {
  if (status === 400) return "validation";
  if (status === 401) return "auth";
  if (status === 403) return "authorization";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "throttled";
  if (status >= 500) return "backend";
  return "unknown";
}

/** Reduce any thrown value to an ApiError. */
export function normalizeApiError(error: unknown, source?: string): ApiError {
  if (error instanceof ApiError) return error;

  if (typeof error === "object" && error !== null) {
    const e = error as { name?: string; message?: string; status?: number };
    // A failed fetch rejects with TypeError / AbortError in the browser.
    if (e.name === "TypeError" || e.name === "AbortError") {
      return new ApiError("network", { source, cause: error });
    }
    if (typeof e.status === "number") {
      return new ApiError(apiErrorKindForStatus(e.status), {
        status: e.status,
        source,
        cause: error,
      });
    }
  }

  return new ApiError("unknown", { source, cause: error });
}

/** PostgREST returns `{ code, message, details, hint }` for query failures. */
export function normalizePostgrestError(
  error: { code?: string; message?: string } | null,
  source?: string,
): ApiError | null {
  if (!error) return null;
  const code = error.code ?? "";
  if (code === "42501" || code === "PGRST301") {
    return new ApiError("authorization", { source, cause: error });
  }
  if (code === "PGRST116") {
    return new ApiError("not-found", { source, cause: error });
  }
  if (code.startsWith("22") || code.startsWith("23")) {
    return new ApiError("validation", { source, cause: error });
  }
  // 401-ish and everything else → backend. Never surface the message.
  return new ApiError("backend", { source, cause: error });
}
