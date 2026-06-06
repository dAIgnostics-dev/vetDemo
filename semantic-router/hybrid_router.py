"""
Hibridni retriever: BM25 pronalazi kandidate, lokalni LLM (Ollama) ih rerankirá.

Baza se učitava iz lokalnog baza.json fajla.

API:
  build_hybrid()  -> HybridRetriever
  retriever.query(text, k=5) -> [{id, opis, dg, keywords, score, llm_rank, bm25_rank}]
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

from llm import chat

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


DEFAULT_BAZA = Path(__file__).parent / "baza.json"

COMPONENT_TOP_K = 30

_STOPWORDS = {
    "a", "e", "i", "o", "u", "s", "z", "k", "n",
    "je", "se", "na", "su", "da", "za", "od", "do", "iz", "ili", "ali",
    "pa", "ni", "ne", "li", "što", "koji", "koja", "koje", "kao", "te",
    "sa", "po", "pri", "bez", "nad", "pod", "uz", "kroz", "prema",
    "između", "zbog", "osim", "oko", "nakon", "prije", "svi", "sve",
    "svaki", "svaka", "neka", "neki", "neke", "više", "manje", "može",
    "mogu", "biti", "ima", "imaju", "ovaj", "ova", "ovo", "taj", "ta",
    "to", "tog", "ovog", "ovim", "tim", "ovih", "tih", "ih", "im",
    "mu", "ga", "ju", "mi", "ti", "vi", "oni", "one", "ona",
    "sam", "si", "smo", "ste", "nisu", "nije", "bio", "bila", "bilo",
    "već", "još", "samo", "kada", "gdje", "kako", "zašto",
}


def tokenize(text: str) -> list[str]:
    text = re.sub(r"dg\..*", "", text, flags=re.IGNORECASE)
    tokens = re.findall(r"[A-Za-zčćžšđČĆŽŠĐ]+", text.lower())
    return [t for t in tokens if t not in _STOPWORDS and len(t) > 2]


# ---------- BM25 ----------

def _doc_text(entry: dict) -> str:
    parts: list[str] = []
    kw = (entry.get("keywords") or "").strip()
    if kw:
        parts.append(kw)
    dg = (entry.get("dg") or "").strip()
    if dg:
        parts.append(dg)
    return " ".join(parts)


class BM25:
    def __init__(self, docs_tokens: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.docs = docs_tokens
        self.N = len(docs_tokens)
        self.doc_lens = [len(d) for d in docs_tokens]
        self.avgdl = sum(self.doc_lens) / max(self.N, 1)

        df: Counter[str] = Counter()
        for tokens in docs_tokens:
            for t in set(tokens):
                df[t] += 1

        self.idf = {
            t: math.log((self.N - n + 0.5) / (n + 0.5) + 1.0) for t, n in df.items()
        }
        self.tf = [Counter(d) for d in docs_tokens]

    def scores(self, query_tokens: list[str]) -> list[float]:
        scores = [0.0] * self.N
        for q in query_tokens:
            idf = self.idf.get(q)
            if idf is None or idf <= 0:
                continue
            for i in range(self.N):
                f = self.tf[i].get(q, 0)
                if f == 0:
                    continue
                dl = self.doc_lens[i]
                denom = f + self.k1 * (1.0 - self.b + self.b * dl / self.avgdl)
                scores[i] += idf * (f * (self.k1 + 1.0)) / denom
        return scores


# ---------- LLM reranker (Ollama) ----------

class LLMReranker:
    def rerank(self, query: str, candidates: list[dict], k: int) -> list[str]:
        if not candidates:
            return []

        lines = []
        for i, c in enumerate(candidates, 1):
            dg = (c.get("dg") or "").strip()
            kw = (c.get("keywords") or "").strip()[:120]
            lines.append(f"[{i}] ID={c['id']} | Dg: {dg} | Keywords: {kw}")

        prompt = (
            f'Upit: "{query}"\n\n'
            "Sortiraj sljedeće veterinarskopatološke nalaze po relevantnosti za zadani upit. "
            f"Vrati SAMO JSON listu ID-ova (string vrijednosti), npr. [\"id1\", \"id2\"], "
            f"top {k} najrelevantnijih. "
            "Ako NIJEDAN kandidat nije medicinsko relevantno podudaranje za upit, vrati praznu listu []. "
            "Bez objašnjenja.\n\n"
            + "\n".join(lines)
        )

        text = chat(prompt, temperature=0.0, num_predict=256).strip()

        match = re.search(r"\[.*?\]", text, re.DOTALL)
        if match:
            try:
                ids = json.loads(match.group())
                valid = {c["id"] for c in candidates}
                return [str(i) for i in ids if str(i) in valid][:k]
            except (json.JSONDecodeError, TypeError):
                pass

        return []


# ---------- Učitavanje baze ----------

def _load_entries(local_path: Optional[Path] = None) -> list[dict]:
    """Učitaj unose iz lokalnog baza.json fajla."""
    path = local_path or DEFAULT_BAZA
    print(f"Učitavam bazu iz lokalnog fajla: {path}")
    with Path(path).open(encoding="utf-8") as f:
        return json.load(f)


# ---------- HybridRetriever ----------

class HybridRetriever:
    def __init__(self, entries: list[dict]):
        self.entries = entries
        self.id_to_entry: dict[str, dict] = {e["id"]: e for e in entries}

        print("Gradim BM25 komponentu...")
        self.docs_tokens = [tokenize(_doc_text(e)) for e in entries]
        self.bm25 = BM25(self.docs_tokens)

        print("Inicijaliziram LLM reranker (Ollama)...")
        self.reranker = LLMReranker()

    def add_entry(self, entry: dict) -> None:
        """Dodaj novi unos u in-memory retriever (bez ponovnog čitanja diska/S3)."""
        self.entries.append(entry)
        self.id_to_entry[entry["id"]] = entry
        self.docs_tokens.append(tokenize(_doc_text(entry)))
        self.bm25 = BM25(self.docs_tokens)

    def query(self, text: str, k: int = 5) -> list[dict]:
        toks = tokenize(text)
        bm25_scores = self.bm25.scores(toks)
        ranked_idx = sorted(enumerate(bm25_scores), key=lambda x: x[1], reverse=True)[:COMPONENT_TOP_K]

        candidates = []
        for bm25_rank, (idx, score) in enumerate(ranked_idx, 1):
            if score <= 0:
                break
            candidates.append({
                **self.entries[idx],
                "bm25_rank": bm25_rank,
                "bm25_score": score,
            })

        if not candidates:
            return []

        ranked_ids = self.reranker.rerank(text, candidates, k=k)

        bm25_by_id = {c["id"]: c for c in candidates}
        out: list[dict] = []
        for llm_rank, eid in enumerate(ranked_ids, 1):
            entry = self.id_to_entry.get(eid)
            if entry is None:
                continue
            bm = bm25_by_id.get(eid, {})
            out.append({
                "id": eid,
                "opis": entry.get("opis"),
                "dg": entry.get("dg"),
                "keywords": entry.get("keywords"),
                "score": 1.0 / llm_rank,
                "llm_rank": llm_rank,
                "bm25_rank": bm.get("bm25_rank"),
                "bm25_score": bm.get("bm25_score"),
            })
        return out


# ---------- Globalni cache za Lambda warm starts ----------

_retriever: Optional[HybridRetriever] = None


def get_retriever() -> HybridRetriever:
    """Vrati cached retriever (gradi samo na cold startu)."""
    global _retriever
    if _retriever is None:
        entries = _load_entries()
        _retriever = HybridRetriever(entries)
    return _retriever


def build_hybrid(local_path: Optional[Path] = None) -> HybridRetriever:
    """Izgradi novi retriever — za CLI korištenje ili testove."""
    entries = _load_entries(local_path=local_path)
    return HybridRetriever(entries)
