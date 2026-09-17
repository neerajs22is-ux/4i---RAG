"""One-time init: persist the evaluation refresh token in Windows
Credential Manager (DPAPI-backed, per-user, survives reboots).

Consumes the token WITHOUT displaying it:
  1. RAG4I_EVAL_REFRESH_TOKEN env var when already present (preferred: the
     value never touches the command line, history, or output), else
  2. a hidden getpass prompt (no echo).

Never prints the token. Writes only to the OS vault, never to disk/Git.
Usage (from repo root, in the shell that already holds the token):
  python eval/store_refresh_token.py
"""

import getpass
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wincred import TARGET, read_refresh_token, write_refresh_token


def main():
    secret = os.environ.get("RAG4I_EVAL_REFRESH_TOKEN", "")
    if secret:
        source = "environment"
    else:
        try:
            secret = getpass.getpass("RAG4I refresh token (hidden): ")
        except Exception:
            print("store: unable to read hidden input")
            return 2
        source = "prompt"
    if not secret:
        print("store: empty token, nothing stored")
        return 2
    if not write_refresh_token(secret):
        print("store: FAILED (Credential Manager unavailable)")
        return 1
    del secret
    if not read_refresh_token():
        print("store: FAILED (write reported ok but read-back empty)")
        return 1
    print("store: ok (source=%s, vault target=%s)" % (source, TARGET))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
