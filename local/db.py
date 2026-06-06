"""
SQLite sloj za lokalni backend — zamjenjuje Cognito (korisnici) i DynamoDB
(Diagnosis povijest) jednom lokalnom .db datotekom.

Tablice:
  users      — registrirani korisnici (email + bcrypt/pbkdf2 hash lozinke)
  sessions   — aktivni tokeni (Bearer) → user_id
  diagnoses  — spremljeni nalazi po korisniku
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

DB_PATH = Path(os.environ.get("DB_PATH", Path(__file__).parent / "vetdemo.db"))


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                email        TEXT UNIQUE NOT NULL,
                given_name   TEXT NOT NULL DEFAULT '',
                family_name  TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS diagnoses (
                id         TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                details    TEXT,
                keywords   TEXT,            -- JSON niz stringova
                report     TEXT,
                created_at TEXT NOT NULL
            );
            """
        )


def _now() -> str:
    # ISO 8601 (UTC) — kompatibilno s `new Date(createdAt)` na frontendu
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


# ---------- Korisnici ----------

def create_user(email: str, given_name: str, family_name: str, password_hash: str) -> dict:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO users (email, given_name, family_name, password_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (email.lower().strip(), given_name, family_name, password_hash, _now()),
        )
        user_id = cur.lastrowid
    return get_user_by_id(user_id)


def get_user_by_email(email: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.lower().strip(),)
        ).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def update_user_attributes(user_id: int, given_name: str, family_name: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET given_name = ?, family_name = ? WHERE id = ?",
            (given_name, family_name, user_id),
        )


def update_user_password(user_id: int, password_hash: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id)
        )


# ---------- Sesije ----------

def create_session(user_id: int) -> str:
    token = uuid.uuid4().hex + uuid.uuid4().hex
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, _now()),
        )
    return token


def get_user_by_token(token: str) -> dict | None:
    if not token:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
            (token,),
        ).fetchone()
    return dict(row) if row else None


def delete_session(token: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


# ---------- Dijagnoze (Diagnosis model) ----------

def create_diagnosis(user_id: int, details: str, keywords: list[str], report: str) -> dict:
    diag_id = uuid.uuid4().hex
    created_at = _now()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO diagnoses (id, user_id, details, keywords, report, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (diag_id, user_id, details, json.dumps(keywords or [], ensure_ascii=False), report, created_at),
        )
    return {
        "id": diag_id,
        "details": details,
        "keywords": keywords or [],
        "report": report,
        "createdAt": created_at,
    }


def list_diagnoses(user_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM diagnoses WHERE user_id = ? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
    return [
        {
            "id": r["id"],
            "details": r["details"],
            "keywords": json.loads(r["keywords"] or "[]"),
            "report": r["report"],
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


def delete_diagnosis(user_id: int, diag_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM diagnoses WHERE id = ? AND user_id = ?", (diag_id, user_id)
        )
