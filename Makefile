# dAIgnostics Studio — lokalni razvoj (frontend + backend + Ollama)
#
# Brzi start:
#   make install      # instaliraj sve ovisnosti + povuci Ollama model
#   make run          # pokreni backend + frontend zajedno
#
# Pojedinačno:
#   make backend      # samo Python/Flask backend (port 8000)
#   make frontend     # samo Vite dev server (port 5173)

SHELL := /bin/bash

# --- Konfiguracija ---
VENV        := local/.venv
PY          := $(VENV)/bin/python
PIP         := $(VENV)/bin/pip
OLLAMA_MODEL ?= qwen2.5:7b-instruct
PORT        ?= 8000

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "dAIgnostics Studio — lokalni razvoj"
	@echo ""
	@echo "  make install      Instaliraj backend (venv), frontend (npm) i povuci Ollama model"
	@echo "  make run          Pokreni backend + frontend zajedno"
	@echo "  make backend      Pokreni samo Flask backend (port $(PORT))"
	@echo "  make frontend     Pokreni samo Vite dev server (port 5173)"
	@echo "  make model        Povuci Ollama model ($(OLLAMA_MODEL))"
	@echo "  make check        Provjeri preduvjete (python, node, ollama)"
	@echo "  make clean        Obriši venv, node_modules i lokalnu bazu"
	@echo ""

# --- Instalacija ---
.PHONY: install
install: install-backend install-frontend model
	@echo "✅ Instalacija gotova. Pokreni:  make run"

.PHONY: install-backend
install-backend:
	@echo "==> Backend (Python venv + Flask)"
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip >/dev/null
	$(PIP) install -r local/requirements.txt

.PHONY: install-frontend
install-frontend:
	@echo "==> Frontend (npm install)"
	npm install

.PHONY: model
model:
	@echo "==> Povlačim Ollama model: $(OLLAMA_MODEL)"
	@command -v ollama >/dev/null 2>&1 || { echo "❌ 'ollama' nije instaliran. Vidi https://ollama.com/download"; exit 1; }
	ollama pull $(OLLAMA_MODEL)

# --- Pokretanje ---
.PHONY: backend
backend:
	@echo "==> Flask backend na http://localhost:$(PORT)"
	cd local && PORT=$(PORT) OLLAMA_MODEL=$(OLLAMA_MODEL) .venv/bin/python server.py

.PHONY: frontend
frontend:
	@echo "==> Vite dev server na http://localhost:5173"
	npm run dev

# Pokreni oboje; backend u pozadini, frontend u prvom planu.
# Kad se zaustavi frontend (Ctrl-C), gasi se i backend.
.PHONY: run
run:
	@echo "==> Pokrećem backend + frontend (Ctrl-C za zaustavljanje)"
	@trap 'kill 0' EXIT INT TERM; \
	( cd local && PORT=$(PORT) OLLAMA_MODEL=$(OLLAMA_MODEL) .venv/bin/python server.py ) & \
	npm run dev; \
	wait

# --- Pomoćno ---
.PHONY: check
check:
	@echo "python3: $$(command -v python3 || echo NEDOSTAJE)"
	@echo "node:    $$(command -v node || echo NEDOSTAJE)"
	@echo "npm:     $$(command -v npm || echo NEDOSTAJE)"
	@echo "ollama:  $$(command -v ollama || echo NEDOSTAJE)"
	@command -v ollama >/dev/null 2>&1 && { echo "ollama modeli:"; ollama list; } || true

.PHONY: clean
clean:
	rm -rf $(VENV) node_modules local/vetdemo.db
	@echo "🧹 Očišćeno (venv, node_modules, lokalna baza)."
