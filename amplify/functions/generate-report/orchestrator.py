"""
Orkestrira tok: keywords → semantic router (BM25) → (fallback) lokalni LLM → write-back u bazu.

LLM generiranje ide isključivo preko lokalnog Ollama servera (vidi llm.py).
Konfiguracija via env varijable (vidi llm.py): OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_TIMEOUT.

Lambda entry point: orchestrator.lambda_handler
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
from report_templates import build_structure_guidance


def _strip_dg_suffix(opis: str) -> str:
    """Ukloni 'Dg.:...' s kraja opisa ako postoji (duplikat jer se dg prikazuje odvojeno)."""
    return re.split(r'\s*\n\s*\nDg\.', opis, flags=re.IGNORECASE)[0].strip()

SYSTEM_PROMPT = """
Ti si iskusan veterinarski patolog koji piše histopatološke i citološke nalaze na hrvatskom jeziku. Tvoj zadatak je iz zadane liste ključnih riječi (lematizirani medicinski pojmovi izvučeni iz originalnog nalaza) rekonstruirati:
    1) "opis" — strukturirani makroskopski/mikroskopski opis nalaza,
    2) "dg"   — kratku, konkretnu dijagnozu u jednoj rečenici.

PRAVILA STILA (obavezno):
- Uz keywords dobit ćeš STRUKTURU NALAZA (ECVP deskriptivna tehnika) — obavezno slijedi taj redoslijed i sadržaj rečenica. Uključi samo one elemente strukture koje ključne riječi podržavaju ili proizlaze iz uobičajenog kliničkog konteksta; preskoči one bez podloge (NE izmišljaj).
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

    def search(self, keywords: list[str], k: int = 5) -> dict:
        """
        Pretraži samo bazu (bez LLM fallbacka).

        Returns:
            {
                "source":  "router" | "none",
                "results": [{"dg": str, "opis": str}, ...]
            }
        """
        query_text = ", ".join(kw.strip() for kw in keywords if kw.strip())
        matches = self.retriever.query(query_text, k=k)
        if matches:
            return {
                "source": "router",
                "results": [{"dg": m["dg"], "opis": _strip_dg_suffix(m["opis"] or "")} for m in matches],
            }
        print("[orchestrator] Router nije pronašao podudaranje — search_only mod, nema fallbacka.")
        return {"source": "none", "results": []}

    def query(self, keywords: list[str]) -> dict:
        """
        Generiraj nalaz direktno putem lokalnog LLM-a (bez pretraživanja baze).

        Returns:
            {
                "source":  "llm",
                "results": [{"dg": str, "opis": str}]
            }
        """
        print("[orchestrator] Generiram nalaz putem lokalnog LLM-a (Ollama)...")
        dg, opis = self._call_llm(keywords)
        return {"source": "llm", "results": [{"dg": dg, "opis": opis}]}

    def _call_llm(self, keywords: list[str]) -> tuple[str, str]:
        kw_str = ", ".join(kw.strip() for kw in keywords if kw.strip())
        # ECVP šablona (tumor vs ne-tumor) — daje strukturu koju nalaz mora slijediti.
        guidance = build_structure_guidance(keywords)
        prompt_text = (
            f"Keywords: {kw_str}\n\n"
            f"{guidance}\n\n"
            'Generiraj {"opis": "...", "dg": "..."}.'
        )

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
        # Pišemo natrag u stvarni baza.json kako bi novi nalazi odmah postali
        # pretraživi (BM25). Ako pisanje ne uspije (npr. read-only FS), ne rušimo
        # generiranje — nalaz je već vraćen klijentu.
        try:
            with self.local_path.open(encoding="utf-8") as f:
                entries = json.load(f)
            entries.append(new_entry)
            with self.local_path.open("w", encoding="utf-8") as f:
                json.dump(entries, f, ensure_ascii=False, indent=2)
            print(f"[orchestrator] Zapisano u {self.local_path} ({len(entries)} unosa)")
        except OSError as e:
            print(f"[orchestrator] Upozorenje: write-back u {self.local_path} nije uspio: {e}")


# ---------- Globalni cache ----------

_orchestrator: Optional[Orchestrator] = None


def _get_orchestrator() -> Orchestrator:
    """Vrati cached Orchestrator — inicijalizira se samo jednom (cold start)."""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = Orchestrator(local_path=DEFAULT_BAZA)
    return _orchestrator


# ---------- Entry point ----------

def lambda_handler(event, context):
    """
    Entry point — kompatibilan s oblikom poziva koji koristi lokalni backend
    (i nekadašnji AppSync/Amplify setup).

    Ulaz:  event.arguments.keywords = ["kw1", "kw2", ...]
    Izlaz: JSON string {"source": "router"|"none"|"llm", "results": [...]}
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

    action = ""
    if "arguments" in event:
        action = event["arguments"].get("action") or ""
    if not action:
        action = event.get("info", {}).get("fieldName", "")

    if action == "search" or action == "searchDatabase":
        result = _get_orchestrator().search(keywords)
    else:
        result = _get_orchestrator().query(keywords)

    return json.dumps(result, ensure_ascii=False)
