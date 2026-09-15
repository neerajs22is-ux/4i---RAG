// grounding.ts — deterministic RAG grounding primitives (Phase 3C.1).
//
// Pure functions only: no I/O, no network, no Deno APIs. Shared by the ask
// endpoint and runnable under `deno test`. Ports the proven concepts from
// the reference implementation's evidence_verification (verdicts), answer
// prompts (DIRECT/PARTIAL grounding contract), and groundedness tripwire
// (numbers/qualifiers/negations), rewritten for the voyage-1024 pipeline.
//
// Design rules: model-free where practical; conservative (fail toward
// INSUFFICIENT / ungrouded findings rather than false confidence); every
// classifier output is deterministic for identical input.

export type Verdict = "SUPPORTED" | "PARTIAL" | "INSUFFICIENT" | "CONFLICTING";

export type EvidenceItem = {
  chunk_id: string;
  document_id: string;
  tenant_id: string;
  file_name: string;
  page: number | null;
  content: string;
  dense_score?: number | null;
  dense_rank?: number | null;
  lex_score?: number | null;
  lex_rank?: number | null;
  fused_score?: number | null;
  fused_rank?: number | null;
};

export const REFUSAL_TEXT =
  "I could not find enough relevant information in the documents to answer that.";

// ---------------------------------------------------------------------------
// Prompt templates (frozen, versioned). Evidence is injected as [Sn]-labeled
// blocks; the model must cite facts as [Sn]. Sn <-> evidence row mapping is
// positional and rebuilt per request; citation IDs are never trusted input.
// ---------------------------------------------------------------------------

export const PROMPT_VERSION = "v1";

export const DIRECT_PROMPT = `You are an expert assistant answering strictly from retrieved evidence.
Answer the question using ONLY the evidence below. Rules:
- Every factual claim must carry a citation like [S1], [S2] referring to the evidence blocks.
- Cite only the blocks provided. Never invent citations, files, pages, numbers, dates, or names.
- Do not use outside knowledge. If the evidence does not cover something, say so instead of guessing.
- Preserve qualifiers and uncertainty exactly as written (only, must, never, not, except, required, always).
- If evidence blocks disagree, surface the conflict explicitly instead of silently picking a side.

Evidence:
{context}

Question:
{question}`;

export const PARTIAL_PROMPT = `You are an expert assistant answering strictly from retrieved evidence.
The evidence only partly covers the question. Rules:
- Answer ONLY the portion the evidence supports, quoting it closely, with citations like [S1], [S2].
- State plainly what cannot be established from the evidence. Do not guess or fill gaps.
- You may suggest which kinds of provisions would be relevant to check, but ONLY as search
  directions, never as claims that such sections exist.
- Distinguish facts ("the text states...") from reasonable readings ("this suggests...").
- Cite only the blocks provided. Never invent citations, numbers, dates, names, or terms.
- Do not use outside knowledge. Preserve qualifiers and uncertainty exactly as written.

Evidence:
{context}

Question:
{question}`;

export const CONFLICT_PROMPT = `You are an expert assistant answering strictly from retrieved evidence.
The evidence contains CONFLICTING statements relevant to the question. Rules:
- Present each conflicting position with its citations like [S1], [S2].
- State clearly that the sources disagree and on what exact point.
- Do NOT resolve the conflict by guessing which side is correct.
- Do not use outside knowledge. Cite only the blocks provided. Never invent citations.

Evidence:
{context}

Question:
{question}`;

export function buildEvidenceBlock(evidence: EvidenceItem[]): { block: string; refs: string[] } {
  const refs: string[] = [];
  const parts = evidence.map((e, i) => {
    const n = i + 1;
    refs.push(e.chunk_id);
    const label = `${e.file_name}${e.page != null ? ` p. ${e.page}` : ""}`;
    return `[S${n}] (${label})\n${e.content}`;
  });
  return { block: parts.join("\n\n---\n\n"), refs };
}

export function renderPrompt(
  mode: "direct" | "partial" | "conflict",
  question: string,
  block: string,
): { template: string; version: string } {
  const template =
    mode === "direct" ? DIRECT_PROMPT : mode === "partial" ? PARTIAL_PROMPT : CONFLICT_PROMPT;
  return {
    template: template.replace("{context}", block).replace("{question}", question),
    version: `${PROMPT_VERSION}-${mode}`,
  };
}

