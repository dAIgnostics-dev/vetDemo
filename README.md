# 🩺 dAIgnostics Studio — Local

> AI-powered veterinary narrative report generator, running **fully locally**.

dAIgnostics Studio helps veterinary professionals instantly generate structured,
professional Croatian pathology reports (`opis` + `dijagnoza`) from clinical
keywords. This is the **local edition**: the original AWS Amplify / Cognito /
AppSync / Bedrock stack has been replaced with a self-contained local stack that
runs on a single machine — no cloud account required.

- **Frontend** — the original React + Vite SPA, unchanged in look & behaviour.
- **Backend** — a small local Flask server ([local/server.py](local/server.py)) that replaces Cognito (auth), AppSync/DynamoDB (history), and the Lambda invocation.
- **LLM** — generation runs against a **local [Ollama](https://ollama.com) model** instead of Amazon Bedrock.

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Makefile Targets](#makefile-targets)
- [Switching Ollama Models](#switching-ollama-models)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Backend API](#backend-api)
- [Project Structure](#project-structure)
- [Features](#features)
- [Legacy AWS Code](#legacy-aws-code)
- [License](#license)

---

## Architecture

```
Browser (React + Vite)  ── http ──►  Flask backend (local/server.py)  ── http ──►  Ollama
  src/App.jsx                          ├── /auth/*        → SQLite (users, sessions)
  src/local/api.js                     ├── /diagnoses     → SQLite (saved reports)
  src/local/Authenticator.jsx          ├── /generate-report ┐
                                       └── /search-database ┘→ orchestrator.lambda_handler
                                                                ├── BM25 router (baza.json)
                                                                └── LLM generation (Ollama)
```

Everything runs on `localhost`:

| Component | Tech | Port |
|---|---|---|
| Frontend | React 18 + Vite | `5173` |
| Backend | Python + Flask | `8000` |
| LLM | Ollama | `11434` |
| Auth + history | SQLite (`local/vetdemo.db`) | — |

The "lambda" really does run as a plain Python file: the Flask server imports
`amplify/functions/generate-report/orchestrator.py` and calls its
`lambda_handler(event, context)` directly — the same entry point the cloud used.

---

## Prerequisites

- **Node.js 20+** and npm
- **Python 3.10+**
- **[Ollama](https://ollama.com/download)** installed and running (`ollama serve`)

Check everything at once:

```bash
make check
```

---

## Quick Start

```bash
# 1. Install backend (venv), frontend (npm), and pull the default Ollama model
make install

# 2. Run backend + frontend together (Ctrl-C stops both)
make run
```

Then open **http://localhost:5173**, register a local account, and start generating.

> First generation is slow (~30–60 s) while Ollama loads the model into memory.
> Subsequent calls are much faster (the model stays warm).

Prefer two terminals? Run them separately:

```bash
make backend     # terminal 1 — Flask on :8000
make frontend    # terminal 2 — Vite on :5173
```

---

## Makefile Targets

| Target | What it does |
|---|---|
| `make install` | Backend venv + deps, `npm install`, and `ollama pull` the default model |
| `make run` | Start backend + frontend together |
| `make backend` | Start only the Flask backend (`:8000`) |
| `make frontend` | Start only the Vite dev server (`:5173`) |
| `make model` | Pull the configured Ollama model |
| `make check` | Verify prerequisites (python, node, ollama) + list installed models |
| `make clean` | Remove venv, `node_modules`, and the local SQLite DB |

---

## Switching Ollama Models

Generation quality and speed depend entirely on which Ollama model you point at.
Switching is quick.

### 1. See what's installed

```bash
ollama list
```

### 2. Pull a model you want to try

```bash
ollama pull gemma2:9b
```

### 3. Run with that model

The `OLLAMA_MODEL` variable flows through the Makefile, so just override it:

```bash
make run OLLAMA_MODEL=gemma2:9b
# or for the backend alone:
make backend OLLAMA_MODEL=qwen2.5:14b-instruct
```

Or set it permanently in `local/.env` (copy from [local/.env.example](local/.env.example)):

```bash
OLLAMA_MODEL=gemma2:9b
```

> The model name is read when the backend starts, so **restart the backend**
> after changing it.

### Suggested models

The default is **`qwen2.5:7b-instruct`** — the best balance of Croatian fluency
and strict JSON output among small local models, and the closest match to the
original cloud model (Claude Haiku 4.5).

| Model | Pull | Size | Notes |
|---|---|---|---|
| **`qwen2.5:7b-instruct`** ⭐ | `ollama pull qwen2.5:7b-instruct` | ~4.7 GB | **Default.** Great Croatian + JSON adherence. Best all-round 7B. |
| `qwen2.5:14b-instruct` | `ollama pull qwen2.5:14b-instruct` | ~9 GB | Noticeably higher quality; slower; needs more RAM/VRAM. |
| `gemma2:9b` | `ollama pull gemma2:9b` | ~5.5 GB | Strong multilingual, good Croatian, solid JSON. |
| `mistral-nemo:12b` | `ollama pull mistral-nemo:12b` | ~7 GB | Good European-language coverage. |
| `mistral:7b` | `ollama pull mistral:7b` | ~4.4 GB | Decent, lighter; Croatian a notch below qwen. |
| `llama3.1:8b` | `ollama pull llama3.1:8b` | ~4.7 GB | Solid general-purpose, reliable JSON mode. |
| `llama3.2:3b` | `ollama pull llama3.2:3b` | ~2 GB | **Fastest / lowest RAM.** Use on weak hardware; quality drops. |

**Rules of thumb**
- Weak laptop / no GPU → `llama3.2:3b` or `mistral:7b`.
- Balanced default → `qwen2.5:7b-instruct`.
- Best quality, decent GPU → `qwen2.5:14b-instruct` or `gemma2:9b`.

If a model occasionally returns malformed JSON, prefer the `qwen2.5` or
`llama3.1` families — they follow the `format: json` constraint most reliably.

---

## Configuration

**Backend** — environment variables (see [local/.env.example](local/.env.example)):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Backend HTTP port |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model used for generation |
| `OLLAMA_TIMEOUT` | `120` | Per-request timeout (seconds) |
| `DB_PATH` | `local/vetdemo.db` | SQLite database file |

**Frontend** — see [.env.example](.env.example):

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:8000` | Backend base URL |

---

## How It Works

1. The frontend ([src/App.jsx](src/App.jsx)) talks to the backend through
   [src/local/api.js](src/local/api.js), which mirrors the old Amplify client
   surface (`client.models`, `client.mutations`, auth helpers) so the app code is
   essentially unchanged.
2. **Search** (`/search-database`) runs a pure-Python **BM25** retriever over
   [baza.json](amplify/functions/generate-report/baza.json) — no LLM involved.
3. **Generate** (`/generate-report`) calls the local LLM via
   [llm.py](amplify/functions/generate-report/llm.py) (Ollama `/api/chat` with
   `format: json`), producing `{"opis": ..., "dg": ...}`. New generations are
   appended back into `baza.json` so they become searchable.
4. Auth and saved-report history live in a local SQLite file.

---

## Backend API

All `/auth/me`, `/diagnoses/*`, `/generate-report`, `/search-database` require a
`Authorization: Bearer <token>` header (token returned by login/register).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/register` | Create account → `{ token, attributes }` |
| `POST` | `/auth/login` | Log in → `{ token, attributes }` |
| `POST` | `/auth/logout` | Invalidate token |
| `GET` | `/auth/me` | Current user attributes |
| `PUT` | `/auth/attributes` | Update first/last name |
| `POST` | `/auth/password` | Change password |
| `GET` | `/diagnoses` | List saved reports |
| `POST` | `/diagnoses` | Save a report |
| `DELETE` | `/diagnoses/:id` | Delete a report |
| `POST` | `/generate-report` | Generate via Ollama |
| `POST` | `/search-database` | BM25 search of `baza.json` |
| `GET` | `/health` | Health check |

---

## Project Structure

```
vetDemo/
├── Makefile                      # install / run / backend / frontend / model
├── local/                        # local backend (replaces AWS)
│   ├── server.py                 # Flask app: auth, history, generate, search
│   ├── db.py                     # SQLite (users, sessions, diagnoses)
│   ├── requirements.txt          # flask, flask-cors
│   └── .env.example
├── amplify/functions/generate-report/
│   ├── orchestrator.py           # lambda_handler — BM25 router + LLM generation
│   ├── hybrid_router.py          # BM25 retriever over baza.json
│   ├── llm.py                    # Ollama client (urllib, no deps)
│   ├── baza.json                 # report corpus (search + few-shot)
│   └── handler.py / handler.ts   # alternate single-shot entry points (Ollama)
├── semantic-router/              # standalone dev CLI (also Ollama-based)
│   ├── cli.py  orchestrator.py  hybrid_router.py  llm.py
├── src/
│   ├── App.jsx                   # main UI (unchanged behaviour)
│   ├── local/api.js              # backend client (Amplify-shaped)
│   ├── local/Authenticator.jsx   # local login / register
│   ├── translations.js  index.css  App.css
└── index.html  vite.config.js  package.json
```

---

## Features

| Feature | Description |
|---|---|
| 🤖 AI Report Generation | Local Ollama model generates Croatian `opis` + `dijagnoza` |
| 🔎 Database Search | BM25 retrieval over the curated `baza.json` corpus |
| 🔐 Local Authentication | Email + password, stored hashed in local SQLite |
| 📋 Diagnosis History | Per-user saved reports |
| 📄 PDF Export | Client-side PDF via jsPDF + html2canvas |
| ✏️ Editable Reports | Edit `opis`/`dg` before saving or exporting |
| 👤 Profile Management | Update name, change password |
| 🌐 Bilingual UI | English / Croatian, persisted in localStorage |

---

## Legacy AWS Code

The `amplify/` directory still contains the original Gen 2 backend definitions
(`auth/`, `data/`, `backend.ts`, `resource.ts`). They are **not used** by the
local stack and all Bedrock calls have been removed. They are kept only as a
reference for the original cloud deployment and can be deleted if you never plan
to deploy to AWS.

---

## License

© 2026 Daignostics d.o.o. All rights reserved.

This software is proprietary and confidential. Unauthorised copying,
modification, distribution, or use of this software, via any medium, is strictly
prohibited.
