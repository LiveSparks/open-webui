#!/usr/bin/env bash
# The local half of the verification workflow: the same checks the remote
# lanes run, runnable on the operator's box, one at a time.
#
#   scripts/verify-local.sh lint    backend ruff format + logic errors, sidecar tsc/eslint
#   scripts/verify-local.sh unit    the parity kit's pytest unit box (lean gate)
#   scripts/verify-local.sh check   frontend eslint (heap-capped)
#   scripts/verify-local.sh build   frontend production build (heap-capped)
#
# The kit lives in /var/tmp/kit (checked out on first run); TMPDIR=/var/tmp
# keeps instance scratch off the tmpfs (the standing /var/tmp rule).

set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=/var/tmp

KIT=/var/tmp/kit
KIT_URL=https://github.com/LiveSparks/open-webui-tests.git

ensure_kit() {
  if [ ! -d "$KIT/.git" ]; then
    git clone --branch agent-self-learning-parity "$KIT_URL" "$KIT"
  fi
  if [ ! -x "$KIT/.venv/bin/python" ]; then
    uv sync --locked --directory "$KIT"
    uv pip install --python "$KIT/.venv/bin/python" -r backend/requirements.txt
  fi
}

backend_lint() {
  echo '── backend: ruff format --check + F rules'
  uvx ruff@0.15.5 format --check backend --exclude .venv --exclude venv
  uvx ruff@0.15.5 check backend --select=F --ignore=F401,F403,F405,F541,F811,F841
}

sidecar_lint() {
  echo '── sidecar: lint + typecheck (sidecar/package.json)'
  (cd sidecar && [ -d node_modules ] || npm ci --force >/dev/null && npm run lint && npm run check)
}

frontend_lint() {
  echo '── frontend: lint (heap-capped, serial like every npm run here)'
  [ -d node_modules ] || npm ci --force >/dev/null
  NODE_OPTIONS=--max-old-space-size=1024 npm run lint
}

frontend_build() {
  echo '── frontend: production build (heap-capped)'
  [ -d node_modules ] || npm ci --force >/dev/null
  NODE_OPTIONS=--max-old-space-size=5120 npm run build
}

unit_box() {
  local repo_root
  repo_root=$(pwd)
  echo "── unit box: pytest unit against $repo_root (parity kit @ $KIT)"
  ensure_kit
  (cd "$KIT" && OPEN_WEBUI_CHECKOUT="$repo_root" \
  OPEN_WEBUI_SOURCE_DIR="$repo_root/backend" \
  WEBUI_SECRET_KEY=test \
  DATA_DIR=/var/tmp/owui-unit-tests/data \
  STATIC_DIR=/var/tmp/owui-unit-tests/static \
    "$KIT/.venv/bin/python" -m pytest unit -q "$@")
}

case "${1:-lint}" in
  lint)   backend_lint; sidecar_lint ;;
  check)  frontend_lint ;;
  unit)   shift; unit_box "$@" ;;
  build)  frontend_build ;;
  full)   backend_lint; sidecar_lint; unit_box ;;
  *) echo "usage: $0 {lint|unit|build|full} [extra pytest args]" >&2; exit 64 ;;
esac
