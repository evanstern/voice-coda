#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)

SERVER_PID=''
WEB_PID=''
PIPER_PID=''
STOPPING=false
SHUTDOWN_REQUESTED=false

log() {
  printf '[start] %s\n' "$*"
}

fail() {
  printf '[start] ERROR: %s\n' "$*" >&2
  exit 1
}

load_env() {
  # Support legacy VOICE_CLAUDE_CONFIG for one transition release
  local env_file=${VOICE_CODA_CONFIG:-${VOICE_CLAUDE_CONFIG:-${PROJECT_ROOT}/.env}}

  if [[ -f "${env_file}" ]]; then
    set -a
    source "${env_file}"
    set +a
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    fail "Missing required file: $1. Run ./scripts/install.sh first."
  fi
}

start_process() {
  local pid_var=$1
  local name=$2
  local working_dir=$3
  shift 3
  log "Starting ${name}" >&2
  (
    cd "${working_dir}"
    exec "$@"
  ) &

  printf -v "${pid_var}" '%s' "$!"
}

shutdown() {
  local signal=${1:-SIGTERM}

  if [[ ${STOPPING} == true ]]; then
    return
  fi
  STOPPING=true

  log "Stopping processes (${signal})"

  local pid
  for pid in "${WEB_PID}" "${SERVER_PID}" "${PIPER_PID}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill -"${signal}" "${pid}" >/dev/null 2>&1 || true
    fi
  done

  wait || true
}

main() {
  cd "${PROJECT_ROOT}"

  load_env

  local node_env server_port web_port server_url behind_proxy
  node_env=${NODE_ENV:-production}
  server_port=${PORT:-4000}
  web_port=${WEB_PORT:-3000}
  server_url=${SERVER_URL:-http://localhost:4000}
  behind_proxy=${BEHIND_PROXY:-false}

  require_command node
  require_file "${PROJECT_ROOT}/apps/server/dist/src/index.js"
  require_file "${PROJECT_ROOT}/apps/web/build/server/index.js"

  trap 'SHUTDOWN_REQUESTED=true; shutdown SIGINT' INT
  trap 'SHUTDOWN_REQUESTED=true; shutdown SIGTERM' TERM

  if [[ "${TTS_PROVIDER:-openai}" == 'piper' ]]; then
    export PIPER_URL=${PIPER_URL:-http://localhost:5000}
    export PIPER_PORT=${PIPER_PORT:-5000}
    export PIPER_MODEL_NAME=${PIPER_MODEL_NAME:-en_US-lessac-medium.onnx}
    export PIPER_MODELS_DIR=${PIPER_MODELS_DIR:-${PROJECT_ROOT}/models/piper}
    export PIPER_MODEL=${PIPER_MODEL:-${PIPER_MODELS_DIR}/${PIPER_MODEL_NAME}}

    local piper_venv="${PROJECT_ROOT}/.venv/piper"
    require_file "${piper_venv}/bin/python3"
    require_file "${piper_venv}/bin/piper"
    require_file "${PROJECT_ROOT}/docker/piper/server.py"
    require_file "${PIPER_MODEL}"

    start_process PIPER_PID 'Piper TTS' "${PROJECT_ROOT}" env \
      PIPER_PORT="${PIPER_PORT}" \
      PIPER_MODEL="${PIPER_MODEL}" \
      PIPER_BINARY="${piper_venv}/bin/piper" \
      "${piper_venv}/bin/python3" "${PROJECT_ROOT}/docker/piper/server.py"
  fi

  start_process SERVER_PID 'server' "${PROJECT_ROOT}/apps/server" env NODE_ENV="${node_env}" PORT="${server_port}" BEHIND_PROXY="${behind_proxy}" PIPER_URL="${PIPER_URL:-}" TTS_PROVIDER="${TTS_PROVIDER:-}" SERVER_URL="${server_url}" node --import tsx dist/src/index.js
  start_process WEB_PID 'web' "${PROJECT_ROOT}/apps/web" env NODE_ENV="${node_env}" PORT="${web_port}" SERVER_URL="${server_url}" node build/server/index.js

  set +e
  wait -n "${SERVER_PID}" "${WEB_PID}" ${PIPER_PID:+"${PIPER_PID}"}
  local exit_code=$?
  set -e

  if [[ ${SHUTDOWN_REQUESTED} == true ]]; then
    shutdown SIGTERM
    return
  fi

  local exited_name="unknown"
  if [[ -n "${SERVER_PID}" ]] && ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    exited_name="server"
  elif [[ -n "${WEB_PID}" ]] && ! kill -0 "${WEB_PID}" 2>/dev/null; then
    exited_name="web"
  elif [[ -n "${PIPER_PID}" ]] && ! kill -0 "${PIPER_PID}" 2>/dev/null; then
    exited_name="piper"
  fi

  log "Process '${exited_name}' exited with status ${exit_code}"
  shutdown SIGTERM
  fail "Process '${exited_name}' exited unexpectedly (status ${exit_code})"
}

main "$@"
