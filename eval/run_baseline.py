"""Phase 3C.2 baseline runner: 34 gold cases through the REAL production path.

For each case: POST /ask (authenticated) -> record answer/label/citations/
evidence/gate/grounded -> compute deterministic layer metrics. No retrieval,
gating, or generation reimplemented here; no LLM judge; no gold edits.

Metrics per case (all deterministic):
  retrieval_hit      any expected chunk_id in evidence (or, for refusal
                     cases with empty expected sets, evidence empty or
                     gate INSUFFICIENT)
  recall@4/8/12      |expected ∩ evidence[:k]| / |expected| (refusal cases:
                     1.0 when gate is INSUFFICIENT else 0.0)
  mrr                1/rank of first expected hit (0.0 when none; refusal
                     cases: 1.0 when INSUFFICIENT else 0.0)
  gate_match         response gate.verdict == expected_verdict
  label_match        response label maps to expected_verdict
                     (SUPPORTED->direct, PARTIAL->partial,
                      INSUFFICIENT->insufficient, CONFLICTING->conflict)
  citations_ok       SUPPORTED/PARTIAL: >=1 citation; INSUFFICIENT: none.
                     (ask's guard already proves validity of present cites)
  key_fact_recall    normalized-substring fraction of expected_key_facts
                     in the answer (SUPPORTED/PARTIAL only; informational)

Observability (structural copies only, no grading): each result also
preserves the question, the gold expectation (answer/key facts/behavior),
the exact /ask answer text, citation objects, grounding_note, the
retrieved evidence list (chunk IDs/pages/ranks/scores AND bounded evidence
text in fused order; text is the exact retrieved content, already bounded
server-side, needed for independent diagnosis per 3C.18), quality-chain
diagnostics (gate conflicting list, citation-guard, tripwire reason,
correctness object, stage timings, model/version metadata), and
persistence metadata. Metrics above are
unchanged; no correctness/similarity/grading computation is performed.

Usage (never commit credentials):
  set SUPABASE_URL=https://<ref>.supabase.co
  set SUPABASE_ANON_KEY=<publishable key>
  set RAG4I_EVAL_JWT=<access jwt>              # shell-only, never committed
  set RAG4I_EVAL_REFRESH_TOKEN=<refresh token> # shell-only, enables re-auth
  python eval/run_baseline.py --tenant <uuid> [--token <jwt>]
      [--refresh-token <rt>] [--sleep 30]
Raw --token is no longer necessary when RAG4I_EVAL_JWT is set (CLI arguments
land in shell history; prefer env). Refresh resolution order: --refresh-token,
RAG4I_EVAL_REFRESH_TOKEN, then the Windows Credential Manager vault (see
eval/store_refresh_token.py for one-time init). On HTTP 401 the runner
performs at most
ONE refresh-grant exchange and retries the failed request exactly once; the
refreshed access token stays process-memory-only and never enters result
JSON, logs, exceptions, or output.
Output: eval/runs/<utc-timestamp>.json
"""

import argparse
import datetime
import json
import os
import re
import time
import urllib.error
import urllib.request

LABEL_FOR = {
    "SUPPORTED": "direct",
    "PARTIAL": "partial",
    "INSUFFICIENT": "insufficient",
    "CONFLICTING": "conflict",
}

# Evidence fields preserved per item (structural provenance only).
# Text is the exact retrieved chunk content, bounded server-side to the
# evidence cut (8 items); tenant_id is deliberately excluded, as are
# credentials (never present in these payloads).
EVIDENCE_KEYS = (
    "chunk_id", "document_id", "file_name", "page", "text",
    "fused_rank", "fused_score",
    "dense_score", "dense_rank", "lex_score", "lex_rank",
)


def project_evidence(item):
    """Bounded structural copy of one /query-chunks evidence item."""
    if not isinstance(item, dict):
        return {}
    return {k: item.get(k) for k in EVIDENCE_KEYS}


