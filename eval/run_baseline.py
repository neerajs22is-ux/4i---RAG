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

Usage (never commit credentials):
  set SUPABASE_URL=https://<ref>.supabase.co
  set SUPABASE_ANON_KEY=<publishable key>
  python eval/run_baseline.py --tenant <uuid> --token <jwt> [--sleep 30]
Output: eval/runs/<utc-timestamp>.json
"""

import argparse
import datetime
import json
import os
import re
import time
import urllib.request

LABEL_FOR = {
    "SUPPORTED": "direct",
    "PARTIAL": "partial",
    "INSUFFICIENT": "insufficient",
    "CONFLICTING": "conflict",
}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


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
    ap.add_argument("--token", required=True)
    ap.add_argument("--cases", default="eval/cases/gold_cases.json")
    ap.add_argument("--mapping", default="eval/mappings/chunk_map.json")
    ap.add_argument("--out", default=None)
    ap.add_argument("--sleep", type=float, default=30.0)
    args = ap.parse_args()

    base = os.environ["SUPABASE_URL"].rstrip("/")
    anon = os.environ["SUPABASE_ANON_KEY"]
    gold = json.load(open(args.cases, encoding="utf-8"))["cases"]
    mapping = json.load(open(args.mapping, encoding="utf-8"))["cases"]

    results = []
    for i, case in enumerate(gold):
        cid = case["id"]
        expected = mapping.get(cid, {}).get("chunk_ids", [])
        try:
            http, resp = ask(base, anon, args.token, args.tenant, case["question"])
            time.sleep(args.sleep / 2.0)
            rhttp, rev = retrieve(base, anon, args.token, args.tenant, case["question"])
        except Exception as e:  # noqa: BLE001 - record transport failures honestly
            results.append({"case_id": cid, "http": -1, "transport_error": str(e)[:200]})
            continue
        ev_ids = []
        if isinstance(rev, dict) and rev.get("ok"):
            for e in rev.get("evidence", []) or []:
                if isinstance(e, dict) and e.get("chunk_id"):
                    ev_ids.append(e["chunk_id"])
        ev = resp.get("evidence_count") if isinstance(resp, dict) else None
        gate = (resp.get("gate") or {}).get("verdict") if isinstance(resp, dict) else None
        gate_reason = (resp.get("gate") or {}).get("reason") if isinstance(resp, dict) else None
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
            "expected_verdict": case["expected_verdict"],
            "gate_verdict": gate,
            "gate_reason": gate_reason,
            "gate_match": gate == case["expected_verdict"],
            "label": label,
            "label_match": label == LABEL_FOR.get(case["expected_verdict"]),
            "expected_chunks": len(expected),
            "evidence_count": len(ev_ids),
            "retrieval_hit": hit,
            "recall@4": recall(4),
            "recall@8": recall(8),
            "recall@12": recall(12),
            "mrr": mrr,
            "citations_count": len(cites),
            "citations_ok": cites_ok,
            "key_fact_recall": fact_hit,
            "grounded": resp.get("grounded") if isinstance(resp, dict) else None,
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
