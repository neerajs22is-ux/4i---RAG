/** Small formatting helpers — no date library needed for these. */

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "just now";
  if (diff < hour) {
    const m = Math.round(diff / minute);
    return `${m}m ago`;
  }
  if (diff < day) {
    const h = Math.round(diff / hour);
    return `${h}h ago`;
  }
  if (diff < 7 * day) {
    const d = Math.round(diff / day);
    return `${d}d ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * "23h" / "45m" / "less than a minute" until a timestamp, measured against
 * `nowMs`. Pure on purpose: callers pass the current time so render code never
 * calls `Date.now()` itself.
 */
export function timeUntil(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = then - nowMs;
  if (diff <= 0) return "now";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "less than a minute";
  if (diff < hour) return `${Math.round(diff / minute)}m`;
  if (diff < day) return `${Math.round(diff / hour)}h`;
  return `${Math.round(diff / day)}d`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** 1234 → "1.2k". Used for counts (pages, chunks), never for money or metrics. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