def expected_block(case):
    """Gold expectation copy (read-only; the gold file is never modified)."""
    return {
        "answer": case.get("expected_answer"),
        "key_facts": case.get("expected_key_facts", []) or [],
        "behavior": case.get("expected_behavior"),
    }


def null_observability(case):
    """Schema-stable null defaults for failure paths (no network data)."""
    return {
        "question": case.get("question"),
        "expected": expected_block(case),
        "answer": None,
        "citations": [],
        "grounding_note": None,
        "evidence": [],
        "gate_conflicting": [],
        "citation_guard": None,
        "tripwire": None,
        "correctness": None,
        "timings": None,
        "model": None,
        "persisted": None,
        "conversation_id": None,
    }


def git_commit():
    """Best-effort source version; None when unavailable (never guessed)."""
    try:
        import subprocess
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True,
            timeout=10, cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        sha = (out.stdout or "").strip()
        return sha or None
    except Exception:
        return None


def error_detail(e):
    """Bounded provider/transport detail for HTTP failures (no secrets:
    these are our own error envelopes). None when unavailable."""
    try:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
    except Exception:
        return None
    if not body:
        return None
    try:
        data = json.loads(body)
        if isinstance(data, dict):
            return {k: str(data.get(k))[:200] for k in ("error",) if data.get(k)}
    except Exception:
        pass
    return {"body": body[:300]} if body.strip() else None


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


class _AuthFailure(Exception):
    """Access was rejected (HTTP 401) and no usable refresh token exists.
    Carries no credential content by construction."""


class _Auth:
    """Process-memory-only credentials. Never printed, never persisted,
    never included in results."""

    def __init__(self, token, refresh):
        self.token = token
        self.refresh = refresh
        self.refreshed = False  # at most ONE refresh-grant request per run


try:
    from wincred import read_refresh_token as _vault_read
except Exception:
    _vault_read = None


def _stored_refresh_token():
    """Windows Credential Manager fallback (DPAPI-backed, per-user vault).
    Returns '' when unavailable. Never prints."""
    if _vault_read is None:
        return ""
    try:
        return _vault_read() or ""
    except Exception:
        return ""