// ---------------------------------------------------------------------------
// Text helpers (normalization shared by gate + tripwire).
// ---------------------------------------------------------------------------

const WORD_RE = /[a-z0-9]+/g;
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are",
  "was", "were", "it", "its", "this", "that", "for", "with", "as", "by",
  "at", "be", "from", "which", "what", "when", "where", "how", "does",
  "do", "did", "can", "could", "should", "would", "will", "there", "here",
  "about", "tell", "me", "please", "you", "your", "i", "my", "we", "our",
]);

function tokens(text: string): string[] {
  return (String(text || "").toLowerCase().match(WORD_RE) ?? []);
}

function contentTokens(text: string): string[] {
  return tokens(text).filter((t) => !STOP.has(t) && t.length > 2);
}

function normText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/['’]s\b/g, "")
    .replace(/(?<=\d)[,\s](?=\d)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT = "(?:%|percent|months?|years?|days?|weeks?|hours?|minutes?|seconds?|dollars?|usd|inr|rs\\.?|kg|km|mm|cm|gb|mb)";
const NUMBER_RE = new RegExp(
  "\\b\\d{4}-\\d{2}-\\d{2}\\b" +
    "|\\b\\d{1,2}\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d{2,4}\\b" +
    "|\\b\\d+(?:\\.\\d+)?\\s*(?:" + UNIT + ")" +
    "|\\b\\d{4,}\\b",
  "gi",
);

export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || ""))) !== null) {
    const n = m[0].toLowerCase().replace(/,/g, "").replace(/\s+/g, " ").trim();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function inflections(term: string): string[] {
  if (term.endsWith("s") && term.length > 4) return [term, term.slice(0, -1)];
  return [term, term + "s"];
}

const QUOTED_RE = /"([^"]{2,80})"|'([^']{2,80})'/g;

export type Atom = { kind: "term" | "number" | "quoted"; text: string; norm: string };

export function questionAtoms(question: string): Atom[] {
  const atoms: Atom[] = [];
  const seen = new Set<string>();
  const add = (kind: Atom["kind"], text: string) => {
    const norm = normText(text);
    if (norm && !seen.has(kind + ":" + norm) && atoms.length < 20) {
      seen.add(kind + ":" + norm);
      atoms.push({ kind, text: text.slice(0, 80), norm });
    }
  };
  for (const n of extractNumbers(question)) add("number", n);
  QUOTED_RE.lastIndex = 0;
  let q: RegExpExecArray | null;
  const qs = String(question || "");
  while ((q = QUOTED_RE.exec(qs)) !== null) add("quoted", (q[1] ?? q[2]).trim());
  for (const t of contentTokens(question)) add("term", t);
  return atoms;
}

// ---------------------------------------------------------------------------
// Evidence sufficiency gate (deterministic, model-free).
// ---------------------------------------------------------------------------

export type GateResult = {
  verdict: Verdict;
  reason: string;
  supported: string[];
  unsupported: string[];
  conflicting: string[];
};

const NEGATION_CUES = ["not", "no", "never", "cannot", "can't"];

function atomSupported(
  atom: Atom,
  chunkNorms: string[],
): boolean {
  if (atom.kind === "term") {
    return chunkNorms.some((cn) => inflections(atom.norm).some((v) => v && cn.includes(v)));
  }
  return chunkNorms.some((cn) => cn.includes(atom.norm));
}

function splitValueUnit(num: string): [string, string] {
  const m = /^([\d.,-]+)\s*(.*)$/.exec(normText(num).replace(/,/g, ""));
  if (!m) return [normText(num), ""];
  return [m[1], m[2].trim()];
}

function relevantIdx(qToks: Set<string>, chunkTokSets: Set<string>[]): number[] {
  const out: number[] = [];
  chunkTokSets.forEach((s, i) => {
    let shared = 0;
    for (const t of qToks) if (s.has(t)) shared++;
    if (shared >= 1) out.push(i);
  });
  return out;
}

