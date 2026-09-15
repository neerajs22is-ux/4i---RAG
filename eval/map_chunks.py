"""Deterministic gold section/page -> production chunk mapper (Phase 3C.2).

Reads eval/cases/gold_cases.json and the production chunks table, and for
each case records every chunk that (a) sits on an expected source page and
(b) contains at least one signature token derived from the case's expected
key facts / answer. No guessing: cases with zero matches are reported as
UNRESOLVED and must be reviewed before the mapping is frozen.

Usage (never commit credentials):
  set DATABASE_URL=postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres
  python eval/map_chunks.py --document <doc-uuid> --out eval/mappings/chunk_map.json
"""

import argparse
import json
import os
import re
import sys
import urllib.parse

STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are",
    "was", "were", "it", "its", "this", "that", "for", "with", "as",
    "by", "at", "be", "from", "which", "what", "when", "where", "how",
    "than", "less", "more", "under", "any", "all", "each", "such",
}


def signature_tokens(case):
    toks = set()
    for text in list(case.get("expected_key_facts", [])) + [case.get("expected_answer", "")]:
        for w in re.findall(r"[a-z0-9]+", str(text).lower()):
            if len(w) >= 4 and w not in STOP:
                toks.add(w)
    return toks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--document", required=True)
    ap.add_argument("--cases", default="eval/cases/gold_cases.json")
    ap.add_argument("--out", default="eval/mappings/chunk_map.json")
    ap.add_argument("--chunks-json", default=None,
                    help="Alternative input: JSON array of {chunk_id, page, "
                         "content} (e.g. exported via the API), used instead "
                         "of a direct DATABASE_URL connection.")
    args = ap.parse_args()

    gold = json.load(open(args.cases, encoding="utf-8"))["cases"]
    if args.chunks_json:
        rows = [
            (c["chunk_id"], c["page"], c["content"])
            for c in json.load(open(args.chunks_json, encoding="utf-8"))
        ]
    else:
        try:
            import psycopg
        except ImportError:
            print("map_chunks requires psycopg (pip install psycopg[binary])", file=sys.stderr)
            return 2
        dsn = os.environ.get("DATABASE_URL", "")
        if not dsn:
            print("DATABASE_URL is not set", file=sys.stderr)
            return 2
        with psycopg.connect(dsn) as conn:
            rows = conn.execute(
                "SELECT chunk_id, page, content FROM public.chunks WHERE document_id = %s",
                (args.document,),
            ).fetchall()
    print("chunks loaded: %d" % len(rows))

    mapping = {"document_id": args.document, "cases": {}, "unresolved": []}
    for case in gold:
        pages = set(case.get("expected_source_pages", []) or [])
        if not pages:
            mapping["cases"][case["id"]] = {"chunk_ids": [], "note": "no source pages (refusal case)"}
            continue
        sigs = signature_tokens(case)
        hits = []
        for chunk_id, page, content in rows:
            if page not in pages:
                continue
            low = (content or "").lower()
            matched = sorted(s for s in sigs if s in low)
            if matched:
                hits.append({"chunk_id": chunk_id, "page": page, "matched": matched})
        hits.sort(key=lambda h: (h["page"], h["chunk_id"]))
        entry = {"chunk_ids": [h["chunk_id"] for h in hits], "detail": hits}
        if not hits:
            entry["note"] = "UNRESOLVED: no page+signature match"
            mapping["unresolved"].append(case["id"])
        mapping["cases"][case["id"]] = entry

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=1)
    print("cases: %d, unresolved: %s" % (len(mapping["cases"]), mapping["unresolved"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
