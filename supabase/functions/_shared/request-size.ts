// request-size.ts — early oversized-request rejection (anonymous-abuse hardening).
//
// The unauthenticated-flood audit established that unauthenticated requests
// cannot reach Postgres data, Storage objects, retrieval, or any provider
// path — every function rejects at `auth.getUser` first. The remaining
// accepted risk is anonymous request-volume against Edge/Auth infrastructure.
// This helper bounds ingress bytes per request with zero backend work: it
// reads one header, never parses the body, never queries the DB, never calls
// a provider, and never writes a counter.
//
// Contract:
// - Missing Content-Length remains allowed (chunked/streamed callers).
// - Unparsable or negative values remain allowed (fail open toward
//   availability; the per-endpoint validation still bounds real bodies).
// - Rejects only when Content-Length is present and > 64 KB.
// - Legitimate bodies are ~2 KB (ask/query ≤1000 chars + UUIDs); the largest
//   legitimate shape (benchmark-answer, 20 evidence items of ~1000-char
//   chunks) stays near ~25 KB — well under the ceiling.

export const MAX_REQUEST_BYTES = 64 * 1024;

export function requestTooLarge(req: Request): boolean {
  const raw = req.headers.get("content-length");
  if (raw === null || raw.trim() === "") return false;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return false;
  return n > MAX_REQUEST_BYTES;
}
