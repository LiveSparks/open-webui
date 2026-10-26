#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Container entry point for Open WebUI.
# Handles secret key generation, optional Ollama/CUDA/Playwright setup,
# HuggingFace Space deployment, and launches the uvicorn server.
# ---------------------------------------------------------------------------

# Default optional env vars that we test below with bash's `,,` lowercase
# expansion. The two can't be combined inline (`${VAR:-default,,}` makes
# the default literal `,,`), so we normalise once up front and the simple
# `${VAR,,}` form stays safe under `set -u` everywhere else.
: "${USE_SLIM_DOCKER:=}" "${WEB_LOADER_ENGINE:=}" "${USE_OLLAMA_DOCKER:=}" "${USE_CUDA_DOCKER:=}"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
cd "$SCRIPT_DIR" || exit 1

# ── Playwright browser installation (if configured) ──────────────────────────

if [[ "${USE_SLIM_DOCKER,,}" != "true" && "${WEB_LOADER_ENGINE,,}" == "playwright" ]]; then
  if [[ -z "${PLAYWRIGHT_WS_URL:-}" ]]; then
    echo "Installing Playwright Chromium browser..."
    playwright install chromium
    playwright install-deps chromium
  fi
fi

# ── Secret key setup ─────────────────────────────────────────────────────────

KEY_FILE="${WEBUI_SECRET_KEY_FILE:-.webui_secret_key}"
WEBUI_SECRET_KEY_LENGTH="${WEBUI_SECRET_KEY_LENGTH:-24}"
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"

if [[ -z "${WEBUI_SECRET_KEY:-}" && -z "${WEBUI_JWT_SECRET_KEY:-}" ]]; then
  echo "No WEBUI_SECRET_KEY environment variable set, loading from file."

  if [[ ! -f "$KEY_FILE" ]]; then
    echo "Generating new WEBUI_SECRET_KEY..."
    if ! [[ "$WEBUI_SECRET_KEY_LENGTH" =~ ^[1-9][0-9]*$ ]]; then
      echo "WEBUI_SECRET_KEY_LENGTH must be a positive integer." >&2
      exit 1
    fi
    head -c "$WEBUI_SECRET_KEY_LENGTH" /dev/random | base64 > "$KEY_FILE"
  fi

  echo "Loading WEBUI_SECRET_KEY from ${KEY_FILE}"
  WEBUI_SECRET_KEY=$(cat "$KEY_FILE")
fi

# ── Ollama (bundled Docker image) ────────────────────────────────────────────

if [[ "${USE_OLLAMA_DOCKER,,}" == "true" ]]; then
  echo "Starting bundled ollama serve..."
  ollama serve &
fi

# ── CUDA library paths ──────────────────────────────────────────────────────

if [[ "${USE_CUDA_DOCKER,,}" == "true" ]]; then
  echo "CUDA enabled — extending LD_LIBRARY_PATH for torch/cudnn libraries."
  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:/usr/local/lib/python3.11/site-packages/torch/lib:/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib"
fi

# ── Agent sidecar ────────────────────────────────────────────────────────────

# The sidecar is opt-in per deployment: AGENT_SIDECAR_PORT set means this
# deployment wants the agent engine, and the sidecar itself requires the rest
# of the AGENT_SIDECAR_* variables before it serves. Startup retries are
# capped so a broken sidecar config cannot keep uvicorn from serving.
sidecar_pid=""

