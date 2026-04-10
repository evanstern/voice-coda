#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)

cd "${PROJECT_ROOT}"

# Load environment from config file or local .env
# Support legacy VOICE_CLAUDE_CONFIG for one transition release
CONFIG_FILE="${VOICE_CODA_CONFIG:-${VOICE_CLAUDE_CONFIG:-}}"
if [[ -z "${CONFIG_FILE}" ]]; then
  CONFIG_FILE="${HOME}/.config/voice-coda/config.env"
fi

if [[ -f "${CONFIG_FILE}" ]]; then
  set -a
  source "${CONFIG_FILE}"
  set +a
elif [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  source "${PROJECT_ROOT}/.env"
  set +a
fi

# Run turbo dev directly (bypasses pnpm script's .env sourcing)
exec npx turbo run dev --env-mode=loose
