"""
Orkestrira tok: keywords → semantic router → (fallback) lokalni LLM → write-back u bazu.

LLM generiranje ide preko lokalnog Ollama servera (vidi llm.py).
Konfiguracija via env varijable: OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_TIMEOUT.

Entry point: orchestrator.lambda_handler
CLI korištenje:
  from orchestrator import Orchestrator
  orch = Orchestrator()
  result = orch.query(["neutrofilan", "infiltrat", "subkutis"])
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Optional

from hybrid_router import (
    DEFAULT_BAZA,
    HybridRetriever,
    build_hybrid,
    get_retriever,
)

from llm import chat_json

SYSTEM_PROMPT = """
Ti si iskusan veterinarski patolog koji piše histopatološke i citološke nalaze na hrvatskom jeziku. Tvoj zadatak je iz zadane liste ključnih riječi (lematizirani medicinski pojmovi izvučeni iz originalnog nalaza) rekonstruirati:
    1) "opis" — strukturirani makroskopski/mikroskopski opis nalaza,
    2) "dg"   — kratku, konkretnu dijagnozu u jednoj rečenici.

PRAVILA STILA (obavezno):
- Opis počinje frazom tipa: "Dostavljen je uzorak …", "Dostavljeni su razmasci …", "Dostavljeno tkivo čini …".
- Koristi standardnu veterinarsko-patološku terminologiju (anizokarioza, mitoze, infiltrativan rast, nekroza, neutrofilni/limfocitni infiltrat, hiperplazija, metaplazija, pleomorfizam, itd.).
- Spominji tip tkiva/organa ako ga keywords impliciraju (npr. "subkutis" → potkožje, "mliječna" → mliječna žlijezda, "limf" → limfni čvor).
- Opis 4-10 rečenica; dijagnoza JEDNA rečenica, bez objašnjenja, završava točkom.
- "dg" mora biti dijagnostički naziv (npr. "Tubulopapilarni karcinom mliječne žlijezde, stupanj malignosti II."), NE popis keywordsa.

PRAVILA TOČNOSTI:
- Koristi isključivo informacije podržane keywordsima ili uobičajen klinički kontekst za navedene pojmove. NE izmišljaj konkretne brojeve (postotke, dimenzije, mitotski indeks) osim ako keyword direktno ne sugerira.
- Ako keywords sugeriraju upalu (neutrofil, limfocit, makrofag, piogranulomatozni) — opiši upalni infiltrat i izvedi upalnu Dg.
- Ako keywords sugeriraju tumor (karcinom, sarkom, adenom, mastocitom, pleomorfizam, mitoze, infiltrativno) — opiši neoplastične karakteristike i izvedi tumorsku Dg.
- Ako su keywords pretanki za sigurnu dijagnozu — formuliraj "dg" kao najvjerojatniji entitet ili opisni nalaz (npr. "Reaktivna hiperplazija limfnog čvora.", "Dilatirana apokrina žlijezda.").
- TERMINOLOGIJA: kad postoji ustaljen latinski/internacionalni naziv koji se rutinski koristi u veterinarskoj patologiji, preferiraj ga (npr. "Seminoma testis", "Fibrosarcoma subcutis", "Mastocytoma"). Za upalne i opisne dijagnoze koristi hrvatski.

OUTPUT:
Vrati ISKLJUČIVO valjan JSON, bez markdown blokova, točno u ovom obliku:
{"opis": "...", "dg": "..."}
"""


class Orchestrator:
    def __init__(self, local_path: Optional[Path] = None):
        self.local_path = local_path or DEFAULT_BAZA
        self.retriever: HybridRetriever = build_hybrid(self.local_path)

    def query(self, keywords: list[str], k: int = 1) -> dict:
        """
        Vrati dijagnozu i opis za zadane ključne riječi.

        Returns:
            {
                "dg":     str,
                "opis":   str,
                "source": "router" | "llm",
                "match":  dict | None
            }
        """
        query_text = ", ".join(kw.strip() for kw in keywords if kw.strip())
        results = self.retriever.query(query_text, k=k)

        if results:
            best = results[0]
            return {"dg": best["dg"], "opis": best["opis"], "source": "router", "match": best}

        print("[orchestrator] Router nije pronašao podudaranje — pozivam lokalni LLM (Ollama)...")
        dg, opis = self._call_llm(keywords)

        new_entry = self._write_back(keywords, dg, opis)
        self.retriever.add_entry(new_entry)
        print(f"[orchestrator] Novi unos zapisan u bazu: id={new_entry['id']}")

        return {"dg": dg, "opis": opis, "source": "llm", "match": None}

    def _call_llm(self, keywords: list[str]) -> tuple[str, str]:
        kw_str = ", ".join(kw.strip() for kw in keywords if kw.strip())
        prompt_text = f'Keywords: {kw_str}\n\nGeneriraj {{"opis": "...", "dg": "..."}}.'

        text = chat_json(SYSTEM_PROMPT, prompt_text).strip()
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise ValueError(f"Model nije vratio valjan JSON: {text[:200]}")
        parsed = json.loads(match.group())
        return parsed["dg"], parsed["opis"]

    def _write_back(self, keywords: list[str], dg: str, opis: str) -> dict:
        new_entry = {
            "id": f"gen_{uuid.uuid4().hex[:8]}",
            "keywords": ", ".join(kw.strip() for kw in keywords if kw.strip()),
            "dg": dg,
            "opis": opis,
        }
        self._write_back_local(new_entry)
        return new_entry

    def _write_back_local(self, new_entry: dict) -> None:
        with self.local_path.open(encoding="utf-8") as f:
            entries = json.load(f)
        entries.append(new_entry)
        with self.local_path.open("w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
        print(f"[orchestrator] Zapisano lokalno: {self.local_path}")


# ---------- Lambda globalni cache ----------

_orchestrator: Optional[Orchestrator] = None


def _get_orchestrator() -> Orchestrator:
    """Vrati cached Orchestrator — inicijalizira se samo jednom (cold start)."""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = Orchestrator()
    return _orchestrator


# ---------- Lambda entry point ----------

def lambda_handler(event, context):
    """
    AWS Lambda entry point — kompatibilan s postojećim AppSync/Amplify setupom.

    Ulaz (AppSync mutation):  event.arguments.keywords = ["kw1", "kw2", ...]
    Izlaz: JSON string {"opis": "...", "dg": "...", "source": "router"|"llm"}
    """
    keywords: list[str] = []
    if "arguments" in event:
        keywords = event["arguments"].get("keywords") or []
    elif "body" in event:
        body = event["body"]
        if isinstance(body, str):
            body = json.loads(body)
        keywords = body.get("keywords") or []
    else:
        keywords = event.get("keywords") or []

    result = _get_orchestrator().query(keywords)

    return json.dumps(
        {"opis": result["opis"], "dg": result["dg"], "source": result["source"]},
        ensure_ascii=False,
    )