export function verifyEvidence(question: string, evidence: EvidenceItem[]): GateResult {
  const chunks = (evidence ?? []).filter((e) => e && e.content);
  const chunkNorms = chunks.map((c) => normText(c.content));
  const chunkTokSets = chunks.map((c) => new Set(contentTokens(c.content)));
  const base = {
    supported: [] as string[],
    unsupported: [] as string[],
    conflicting: [] as string[],
  };
  if (!chunks.length) {
    return { ...base, verdict: "INSUFFICIENT", reason: "no-evidence" };
  }
  const atoms = questionAtoms(question);
  if (!atoms.length) {
    return { ...base, verdict: "SUPPORTED", reason: "no-checkable-claims" };
  }
  for (const atom of atoms) {
    (atomSupported(atom, chunkNorms) ? base.supported : base.unsupported).push(atom.text);
  }

  // Number conflicts: distinct values, same unit, across relevant chunks.
  const qToks = new Set(contentTokens(question));
  const rel = relevantIdx(qToks, chunkTokSets);
  const byUnit = new Map<string, Set<string>>();
  for (const i of rel) {
    const seenHere = new Set<string>();
    for (const num of extractNumbers(chunkNorms[i])) {
      const [value, unit] = splitValueUnit(num);
      if (!value || seenHere.has(unit + "=" + value)) continue;
      seenHere.add(unit + "=" + value);
      if (!byUnit.has(unit)) byUnit.set(unit, new Set());
      byUnit.get(unit)!.add(value);
    }
  }
  for (const [unit, values] of [...byUnit.entries()].sort()) {
    if (values.size > 1) {
      base.conflicting.push(`conflicting ${unit || "value"}: ${[...values].sort().join(" vs ").slice(0, 120)}`);
    }
  }
  // Negation conflicts: one relevant chunk negates a shared phrase another affirms.
  const hasCue = (text: string, cue: string) =>
    new RegExp(`\\b${cue.replace("'", "'")}s?\\b`).test(text);
  const negIdx = rel.filter((i) => NEGATION_CUES.some((cue) => hasCue(chunkNorms[i], cue)));
  const posIdx = rel.filter((i) => !negIdx.includes(i));
  outer: for (const n of negIdx) {
    for (const p of posIdx) {
      const a = [...chunkTokSets[n]].sort();
      const b = new Set(chunkTokSets[p]);
      let sharedBigrams = 0;
      for (let k = 0; k + 1 < a.length; k++) {
        if (b.has(a[k]) && b.has(a[k + 1])) sharedBigrams++;
      }
      if (sharedBigrams >= 1) {
        base.conflicting.push("negation conflict on shared phrase");
        break outer;
      }
    }
  }

  if (base.conflicting.length) {
    return { ...base, verdict: "CONFLICTING", reason: "conflicting-evidence" };
  }
  if (!base.unsupported.length) {
    return { ...base, verdict: "SUPPORTED", reason: "all-supported" };
  }
  const disjoint = chunkTokSets.every((s) => {
    for (const t of qToks) if (s.has(t)) return false;
    return true;
  });
  return {
    ...base,
    verdict: disjoint ? "INSUFFICIENT" : "PARTIAL",
    reason: disjoint ? "unsupported-claims" : "insufficient-evidence",
  };
}

export function promptModeFor(
  verdict: Verdict,
): "direct" | "partial" | "conflict" | "refuse" {
  if (verdict === "SUPPORTED") return "direct";
  if (verdict === "PARTIAL") return "partial";
  if (verdict === "CONFLICTING") return "conflict";
  return "refuse";
}

// ---------------------------------------------------------------------------
// Bounded deterministic clarification gate. Triggers ONLY when the query is
// structurally unanswerable without missing information:
//  1. bare anaphoric follow-up ("what about it", "tell me more", "compare
//     them") with zero prior conversation messages (no referent exists);
//  2. a comparison request naming fewer than two .pdf targets while the
//     tenant corpus holds more than one document (ambiguous target).
// Anything else proceeds to retrieval. At most one clarification per turn
// is enforced by the caller (confirmations resolve to the original query).
// ---------------------------------------------------------------------------

const ANAPHORIC_RE = /^(what about|tell me more|explain|describe|compare|and|what|how)\b.{0,24}\b(it|this|that|them|those|these)\s*[?.!]*$/i;
const COMPARE_RE = /\b(compare|comparison|differences?|versus|\bvs\b)\b/i;
const PDF_RE = /\b[\w][\w\-]*\.pdf\b/gi;