if [[ -n "${AGENT_SIDECAR_PORT:-}" ]]; then
  SIDECAR_NODE="${AGENT_SIDECAR_NODE:-node}"
  SIDECAR_ENTRY="${AGENT_SIDECAR_ENTRYPOINT:-$SCRIPT_DIR/../sidecar/dist/index.js}"
  SIDECAR_TIMEOUT="${AGENT_SIDECAR_STARTUP_TIMEOUT:-30}"
  SIDECAR_RETRIES="${AGENT_SIDECAR_START_RETRIES:-3}"
  SIDECAR_BACKOFF="${AGENT_SIDECAR_START_BACKOFF_SECONDS:-2}"

  if ! command -v "$SIDECAR_NODE" >/dev/null 2>&1; then
    echo "agent sidecar disabled: Node runtime not found, set AGENT_SIDECAR_NODE to override" >&2
  elif [[ ! -f "$SIDECAR_ENTRY" ]]; then
    echo "agent sidecar disabled: entrypoint missing at ${SIDECAR_ENTRY}" >&2
  elif ! command -v curl >/dev/null 2>&1; then
    echo "agent sidecar disabled: curl not found, cannot check its health endpoint" >&2
  else
    missing=""
    for var in AGENT_SIDECAR_AGENT_DIR AGENT_SIDECAR_MODEL AGENT_SESSIONS; do
      if [[ -z "${!var:-}" ]]; then missing="${missing} ${var}"; fi
    done

    if [[ -n "$missing" ]]; then
      echo "agent sidecar disabled: incomplete setup, missing:${missing}" >&2
    else
      attempt=1
      while :; do
        echo "Starting agent sidecar on port ${AGENT_SIDECAR_PORT} (attempt ${attempt}/${SIDECAR_RETRIES})..."
        "$SIDECAR_NODE" "$SIDECAR_ENTRY" > >(sed -u 's/^/[agent-sidecar] /') 2>&1 &
        sidecar_pid=$!
        healthy=0
        for _ in $(seq "$SIDECAR_TIMEOUT"); do
          if curl -sf "http://127.0.0.1:${AGENT_SIDECAR_PORT}/health" >/dev/null 2>&1; then
            healthy=1
            break
          fi
          if ! kill -0 "$sidecar_pid" 2>/dev/null; then
            echo "agent sidecar exited before reporting healthy" >&2
            break
          fi
          sleep 1
        done
        if [[ "$healthy" == "1" ]]; then
          echo "agent sidecar healthy on port ${AGENT_SIDECAR_PORT}"
          break
        fi
        if kill -0 "$sidecar_pid" 2>/dev/null; then
          echo "agent sidecar did not report healthy in ${SIDECAR_TIMEOUT}s, stopping it" >&2
          kill "$sidecar_pid" 2>/dev/null || true
          wait "$sidecar_pid" 2>/dev/null || true
        fi
        sidecar_pid=""
        if (( attempt >= SIDECAR_RETRIES )); then
          echo "agent sidecar failed after ${attempt} attempts, continuing without the agent engine" >&2
          break
        fi
        sleep "$SIDECAR_BACKOFF"
        attempt=$((attempt + 1))
        SIDECAR_BACKOFF=$((SIDECAR_BACKOFF * 2))
      done
    fi
  fi
fi

# ── HuggingFace Space deployment ─────────────────────────────────────────────

if [[ -n "${SPACE_ID:-}" ]]; then
  echo "Configuring for HuggingFace Space deployment..."

  if [[ -n "${ADMIN_USER_EMAIL:-}" && -n "${ADMIN_USER_PASSWORD:-}" ]]; then
    echo "Creating admin user for Space..."
    WEBUI_SECRET_KEY="${WEBUI_SECRET_KEY:-}" \
      uvicorn open_webui.main:app --host "$HOST" --port "$PORT" --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}" --ws-per-message-deflate "${UVICORN_WS_PER_MESSAGE_DEFLATE:-true}" &
    webui_pid=$!

    echo "Waiting for server to become healthy..."
    until curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; do
      sleep 1
    done

    echo "Registering admin user..."
    curl -sS -X POST "http://localhost:${PORT}/api/v1/auths/signup" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      -d "{\"email\": \"${ADMIN_USER_EMAIL}\", \"password\": \"${ADMIN_USER_PASSWORD}\", \"name\": \"Admin\"}"

    echo "Restarting server..."
    kill "$webui_pid"
    wait "$webui_pid" 2>/dev/null || true
  fi

  export WEBUI_URL="${SPACE_HOST}"
fi

# ── Launch uvicorn ───────────────────────────────────────────────────────────

PYTHON_CMD=$(command -v python3 || command -v python)
UVICORN_WORKERS="${UVICORN_WORKERS:-1}"

if [[ "$#" -gt 0 ]]; then
  ARGS=("$@")
else
  ARGS=(--workers "$UVICORN_WORKERS" --ws-per-message-deflate "${UVICORN_WS_PER_MESSAGE_DEFLATE:-true}")
fi

UVICORN_ARGS=(--host "$HOST" --port "$PORT" --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}" "${ARGS[@]}")

if [[ -z "$sidecar_pid" ]]; then
  exec env WEBUI_SECRET_KEY="${WEBUI_SECRET_KEY:-}" \
    "$PYTHON_CMD" -m uvicorn open_webui.main:app "${UVICORN_ARGS[@]}"
fi

# With the sidecar up, uvicorn runs as a child so both processes shut down
# together on SIGTERM instead of the sidecar being orphaned by exec.
env WEBUI_SECRET_KEY="${WEBUI_SECRET_KEY:-}" \
  "$PYTHON_CMD" -m uvicorn open_webui.main:app "${UVICORN_ARGS[@]}" &
uvicorn_pid=$!
trap 'kill -TERM "$uvicorn_pid" "$sidecar_pid" 2>/dev/null || true' INT TERM
status=0
wait "$uvicorn_pid" || status=$?
kill -TERM "$sidecar_pid" 2>/dev/null || true
wait "$sidecar_pid" 2>/dev/null || true
exit "$status"
