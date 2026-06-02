"""
BM25 retriever za veterinarsku patologiju.

Podržava učitavanje baze iz lokalnog fajla (CLI) ili S3 (Lambda).
Konfiguracija via env varijable:
  BAZA_S3_BUCKET  — S3 bucket za bazu (ako nije postavljen, koristi lokalni fajl)
  BAZA_S3_KEY     — S3 ključ (default: semantic-router/baza.json)
  BEDROCK_REGION  — region za Bedrock pozive (default: us-east-1)

API:
  build_hybrid()  -> HybridRetriever   (koristi env var konfiguraciju)
  retriever.query(text, k=5) -> [{id, opis, dg, keywords, score, bm25_rank}]
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

import boto3

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


DEFAULT_BAZA = Path(__file__).parent / "baza.json"

# Bedrock cross-region inference — Lambda je u eu-north-1, Bedrock u us-east-1
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
# S3 konfiguracija — postavlja se u Lambda env varijablama
S3_BUCKET = os.environ.get("BAZA_S3_BUCKET")
S3_KEY = os.environ.get("BAZA_S3_KEY", "semantic-router/baza.json")

COMPONENT_TOP_K = 30
DEFAULT_TOP_K = 5
MIN_BM25_SCORE = 1.5

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


# ---------- Učitavanje baze ----------

def _load_entries(
    local_path: Optional[Path] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
) -> list[dict]:
    """Učitaj unose iz S3 (Lambda) ili lokalnog fajla (CLI)."""
    bucket = s3_bucket or S3_BUCKET
    if bucket:
        key = s3_key or S3_KEY
        print(f"Učitavam bazu iz S3: s3://{bucket}/{key}")
        s3 = boto3.client("s3")
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read().decode("utf-8"))

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

    def add_entry(self, entry: dict) -> None:
        """Dodaj novi unos u in-memory retriever (bez ponovnog čitanja diska/S3)."""
        self.entries.append(entry)
        self.id_to_entry[entry["id"]] = entry
        self.docs_tokens.append(tokenize(_doc_text(entry)))
        self.bm25 = BM25(self.docs_tokens)

    def query(self, text: str, k: int = DEFAULT_TOP_K) -> list[dict]:
        toks = tokenize(text)
        bm25_scores = self.bm25.scores(toks)
        ranked_idx = sorted(enumerate(bm25_scores), key=lambda x: x[1], reverse=True)[:k]

        out: list[dict] = []
        for rank, (idx, score) in enumerate(ranked_idx, 1):
            if score < MIN_BM25_SCORE:
                break
            entry = self.entries[idx]
            out.append({
                "id": entry["id"],
                "opis": entry.get("opis"),
                "dg": entry.get("dg"),
                "keywords": entry.get("keywords"),
                "score": score,
                "bm25_rank": rank,
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
