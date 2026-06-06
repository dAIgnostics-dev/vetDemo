"""
Interaktivni CLI nad Orchestratorom.

Pokretanje:
  python cli.py                        # interaktivni prompt
  python cli.py "limfocit, makrofag"   # jedan upit pa izlaz

Naredbe u interaktivnom modu:
  /v        toggle verbose (prikazuje llm_rank, bm25_rank, keywords)
  /q        izlaz
"""

from __future__ import annotations

import sys

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from orchestrator import Orchestrator


def _print_result(result: dict, verbose: bool) -> None:
    source_tag = "[router]" if result["source"] == "router" else "[llm→baza]"
    print(f"\n  {source_tag}")
    print(f"  Dg:   {result['dg']}")
    print(f"  Opis: {result['opis'][:200]}{'...' if len(result['opis']) > 200 else ''}")

    if verbose and result["match"]:
        m = result["match"]
        print(
            f"  llm_rank={m.get('llm_rank')}  "
            f"bm25_rank={m.get('bm25_rank')}  "
            f"id={m.get('id')}"
        )
        kw = (m.get("keywords") or "").strip()
        if kw:
            print(f"  kw: {kw[:140]}")


def main() -> None:
    orch = Orchestrator()

    if len(sys.argv) > 1:
        keywords = [kw.strip() for kw in " ".join(sys.argv[1:]).split(",")]
        print(f"\nUpit: {keywords}")
        _print_result(orch.query(keywords), verbose=False)
        return

    verbose = False
    print("\n" + "=" * 60)
    print("Interaktivni mod. Upiši ključne riječi odvojene zarezima.")
    print("Naredbe: /v (verbose), /q (izlaz)")
    print("=" * 60)

    while True:
        try:
            line = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return

        if not line:
            continue
        if line in ("/q", "exit", "quit"):
            return
        if line == "/v":
            verbose = not verbose
            print(f"verbose = {verbose}")
            continue

        keywords = [kw.strip() for kw in line.split(",") if kw.strip()]
        if not keywords:
            continue

        _print_result(orch.query(keywords), verbose=verbose)


if __name__ == "__main__":
    main()
