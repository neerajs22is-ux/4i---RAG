import { getSupabaseAnonKey, getSupabaseClient, getSupabaseUrl } from "@/lib/supabase/client";
import { ApiError } from "@/lib/api/errors";

/**
 * Upload a PDF into the tenant's Storage prefix.
 *
 * This is the one place the browser writes bytes. It uses XMLHttpRequest rather
 * than `fetch` for a single reason: it exposes **real** upload progress
 * (`upload.onprogress`). Nothing here invents a percentage — when the browser
 * cannot report progress, `onProgress` is simply never called and the UI shows
 * an honest indeterminate state.
 *
 * Limits are validated here for early feedback only. The bucket's own
 * file-size limit (25 MiB) and `ingest-pdf`'s checks are authoritative.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const BUCKET = "company-documents";

export type UploadProgress = { loaded: number; total: number };

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Readable size for messages: "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Storage key: `tenants/<tenant>/docs/<uuid>/<safe-name>.pdf`.
 *
 * The folder-per-document shape matches what `ingest-pdf` expects
 * (`tenants/<tenant>/…*.pdf`, no `..`), and the generated folder keeps two
 * files with the same name from colliding.
 */
export function buildStoragePath(tenantId: string, fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "document.pdf";
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const withExt = safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
  const folder = crypto.randomUUID();
  return `tenants/${tenantId}/docs/${folder}/${withExt}`;
}

export type UploadedDocument = {
  storagePath: string;
  fileName: string;
  bytes: number;
};

export async function uploadDocument({
  tenantId,
  file,
  onProgress,
  signal,
}: {
  tenantId: string;
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<UploadedDocument> {
  if (!isPdf(file)) {
    throw new ApiError("validation", { source: "storage", detail: "Only PDF files are supported." });
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ApiError("validation", {
      source: "storage",
      detail: `${formatBytes(file.size)} — the limit is ${formatBytes(MAX_FILE_BYTES)}.`,
    });
  }

  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError("auth", { source: "storage" });

  const storagePath = buildStoragePath(tenantId, file.name);
  const endpoint = `${getSupabaseUrl()}/storage/v1/object/${BUCKET}/${storagePath}`;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint, true);
    xhr.setRequestHeader("apikey", getSupabaseAnonKey());
    xhr.setRequestHeader("Authorization", `Bearer ${data.session.access_token}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/pdf");
    // Never overwrite: the generated folder makes this a new object anyway.
    xhr.setRequestHeader("x-upsert", "false");

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress({ loaded: event.loaded, total: event.total });
        }
      };
    }

    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });

    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(storageError(xhr));
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new ApiError("network", { source: "storage" }));
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new ApiError("validation", { source: "storage", detail: "Upload cancelled." }));
    };
    xhr.send(file);
  });

  return { storagePath, fileName: file.name, bytes: file.size };
}

/**
 * Translate a Storage API failure into the app's error vocabulary.
 *
 * Storage returns `{ statusCode, error, message }`; those messages are our own
 * platform's, bounded and safe to show ("The object exceeded the maximum
 * allowed size"). Anything unrecognised stays generic.
 */
function storageError(xhr: XMLHttpRequest): ApiError {
  let message: string | null = null;
  let inner: string | number | null = null;
  try {
    const body = JSON.parse(xhr.responseText) as { statusCode?: string | number; message?: string };
    inner = body.statusCode ?? null;
    message = typeof body.message === "string" ? body.message.slice(0, 200) : null;
  } catch {
    message = null;
  }
  const status = Number(inner) || xhr.status;
  const kind = status === 413 || status === 400 ? "validation" : status === 403 ? "authorization" : status === 401 ? "auth" : "backend";
  return new ApiError(kind, {
    status,
    source: "storage",
    detail: kind === "validation" ? message : null,
  });
}
