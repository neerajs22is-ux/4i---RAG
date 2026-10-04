// safe-error.ts — M-9: bounded, non-disclosing error responses.
//
// Database, Storage, and provider failures carry schema, RLS, column, and
// infrastructure detail. Returning `.message` lets a caller fingerprint the
// schema ("permission denied for table X", "column Y does not exist").
// Every failure below returns a static code to the browser and logs the
// detail server-side (metadata only — never keys, tokens, vectors, content).

export function safeDbError(
  context: string,
  error: { message?: string; code?: string } | null | undefined,
): { code: string; logDetail: string } {
  const detail = String(error?.message ?? "unknown").slice(0, 200);
  const code = String(error?.code ?? "");
  // Log server-side for operators; the caller only sees `context`.
  console.error(JSON.stringify({ scope: "db-error", context, code, detail }));
  return { code: context, logDetail: detail };
}

/** Static envelope for unexpected failures. Logs detail, returns generic. */
export function safeInternal(
  fn: string,
  error: unknown,
): { error: string } {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  console.error(JSON.stringify({ scope: "internal", fn, detail }));
  return { error: "internal error" };
}
