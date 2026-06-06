"""
Lokalni LLM backend (Ollama) za semantic-router CLI — zamjenjuje Amazon Bedrock.

Koristi samo standardnu biblioteku (urllib), bez vanjskih ovisnosti.

Konfiguracija via env varijable:
  OLLAMA_HOST     — base URL Ollama servera (default: http://localhost:11434)
  OLLAMA_MODEL    — naziv modela (default: qwen2.5:7b-instruct)
  OLLAMA_TIMEOUT  — timeout u sekundama (default: 120)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")
OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT", "120"))


def chat(
    user_prompt: str,
    *,
    system_prompt: str | None = None,
    model: str | None = None,
    temperature: float = 0.4,
    num_predict: int = 1000,
    force_json: bool = False,
) -> str:
    """Pošalji chat upit Ollami i vrati sadržaj odgovora kao string."""
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": model or OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": num_predict},
    }
    if force_json:
        payload["format"] = "json"

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


def chat_json(system_prompt: str, user_prompt: str, **kwargs) -> str:
    """Kao chat(), ali prisiljava JSON izlaz (format=json)."""
    return chat(user_prompt, system_prompt=system_prompt, force_json=True, **kwargs)