export function clarificationTrigger(
  query: string,
  priorMessageCount: number,
  documentCount: number,
): { needed: true; reason: string; question: string } | { needed: false } {
  const q = String(query || "").trim();
  if (!q) return { needed: false };
  if (priorMessageCount <= 0 && ANAPHORIC_RE.test(q)) {
    return {
      needed: true,
      reason: "anaphoric-no-referent",
      question: "Which document or topic are you referring to? Please name the document or restate the question.",
    };
  }
  if (documentCount > 1 && COMPARE_RE.test(q)) {
    const targets = new Set((q.match(PDF_RE) ?? []).map((s) => s.toLowerCase()));
    if (targets.size < 2) {
      return {
        needed: true,
        reason: "ambiguous-comparison-target",
        question: "Which two documents should I compare? Please name both files.",
      };
    }
  }
  return { needed: false };
}

// ---------------------------------------------------------------------------
// Citation guard (deterministic). Citations are positional [Sn] labels over
// the exact evidence array supplied to generation.
// ---------------------------------------------------------------------------

const CITE_RE = /\[S(\d+)\]/g;
const BARE_CITE_RE = /\[S\]/;

export function parseCitations(answer: string): number[] {
  const out: number[] = [];
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const s = String(answer || "");
  while ((m = CITE_RE.exec(s)) !== null) out.push(parseInt(m[1], 10));
  return out;
}

