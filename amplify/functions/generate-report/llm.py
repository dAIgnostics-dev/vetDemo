"""
Lokalni LLM backend — kontaktira Ollama umjesto Amazon Bedrocka.

Koristi samo standardnu biblioteku (urllib), bez vanjskih ovisnosti, kako bi
"lambda" ostala obična Python datoteka koja se može pokrenuti lokalno.

Konfiguracija via env varijable:
  OLLAMA_HOST     — base URL Ollama servera (default: http://localhost:11434)
  OLLAMA_MODEL    — naziv modela (default: qwen2.5:7b-instruct)
  OLLAMA_TIMEOUT  — timeout u sekundama (default: 120)
"""

from __future__ import annotations

import json
import os
import urllib.request

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")
OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT", "120"))


def chat_json(
    system_prompt: str,
    user_prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.4,
    num_predict: int = 1000,
) -> str:
    """
    Pošalji chat upit Ollami i vrati sadržaj odgovora kao string.

    Postavlja `format: "json"` kako bi model vraćao strogo JSON izlaz
    (ekvivalent strogom JSON ugovoru koji je prije osiguravao Bedrock prompt).
    """
    payload = {
        "model": model or OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": temperature,
            "num_predict": num_predict,
        },
    }

    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Ne mogu kontaktirati Ollama server na {OLLAMA_HOST}. "
            f"Je li 'ollama serve' pokrenut i je li model '{model or OLLAMA_MODEL}' povučen? "
            f"Detalji: {e}"
        ) from e

    return data["message"]["content"]
