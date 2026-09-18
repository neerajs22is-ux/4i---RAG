"""Benchmark-only full evaluation runner: frozen gold cases through the
isolated Jina benchmark path (NO production /ask, NO /query-chunks).

For each case, per condition (A = no rerank, B = reranked):
  POST /benchmark-retrieval (rerank=both: one query embedding, one fused
  candidate pool shared by both conditions)
  -> POST /benchmark-answer per evidence set (gate, generation, guard)
  -> record answer/label/citations/evidence/gate/grounded
  -> compute the SAME deterministic metrics as run_baseline.

Benchmark mode is explicit and never the default: provider/model/reranker/run
identity are required metadata, Jina is never the production provider, and no
historical artifact is ever overwritten (refuses to write over an existing
output file). No benchmark is executed by writing or importing this file.

Usage (never commit credentials):
  set SUPABASE_URL=https://<ref>.supabase.co
  set SUPABASE_ANON_KEY=<publishable key>
  set RAG4I_EVAL_JWT=<access jwt>              # shell-only, never committed
  set RAG4I_EVAL_REFRESH_TOKEN=<refresh token> # shell-only, enables re-auth
  python eval/run_benchmark.py --tenant <uuid> --run-id <id>
      [--sleep 5]
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_baseline as base  # noqa: E402  (metric helpers only; no benchmark run)

BENCHMARK_PROVIDER = "jina"
BENCHMARK_MODEL = "jina-embeddings-v5-text-small"
CONDITIONS = ("none", "jina-reranker-v3.5")
RETRIEVAL_DEFAULTS = {
    "dense_n": 20,
    "lexical_n": 20,
    "candidate_cap": 50,
    "rrf_k": 60,
    "final_k": 8,
    "fusion": "rrf",
}


def retrieve_benchmark(fn_base, anon, token, tenant, query, function_name,
                       provider, model, run_id):
    """One benchmark retrieval call with rerank=both: a single query
    embedding and a single fused candidate pool serve conditions A and B.
    Same call discipline as the production query-chunks call in run_baseline,
    against the benchmark-only endpoint."""
    req = urllib.request.Request(
        fn_base + "/functions/v1/" + function_name,
        data=json.dumps({
            "tenant_id": tenant,
            "query": query,
            "provider": provider,
            "model": model,
            "benchmark_run_id": run_id,
            "rerank": "both",
        }).encode(),
        headers={
            "apikey": anon,
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.status, json.loads(r.read().decode())


def answer_benchmark(fn_base, anon, token, tenant, query, evidence,
                     answer_function, provider, model, reranker, run_id,
                     doc_count, retrieval_ms):
    """One benchmark answer call over caller-supplied evidence. The benchmark
    answer endpoint runs the shared gate/generation/guard semantics without
    persisting anything. prior_count is always 0: like the control runner,
    every benchmark case is evaluated as a fresh question."""
    req = urllib.request.Request(
        fn_base + "/functions/v1/" + answer_function,
        data=json.dumps({
            "tenant_id": tenant,
            "query": query,
            "evidence": evidence,
            "prior_count": 0,
            "doc_count": doc_count,
            "retrieval_ms": retrieval_ms,
            "provider": provider,
            "model": model,
            "reranker": reranker,
            "benchmark_run_id": run_id,
        }).encode(),
        headers={
            "apikey": anon,
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.status, json.loads(r.read().decode())


def score_condition(case, expected, ev_items, http, resp):
    """Score one condition with the run_baseline metric definitions."""
    ev_ids = [e["chunk_id"] for e in ev_items]
    gate_obj = resp.get("gate") if isinstance(resp, dict) else None
    gate = (gate_obj or {}).get("verdict") if isinstance(gate_obj, dict) else None
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

    gate_reason = (gate_obj or {}).get("reason") if isinstance(gate_obj, dict) else None
    gate_conflicting = (gate_obj or {}).get("conflicting") if isinstance(gate_obj, dict) else None
    label = resp.get("label") if isinstance(resp, dict) else None
    cites = resp.get("citations", []) if isinstance(resp, dict) else []
    answer = resp.get("answer", "") if isinstance(resp, dict) else ""
    facts = case.get("expected_key_facts", []) or []
    if case["expected_verdict"] in ("SUPPORTED", "PARTIAL") and facts:
        normed = base.norm(answer)
        fact_hit = sum(1 for f in facts if base.norm(f) and base.norm(f) in normed) / len(facts)
    else:
        fact_hit = None
    if case["expected_verdict"] == "INSUFFICIENT":
        cites_ok = len(cites) == 0
    else:
        cites_ok = len(cites) > 0
    return {
        "http": http,
        "question": case.get("question"),
        "expected": base.expected_block(case),
        "expected_chunks": len(expected),
        "evidence_count": len(ev_ids),
        "evidence": ev_items,
        "retrieval_hit": hit,
        "recall@4": recall(4),
        "recall@8": recall(8),
        "recall@12": recall(12),
        "mrr": mrr,
        "gate_verdict": gate,
        "gate_reason": gate_reason,
        "gate_conflicting": gate_conflicting if isinstance(gate_conflicting, list) else [],
        "gate_match": gate == case["expected_verdict"],
        "label": label,
        "label_match": label == base.LABEL_FOR.get(case["expected_verdict"]),
        "answer": answer,
        "citations": cites if isinstance(cites, list) else [],
        "citations_count": len(cites),
        "citations_ok": cites_ok,
        "key_fact_recall": fact_hit,
        "grounded": resp.get("grounded") if isinstance(resp, dict) else None,
        "grounding_note": resp.get("grounding_note") if isinstance(resp, dict) else None,
        "citation_guard": resp.get("citation_guard") if isinstance(resp, dict) else None,
        "tripwire": resp.get("tripwire") if isinstance(resp, dict) else None,
        "correctness": resp.get("correctness") if isinstance(resp, dict) else None,
        "timings": resp.get("timings") if isinstance(resp, dict) else None,
        "model": resp.get("model") if isinstance(resp, dict) else None,
        "persisted": resp.get("persisted") if isinstance(resp, dict) else None,
    }


def load_population(path):
    """Merge population timing recorded by the population executor.

    Expected shape (all fields optional except as noted):
      {"started_at": iso, "ended_at": iso, "wall_clock_s": float,
       "requests": int, "tokens": int, "retries_429": int, "failures": int,
       "pacing_sleep_s": float, "calls": [{...per-call records...}]}
    Returns None when no file is given. Never invents values.
    """
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("population file must be a JSON object")
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--run-id", required=True,
                    help="Explicit benchmark run identifier (never reused).")
    ap.add_argument("--token", default=None)
    ap.add_argument("--refresh-token", default=None)
    ap.add_argument("--cases", default="eval/cases/gold_cases.json")
    ap.add_argument("--mapping", default="eval/mappings/chunk_map_3c4.json")
    ap.add_argument("--out", default=None)
    ap.add_argument("--sleep", type=float, default=5.0)
    ap.add_argument("--function", default="benchmark-retrieval",
                    help="Benchmark-only retrieval function (never ask/query-chunks).")
    ap.add_argument("--answer-function", default="benchmark-answer",
                    help="Benchmark-only answer function (never ask).")
    ap.add_argument("--population", default=None,
                    help="Optional JSON file with population timing (start/end timestamps, "
                         "per-call request/token/timing records) merged into the artifact "
                         "as run['population']. Recorded by the population executor.")
    ap.add_argument("--provider", default=BENCHMARK_PROVIDER, choices=(BENCHMARK_PROVIDER,),
                    help="Benchmark embedding provider (locked to jina).")
    ap.add_argument("--model", default=BENCHMARK_MODEL, choices=(BENCHMARK_MODEL,),
                    help="Benchmark embedding model (locked).")
    args = ap.parse_args()

    for endpoint in (args.function, args.answer_function):
        if endpoint in ("ask", "query-chunks"):
            ap.error("refusing production endpoint: benchmark-only functions only")
    out = args.out or ("eval/runs/benchmark-%s.json" % args.run_id)
    if os.path.exists(out):
        ap.error("refusing to overwrite existing artifact: %s" % out)

    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    anon = os.environ["SUPABASE_ANON_KEY"]
    access = args.token or os.environ.get("RAG4I_EVAL_JWT", "")
    refresh = (args.refresh_token
               or os.environ.get("RAG4I_EVAL_REFRESH_TOKEN", "")
               or base._stored_refresh_token())
    if not access:
        ap.error("no access token: pass --token or set RAG4I_EVAL_JWT (never commit tokens)")
    auth = base._Auth(access, refresh)
    gold = json.load(open(args.cases, encoding="utf-8"))["cases"]
    mapping = json.load(open(args.mapping, encoding="utf-8"))["cases"]

    def authed(fn):
        return base.authed_call(fn, auth, base_url, anon, args.tenant, None)

    # Corpus document count feeds the clarification gate exactly as in
    # production (read-only count, no content).
    def corpus_doc_count(b, a, tok, tenant, _query):
        req = urllib.request.Request(
            b + "/rest/v1/documents?tenant_id=eq.%s&select=id" % tenant,
            headers={"apikey": a, "Authorization": "Bearer " + tok},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return 200, len(json.loads(r.read().decode()))

    try:
        corpus_docs = authed(corpus_doc_count)[1]
    except Exception as e:  # noqa: BLE001
        print("could not read corpus document count: %s" % str(e)[:200])
        return 2

    results = []
    runner_start = datetime.datetime.now(datetime.timezone.utc)
    for i, case in enumerate(gold):
        cid = case["id"]
        expected = mapping.get(cid, {}).get("chunk_ids", [])
        try:
            rhttp, rev = authed(lambda b, a, t, tn, q: retrieve_benchmark(
                b, a, t, tn, case["question"], args.function, args.provider,
                args.model, args.run_id))
            time.sleep(args.sleep / 2.0)
        except base._AuthFailure:
            results.append({
                "case_id": cid,
                "http": 401,
                "auth_error": "unauthorized: access token rejected and no usable refresh token",
                **base.null_observability(case),
            })
            continue
        except Exception as e:  # noqa: BLE001 - record transport failures honestly
            rec = {"case_id": cid, "http": -1, "transport_error": str(e)[:200],
                   **base.null_observability(case)}
            if isinstance(e, urllib.error.HTTPError):
                rec["http"] = e.code
                detail = base.error_detail(e)
                if detail:
                    rec["error_detail"] = detail
            results.append(rec)
            continue

        if not isinstance(rev, dict) or not rev.get("ok"):
            results.append({
                "case_id": cid,
                "http": rhttp,
                "retrieval_error": str((rev or {}).get("error", "unknown"))[:200],
                **base.null_observability(case),
            })
            continue

        # Conditions A and B share the single fused pool from this one call.
        # Retrieval telemetry is persisted per case so embedding, RPC/fusion,
        # and rerank stages stay separable in analysis.
        retrieval_ms = ((rev.get("timings") or {}).get("total_ms")
                        if isinstance(rev.get("timings"), dict) else None)
        rev_timings = rev.get("timings") if isinstance(rev.get("timings"), dict) else {}
        case_rec = {
            "case_id": cid,
            "category": case.get("category"),
            "http": rhttp,
            "question": case.get("question"),
            "expected": base.expected_block(case),
            "expected_chunks": len(expected),
            "retrieval": {
                "query_tokens": rev.get("query_tokens"),
                "rerank_usage_tokens": rev.get("rerank_usage_tokens"),
                "candidates": rev.get("candidates"),
                "timings": {
                    "embed_ms": rev_timings.get("embed_ms"),
                    "retrieval_ms": rev_timings.get("retrieval_ms"),
                    "fusion_ms": rev_timings.get("fusion_ms"),
                    "rerank_ms": rev_timings.get("rerank_ms"),
                    "total_ms": rev_timings.get("total_ms"),
                },
            },
            "conditions": {},
        }
        for reranker, ev_key in (("none", "evidence"),
                                 ("jina-reranker-v3.5", "evidence_reranked")):
            ev_list = rev.get(ev_key, []) or []
            ev_items = []
            for e in ev_list:
                proj = base.project_evidence(e)
                if proj.get("chunk_id"):
                    ev_items.append(proj)
            try:
                ahttp, ans = authed(lambda b, a, t, tn, q: answer_benchmark(
                    b, a, t, tn, case["question"], ev_list, args.answer_function,
                    args.provider, args.model, reranker, args.run_id,
                    corpus_docs, retrieval_ms))
            except base._AuthFailure:
                case_rec["conditions"][reranker] = {
                    "http": 401, "auth_error": "unauthorized", **base.null_observability(case),
                }
                continue
            except Exception as e:  # noqa: BLE001
                rec = {"http": -1, "transport_error": str(e)[:200],
                       **base.null_observability(case)}
                if isinstance(e, urllib.error.HTTPError):
                    rec["http"] = e.code
                    detail = base.error_detail(e)
                    if detail:
                        rec["error_detail"] = detail
                case_rec["conditions"][reranker] = rec
                continue
            case_rec["conditions"][reranker] = score_condition(
                case, expected, ev_items, ahttp, ans)
        results.append(case_rec)
        a = case_rec["conditions"].get("none", {})
        b = case_rec["conditions"].get("jina-reranker-v3.5", {})
        print("%s http=%s A(hit=%s,mrr=%s) B(hit=%s,mrr=%s)" % (
            cid, rhttp, a.get("retrieval_hit"),
            ("%.3f" % a["mrr"]) if isinstance(a.get("mrr"), float) else "-",
            b.get("retrieval_hit"),
            ("%.3f" % b["mrr"]) if isinstance(b.get("mrr"), float) else "-"), flush=True)
        if i < len(gold) - 1:
            time.sleep(args.sleep)

    def summarize(condition):
        ok = [r for r in results
              if isinstance(r.get("conditions", {}).get(condition), dict)
              and r["conditions"][condition].get("http") == 200]
        return {
            "n": len(ok),
            "http_200": len(ok),
            "hit_rate": sum(1 for r in ok if r["conditions"][condition].get("retrieval_hit")) / len(ok) if ok else 0,
            "mean_recall@8": sum(r["conditions"][condition].get("recall@8", 0) or 0 for r in ok) / len(ok) if ok else 0,
            "mean_mrr": sum(r["conditions"][condition].get("mrr", 0) or 0 for r in ok) / len(ok) if ok else 0,
            "gate_match_rate": sum(1 for r in ok if r["conditions"][condition].get("gate_match")) / len(ok) if ok else 0,
            "label_match_rate": sum(1 for r in ok if r["conditions"][condition].get("label_match")) / len(ok) if ok else 0,
            "citations_ok_rate": sum(1 for r in ok if r["conditions"][condition].get("citations_ok")) / len(ok) if ok else 0,
        }

    run = {
        "run_id": args.run_id,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "runner_start": runner_start.isoformat(),
        "wall_clock_s": round(
            (datetime.datetime.now(datetime.timezone.utc) - runner_start).total_seconds(), 1),
        "git_commit": base.git_commit(),
        "cases_file": args.cases,
        "mapping_file": args.mapping,
        "embedding_provider": args.provider,
        "embedding_model": args.model,
        "rerankers": ["none", "jina-reranker-v3.5"],
        "retrieval_mode": "benchmark",
        "benchmark_run_id": args.run_id,
        "retrieval_endpoint": args.function,
        "answer_endpoint": args.answer_function,
        "dense_n": RETRIEVAL_DEFAULTS["dense_n"],
        "lexical_n": RETRIEVAL_DEFAULTS["lexical_n"],
        "candidate_cap": RETRIEVAL_DEFAULTS["candidate_cap"],
        "rrf_k": RETRIEVAL_DEFAULTS["rrf_k"],
        "final_k": RETRIEVAL_DEFAULTS["final_k"],
        "fusion": RETRIEVAL_DEFAULTS["fusion"],
        "population": load_population(args.population),
        "summary": {
            "no_rerank": summarize("none"),
            "reranked": summarize("jina-reranker-v3.5"),
        },
        "results": results,
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(run, f, indent=1)
    print("SUMMARY " + json.dumps(run["summary"]))
    print("wrote " + out)


if __name__ == "__main__":
    main()