export function validateCitations(
  answer: string,
  evidence: EvidenceItem[],
  tenantId: string,
  scope?: { documentId?: string },
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const text = String(answer || "");
  if (BARE_CITE_RE.test(text)) errors.push("malformed citation [S] with no number");
  for (const n of parseCitations(answer)) {
    if (n < 1 || n > evidence.length) {
      errors.push(`citation [S${n}] references no supplied evidence (1..${evidence.length})`);
      continue;
    }
    const row = evidence[n - 1];
    if (!row || row.chunk_id == null) {
      errors.push(`citation [S${n}] has no backing chunk`);
      continue;
    }
    if (row.tenant_id !== tenantId) {
      errors.push(`citation [S${n}] crosses tenant boundary`);
    }
    if (scope?.documentId && row.document_id !== scope.documentId) {
      errors.push(`citation [S${n}] points outside the cited document`);
    }
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Post-generation groundedness tripwire (deterministic, conservative).
// Checks numbers, qualifiers/negations, and basic claim support against the
// actual retrieved chunks. Findings downgrade — never silently rewrite.
// ---------------------------------------------------------------------------

export type TripwireResult = {
  grounded: boolean;
  unsupportedClaims: string[];
  numericMismatches: string[];
  missingQualifiers: string[];
};

const QUALIFIER_CUES = [
  "not", "no", "never", "none", "only", "except", "unless", "cannot",
  "can't", "must", "required", "always", "without",
];
const SENT_RE = /(?<=[.!?])\s+/;
const MIN_SENTENCE_TOKENS = 4;
const SUPPORT_OVERLAP = 0.25;
const HIGH_OVERLAP = 0.5;

function splitSentences(text: string): string[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  return clean.split(SENT_RE).map((s) => s.trim()).filter(Boolean);
}

function overlapRatio(sentToks: string[], chunkToks: string[]): number {
  if (!sentToks.length) return 0;
  const set = new Set(chunkToks);
  return sentToks.filter((t) => set.has(t)).length / sentToks.length;
}

export function checkGroundedness(
  answer: string,
  evidenceContents: string[],
): TripwireResult {
  const out: TripwireResult = {
    grounded: true,
    unsupportedClaims: [],
    numericMismatches: [],
    missingQualifiers: [],
  };
  const add = (key: "unsupportedClaims" | "numericMismatches" | "missingQualifiers", text: string) => {
    const list = out[key];
    const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (t && !list.includes(t) && list.length < 4) {
      list.push(t);
      out.grounded = false;
    }
  };
  const chunks = (evidenceContents ?? [])
    .map((c) => String(c || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const cleanAnswer = String(answer || "").replace(/\s+/g, " ").trim();
  if (!cleanAnswer || !chunks.length) return out;
  const chunkToks = chunks.map(contentTokens);
  const blob = chunks.join(" ").toLowerCase();
  const evSents = chunks.flatMap((c) =>
    splitSentences(c).map((s) => ({ text: s, toks: new Set(contentTokens(s)), low: s.toLowerCase() }))
  );
  const cuePresent = (low: string, cue: string) =>
    new RegExp(`\\b${cue.replace("'", "\\'")}\\b`).test(low);

  for (const sent of splitSentences(cleanAnswer)) {
    const stoks = contentTokens(sent);
    if (tokens(sent).length < MIN_SENTENCE_TOKENS) continue;
    const scored = chunkToks
      .map((ct, i) => ({ ratio: overlapRatio(stoks, ct), i }))
      .sort((a, b) => b.ratio - a.ratio);
    const best = scored[0];
    const bestChunk = chunks[best.i].toLowerCase();
    const sentNums = extractNumbers(sent);
    const sentLow = sent.toLowerCase();
    const quals = [...new Set(QUALIFIER_CUES.filter((q) => cuePresent(sentLow, q)))];

    // Dropped negation: evidence negates a shared phrase the answer affirms.
    const sset = new Set(stoks);
    for (const ev of evSents) {
      let shared = 0;
      for (const t of sset) if (ev.toks.has(t)) shared++;
      if (shared >= 2) {
        for (const cue of NEGATION_CUES) {
          if (cuePresent(ev.low, cue) && !cuePresent(sentLow, cue)) {
            add("missingQualifiers", `${sent} [evidence negates shared phrase (${cue})]`);
            break;
          }
        }
        break;
      }
    }

    if (best.ratio >= HIGH_OVERLAP) {
      for (const num of sentNums) {
        if (!bestChunk.includes(num) && !blob.includes(num)) {
          add("numericMismatches", `${sent} [number not in supporting chunk: ${num}]`);
        }
      }
      for (const q of quals) {
        if (!cuePresent(bestChunk, q)) add("numericMismatches", `${sent} [qualifier not in supporting chunk: ${q}]`);
      }
      continue;
    }
    if (best.ratio < SUPPORT_OVERLAP) {
      // Skip boilerplate: refusals, clarifications, and bare citations carry
      // no factual load. Citation-only sentences are validated by the guard.
      if (/^i (could not|cannot|do not)|please |which .*should i/i.test(sent)) continue;
      add("unsupportedClaims", sent);
      continue;
    }
    for (const num of sentNums) {
      if (!blob.includes(num)) add("numericMismatches", `${sent} [number not in evidence: ${num}]`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mantle Chat Completions transport helpers (Phase 3C.1.4). Pure functions:
// map HTTP/body outcomes to the ask endpoint's failure contract and extract
// the answer text + usage. No I/O, no secrets. Unit-tested; the live call
// itself stays in ask/index.ts.
// ---------------------------------------------------------------------------

export const MANTLE_CHAT_PATH = "/chat/completions";

export type MantleFailure =
  | { kind: "auth"; status: number; message: string }
  | { kind: "throttled"; status: number; message: string }
  | { kind: "provider"; status: number; message: string };

export function mapMantleFailure(status: number, bodyText: string): MantleFailure {
  const body = String(bodyText || "").slice(0, 200);
  if (status === 401 || status === 403) {
    return { kind: "auth", status, message: "answer model auth failed; check MANTLE_API_KEY and model access" };
  }
  if (status === 429) {
    return { kind: "throttled", status, message: "answer model throttled; retry shortly" };
  }
  return { kind: "provider", status, message: `answer generation failed (status ${status}): ${body}` };
}

export type MantleParsed =
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | { ok: false; error: string };

export function parseMantleResponse(body: unknown): MantleParsed {
  try {
    const obj = (typeof body === "string" ? JSON.parse(body) : body) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null;
    const content = obj?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "malformed mantle response: missing choices[0].message.content" };
    }
    const toNum = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    return {
      ok: true,
      text: content,
      inputTokens: toNum(obj?.usage?.prompt_tokens),
      outputTokens: toNum(obj?.usage?.completion_tokens),
    };
  } catch {
    return { ok: false, error: "malformed mantle response: unparseable body" };
  }
}