def refresh_access_token(base, anon, refresh_token):
    """Single GoTrue refresh-grant exchange. Returns the new access token,
    or None when unavailable/failed. Never raises with credential content."""
    req = urllib.request.Request(
        base + "/auth/v1/token?grant_type=refresh_token",
        data=json.dumps({"refresh_token": refresh_token}).encode(),
        headers={"apikey": anon, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode())
    except Exception:
        return None
    tok = body.get("access_token") if isinstance(body, dict) else None
    return tok or None


def authed_call(fn, auth, base, anon, tenant, query):
    """Call fn(base, anon, token, tenant, query). On HTTP 401, perform at
    most one refresh-grant request and retry the failed request exactly
    once. No retry loops."""
    try:
        return fn(base, anon, auth.token, tenant, query)
    except urllib.error.HTTPError as e:
        if e.code != 401:
            raise
    if auth.refresh and not auth.refreshed:
        auth.refreshed = True
        new_token = refresh_access_token(base, anon, auth.refresh)
        if new_token:
            auth.token = new_token
            try:
                return fn(base, anon, auth.token, tenant, query)
            except urllib.error.HTTPError as e2:
                if e2.code == 401:
                    raise _AuthFailure()
                raise
    raise _AuthFailure()


def ask(base, anon, token, tenant, query):
    req = urllib.request.Request(
        base + "/functions/v1/ask",
        data=json.dumps({"tenant_id": tenant, "query": query}).encode(),
        headers={
            "apikey": anon,
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status, json.loads(r.read().decode())


def retrieve(base, anon, token, tenant, query):
    """Evidence chunk IDs via the real query-chunks mechanism (same call the
    ask endpoint makes internally). Separate call, same behavior."""
    req = urllib.request.Request(
        base + "/functions/v1/query-chunks",
        data=json.dumps({"tenant_id": tenant, "query": query}).encode(),
        headers={
            "apikey": anon,
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status, json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--token", default=None,
                    help="Access JWT. Prefer the RAG4I_EVAL_JWT env var: raw "
                         "CLI tokens land in shell history.")
    ap.add_argument("--refresh-token", default=None,
                    help="Refresh token for one automatic re-auth on HTTP "
                         "401. Prefer the RAG4I_EVAL_REFRESH_TOKEN env var.")
    ap.add_argument("--cases", default="eval/cases/gold_cases.json")
    ap.add_argument("--mapping", default="eval/mappings/chunk_map.json")
    ap.add_argument("--out", default=None)
    ap.add_argument("--sleep", type=float, default=30.0)
    args = ap.parse_args()

    base = os.environ["SUPABASE_URL"].rstrip("/")
    anon = os.environ["SUPABASE_ANON_KEY"]
    access = args.token or os.environ.get("RAG4I_EVAL_JWT", "")
    refresh = (args.refresh_token
               or os.environ.get("RAG4I_EVAL_REFRESH_TOKEN", "")
               or _stored_refresh_token())
    if not access:
        ap.error("no access token: pass --token or set RAG4I_EVAL_JWT "
                 "(never commit tokens)")
    auth = _Auth(access, refresh)
    gold = json.load(open(args.cases, encoding="utf-8"))["cases"]
    mapping = json.load(open(args.mapping, encoding="utf-8"))["cases"]

    results = []
    for i, case in enumerate(gold):
        cid = case["id"]
        expected = mapping.get(cid, {}).get("chunk_ids", [])
        try:
            http, resp = authed_call(ask, auth, base, anon, args.tenant, case["question"])
            time.sleep(args.sleep / 2.0)
            rhttp, rev = authed_call(retrieve, auth, base, anon, args.tenant, case["question"])
        except _AuthFailure:
            results.append({
                "case_id": cid,
                "http": 401,
                "auth_error": "unauthorized: access token rejected and no "
                              "usable refresh token (set RAG4I_EVAL_JWT / "
                              "RAG4I_EVAL_REFRESH_TOKEN; never commit tokens)",
                **null_observability(case),
            })
            continue
        except Exception as e:  # noqa: BLE001 - record transport failures honestly
            rec = {"case_id": cid, "http": -1, "transport_error": str(e)[:200],
                   **null_observability(case)}
            if isinstance(e, urllib.error.HTTPError):
                rec["http"] = e.code
                detail = error_detail(e)
                if detail:
                    rec["error_detail"] = detail
            results.append(rec)
            continue
        ev_items = []
        if isinstance(rev, dict) and rev.get("ok"):
            for e in rev.get("evidence", []) or []:
                proj = project_evidence(e)
                if proj.get("chunk_id"):
                    ev_items.append(proj)
        ev_ids = [e["chunk_id"] for e in ev_items]
        ev = resp.get("evidence_count") if isinstance(resp, dict) else None
        gate_obj = resp.get("gate") if isinstance(resp, dict) else None
        gate = (gate_obj or {}).get("verdict") if isinstance(gate_obj, dict) else None
        gate_reason = (gate_obj or {}).get("reason") if isinstance(gate_obj, dict) else None
        gate_conflicting = (gate_obj or {}).get("conflicting") if isinstance(gate_obj, dict) else None
        label = resp.get("label") if isinstance(resp, dict) else None
        cites = resp.get("citations", []) if isinstance(resp, dict) else []
        answer = resp.get("answer", "") if isinstance(resp, dict) else ""

        if expected:
            ranks = [ev_ids.index(x) + 1 for x in expected if x in ev_ids]
            hit = bool(ranks)
            mrr = 1.0 / min(ranks) if ranks else 0.0

            def recall(k):
                top = set(ev_ids[:k])
                return sum(1 for x in expected if x in top) / len(expected)
        else:
            hit = gate == "INSUFFICIENT"
            mrr = 1.0 if gate == "INSUFFICIENT" else 0.0

            def recall(k):
                return 1.0 if gate == "INSUFFICIENT" else 0.0

        facts = case.get("expected_key_facts", []) or []
        if case["expected_verdict"] in ("SUPPORTED", "PARTIAL") and facts:
            normed = norm(answer)
            fact_hit = sum(1 for f in facts if norm(f) and norm(f) in normed) / len(facts)
        else:
            fact_hit = None

        if case["expected_verdict"] == "INSUFFICIENT":
            cites_ok = len(cites) == 0
        else:
            cites_ok = len(cites) > 0

        results.append({
            "case_id": cid,
            "category": case.get("category"),
            "http": http,
            "retrieval_http": rhttp,
            "question": case.get("question"),
            "expected": expected_block(case),
            "expected_verdict": case["expected_verdict"],
            "gate_verdict": gate,
            "gate_reason": gate_reason,
            "gate_match": gate == case["expected_verdict"],
            "label": label,
            "label_match": label == LABEL_FOR.get(case["expected_verdict"]),
            "answer": answer,
            "expected_chunks": len(expected),
            "evidence_count": len(ev_ids),
            "evidence": ev_items,
            "gate_conflicting": gate_conflicting if isinstance(gate_conflicting, list) else [],
            "citation_guard": resp.get("citation_guard") if isinstance(resp, dict) else None,
            "tripwire": resp.get("tripwire") if isinstance(resp, dict) else None,
            "correctness": resp.get("correctness") if isinstance(resp, dict) else None,
            "timings": resp.get("timings") if isinstance(resp, dict) else None,
            "model": resp.get("model") if isinstance(resp, dict) else None,
            "retrieval_hit": hit,
            "recall@4": recall(4),
            "recall@8": recall(8),
            "recall@12": recall(12),
            "mrr": mrr,
            "citations": cites if isinstance(cites, list) else [],
            "citations_count": len(cites),
            "citations_ok": cites_ok,
            "key_fact_recall": fact_hit,
            "grounded": resp.get("grounded") if isinstance(resp, dict) else None,
            "grounding_note": resp.get("grounding_note") if isinstance(resp, dict) else None,
            "persisted": resp.get("persisted") if isinstance(resp, dict) else None,
            "conversation_id": resp.get("conversation_id") if isinstance(resp, dict) else None,
        })
        print("%s http=%s gate=%s label=%s hit=%s mrr=%.3f facts=%s" % (
            cid, http, gate, label, hit,
            mrr, ("%.2f" % fact_hit) if fact_hit is not None else "-"), flush=True)
        if i < len(gold) - 1:
            time.sleep(args.sleep)

    ok = [r for r in results if r.get("http") == 200]
    summary = {
        "n": len(results),
        "http_200": len(ok),
        "hit_rate": sum(1 for r in ok if r.get("retrieval_hit")) / len(ok) if ok else 0,
        "mean_recall@8": sum(r.get("recall@8", 0) for r in ok) / len(ok) if ok else 0,
        "mean_mrr": sum(r.get("mrr", 0) for r in ok) / len(ok) if ok else 0,
        "gate_match_rate": sum(1 for r in ok if r.get("gate_match")) / len(ok) if ok else 0,
        "label_match_rate": sum(1 for r in ok if r.get("label_match")) / len(ok) if ok else 0,
        "citations_ok_rate": sum(1 for r in ok if r.get("citations_ok")) / len(ok) if ok else 0,
    }
    run = {
        "run_id": "baseline-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "git_commit": git_commit(),
        "cases_file": args.cases,
        "mapping_file": args.mapping,
        "summary": summary,
        "results": results,
    }
    out = args.out or ("eval/runs/%s.json" % run["run_id"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(run, f, indent=1)
    print("SUMMARY " + json.dumps(summary))
    print("wrote " + out)


if __name__ == "__main__":
    main()
