"use client";

import { compactNumber } from "@/lib/format";

/**
 * Truthful embedding progress for one pending document.
 *
 * Both numbers are live backend state (`total` = parsed chunks,
 * `pending` = chunks still awaiting embeddings); the percentage is derived,
 * never animated. `total === 0` means the pipeline has not parsed anything
 * yet, so the row honestly says Parsing instead of 0 / 0.
 */
export function DocumentProgress({
  fileName,
  total,
  pending,
}: {
  fileName: string;
  /** Null while the counts have not loaded (or a count read failed). */
  total: number | null;
  /** Null while the counts have not loaded (or a count read failed). */
  pending: number | null;
}) {
  if (total === null || pending === null) {
    return (
      <>
        <span>Processing</span>
        <div
          className="bg-muted shimmer mt-1.5 h-0.5 w-full overflow-hidden rounded-full"
          aria-hidden="true"
        />
      </>
    );
  }
  if (total === 0) {
    return (
      <>
        <span>Parsing…</span>
        <div
          className="bg-muted shimmer mt-1.5 h-0.5 w-full overflow-hidden rounded-full"
          aria-hidden="true"
        />
      </>
    );
  }
  const done = Math.max(0, Math.min(total, total - pending));
  const percent = Math.round((done / total) * 100);
  return (
    <>
      <span>
        {`Processing · ${compactNumber(done)} / ${compactNumber(total)} chunks`}
      </span>
      <div
        className="bg-muted mt-1.5 h-0.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`Embedding progress for ${fileName}`}
      >
        <div
          className="bg-primary h-full transition-[width] duration-[var(--duration-fast)]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-muted-foreground/70 mt-1 block text-2xs">
        Generating embeddings
      </span>
    </>
  );
}
