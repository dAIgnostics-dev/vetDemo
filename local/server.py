"""
Lokalni backend za dAIgnostics Studio.

Zamjenjuje AWS Amplify stack lokalnim HTTP servisom:
  - Cognito       → /auth/* (SQLite users + Bearer tokeni)
  - AppSync/DynamoDB → /diagnoses/* (SQLite)
  - Lambda (Bedrock) → /generate-report i /search-database
        pozivaju ISTU `orchestrator.lambda_handler` funkciju kao u oblaku,
        samo što ona sada kontaktira lokalni Ollama (vidi llm.py).

Pokretanje:  python local/server.py   (ili `make backend`)
"""

from __future__ import annotations

import functools
import json
import os
import sys
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

# --- Učini "lambda" funkciju uvozivom kao običnu Python datoteku ---
LAMBDA_DIR = Path(__file__).resolve().parent.parent / "amplify" / "functions" / "generate-report"
sys.path.insert(0, str(LAMBDA_DIR))

import orchestrator  # noqa: E402  (lambda kod — orchestrator.lambda_handler)

import db  # noqa: E402

app = Flask(__name__)
CORS(app)  # dopusti pozive s Vite dev servera (localhost:5173)

PORT = int(os.environ.get("PORT", "8000"))


# ---------- Pomoćne funkcije za autentikaciju ----------

def _current_user() -> dict | None:
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    return db.get_user_by_token(token)


def require_auth(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        user = _current_user()
        if not user:
            return jsonify({"error": "Unauthorized"}), 401
        return fn(user, *args, **kwargs)

    return wrapper


def _user_attrs(user: dict) -> dict:
    """Oblik koji frontend očekuje od fetchUserAttributes()."""
    return {
        "email": user["email"],
        "given_name": user["given_name"],
        "family_name": user["family_name"],
    }


# ---------- Health ----------

@app.get("/health")
def health():
    return jsonify({"status": "ok"})


# ---------- Auth ----------

@app.post("/auth/register")
def register():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    given_name = (body.get("given_name") or "").strip()
    family_name = (body.get("family_name") or "").strip()

    if not email or not password:
        return jsonify({"error": "Email i lozinka su obavezni."}), 400
    if not given_name or not family_name:
        return jsonify({"error": "Ime i prezime su obavezni."}), 400
    if db.get_user_by_email(email):
        return jsonify({"error": "Korisnik s tim emailom već postoji."}), 409

    user = db.create_user(email, given_name, family_name, generate_password_hash(password))
    token = db.create_session(user["id"])
    return jsonify({"token": token, "attributes": _user_attrs(user)})


@app.post("/auth/login")
def login():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    user = db.get_user_by_email(email)
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Neispravan email ili lozinka."}), 401

    token = db.create_session(user["id"])
    return jsonify({"token": token, "attributes": _user_attrs(user)})


@app.post("/auth/logout")
@require_auth
def logout(user):
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    db.delete_session(token)
    return jsonify({"ok": True})


@app.get("/auth/me")
@require_auth
def me(user):
    return jsonify(_user_attrs(user))


@app.put("/auth/attributes")
@require_auth
def update_attributes(user):
    body = request.get_json(force=True) or {}
    given_name = (body.get("given_name") or user["given_name"]).strip()
    family_name = (body.get("family_name") or user["family_name"]).strip()
    db.update_user_attributes(user["id"], given_name, family_name)
    return jsonify(_user_attrs(db.get_user_by_id(user["id"])))


@app.post("/auth/password")
@require_auth
def change_password(user):
    body = request.get_json(force=True) or {}
    old_password = body.get("oldPassword") or ""
    new_password = body.get("newPassword") or ""

    if not check_password_hash(user["password_hash"], old_password):
        return jsonify({"error": "Trenutna lozinka nije ispravna."}), 400
    if len(new_password) < 6:
        return jsonify({"error": "Nova lozinka mora imati barem 6 znakova."}), 400

    db.update_user_password(user["id"], generate_password_hash(new_password))
    return jsonify({"ok": True})


# ---------- Diagnosis povijest (AppSync/DynamoDB zamjena) ----------

@app.get("/diagnoses")
@require_auth
def list_diagnoses(user):
    return jsonify({"data": db.list_diagnoses(user["id"])})


@app.post("/diagnoses")
@require_auth
def create_diagnosis(user):
    body = request.get_json(force=True) or {}
    diag = db.create_diagnosis(
        user["id"],
        body.get("details") or "",
        body.get("keywords") or [],
        body.get("report") or "",
    )
    return jsonify({"data": diag})


@app.delete("/diagnoses/<diag_id>")
@require_auth
def delete_diagnosis(user, diag_id):
    db.delete_diagnosis(user["id"], diag_id)
    return jsonify({"ok": True})


# ---------- LLM / Router (Lambda zamjena) ----------

@app.post("/accept-generated")
@require_auth
def accept_generated(user):
    """Spremi LLM-generirani nalaz u baza.json (samo kad korisnik klikne Prihvati)."""
    body = request.get_json(force=True) or {}
    keywords = [k for k in (body.get("keywords") or []) if str(k).strip()]
    dg = (body.get("dg") or "").strip()
    opis = (body.get("opis") or "").strip()
    if not dg or not opis:
        return jsonify({"error": "dg i opis su obavezni"}), 400
    try:
        orch = orchestrator._get_orchestrator()
        new_entry = orch._write_back(keywords, dg, opis)
        orch.retriever.add_entry(new_entry)
        return jsonify({"ok": True, "id": new_entry["id"]})
    except Exception as e:
        app.logger.exception("accept-generated failed")
        return jsonify({"errors": [{"message": str(e)}]}), 500

def _keywords_from_request() -> list[str]:
    body = request.get_json(force=True) or {}
    return [k for k in (body.get("keywords") or []) if str(k).strip()]


@app.post("/generate-report")
@require_auth
def generate_report(user):
    """Poziva lambda_handler kao AppSync mutation generateReport."""
    event = {"arguments": {"keywords": _keywords_from_request()}}
    try:
        result_json = orchestrator.lambda_handler(event, None)  # vraća JSON string
        return app.response_class(
            json.dumps({"data": result_json}), mimetype="application/json"
        )
    except Exception as e:  # noqa: BLE001
        app.logger.exception("generate-report failed")
        return jsonify({"errors": [{"message": str(e)}]}), 500


@app.post("/search-database")
@require_auth
def search_database(user):
    """Poziva lambda_handler kao AppSync mutation searchDatabase (action=search)."""
    event = {"arguments": {"keywords": _keywords_from_request(), "action": "search"}}
    try:
        result_json = orchestrator.lambda_handler(event, None)
        return app.response_class(
            json.dumps({"data": result_json}), mimetype="application/json"
        )
    except Exception as e:  # noqa: BLE001
        app.logger.exception("search-database failed")
        return jsonify({"errors": [{"message": str(e)}]}), 500


if __name__ == "__main__":
    db.init_db()
    backend = os.environ.get("LLM_BACKEND", "ollama")
    model = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")
    print(f"[server] dAIgnostics local backend → http://localhost:{PORT}")
    print(f"[server] LLM backend: {backend} (model: {model})")
    app.run(host="0.0.0.0", port=PORT, debug=False)
