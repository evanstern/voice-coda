# voice-coda

A hands-free voice interface for coding agents. Talk through Bluetooth earbuds on your phone while your hands are busy, and have the agent work on code, manage repos, and talk back.

> `voice-coda` is the successor to `voice-claude`: same core voice loop, but re-positioned around wake-word-first interaction and provider-agnostic agent backends.

```
Earbuds Mic → Wake-word detection (optional) → Speech-to-Text → AI agent/tools → Text-to-Speech → Earbuds Speaker
```

## Current Direction

- **Provider-agnostic agent backend** — supports Anthropic directly, Claude Code CLI, or OpenCode headless.
- **Wake-word path in progress** — includes an openWakeWord service, browser integration, and training assets for the custom `"Coda"` wake word.
- **Transition status** — this repo is in the first cutover phase, so some internal package, CLI, config, and service names still use `voice-claude` and will be renamed in follow-up phases.

See the rollout docs:

- [`docs/successor/voice-coda-plan.md`](docs/successor/voice-coda-plan.md)
- [`docs/successor/voice-coda-execution-plan.md`](docs/successor/voice-coda-execution-plan.md)
- [`docs/successor/voice-coda-migration-checklist.md`](docs/successor/voice-coda-migration-checklist.md)

## Prerequisites

- **Node.js 22+** (the install script will set this up for you on Debian/Ubuntu)
- **pnpm 9.15+** (installed automatically via corepack)
- **API keys**: Anthropic (required), OpenAI (required for default STT/TTS)
- **Docker** (only if using Docker-based deployment)

## Quick Start (Bare Metal)

```bash
git clone https://github.com/evanstern/voice-coda.git
cd voice-coda

# Prepare the installed runtime config outside the repo
mkdir -p ~/.config/voice-claude
cp .env.example ~/.config/voice-claude/config.env
vim ~/.config/voice-claude/config.env

# Install everything and start the service
./scripts/install.sh
```

The install script sets up Node.js, builds the project, installs a systemd service, and starts it automatically. The web app will be at `http://localhost:3000` and the API server at `http://localhost:4000`.

After installation, manage the service with:

```bash
voice-claude status            # check if running
voice-claude logs -f           # follow logs
voice-claude restart           # restart after config changes
voice-claude stop              # stop the service
voice-claude start             # start it back up
voice-claude update            # git pull, rebuild, restart
voice-claude uninstall         # remove service and CLI
```

## Configuration

Installed bare-metal config lives at `~/.config/voice-claude/config.env`.

The install script creates that file from `.env.example` if it is missing, and migrates an existing repo-root `.env` on first install so current setups keep working.

At minimum, you need to set:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # Required - Claude API access
OPENAI_API_KEY=sk-...          # Required for default Whisper STT and OpenAI TTS
```

### All Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | API server port |
| `WEB_PORT` | `3000` | Web app port |
| `SERVER_URL` | `http://localhost:4000` | Internal URL the web app uses to reach the server |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `ANTHROPIC_API_KEY` | -- | **Required.** Anthropic API key for Claude |
| `OPENAI_API_KEY` | -- | **Required** (when using OpenAI STT/TTS) |
| `AI_PROVIDER` | `anthropic` | `anthropic` (direct API), `claude-code` (Claude Code CLI), or `opencode` (OpenCode headless) |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode headless server URL when `AI_PROVIDER=opencode` |
| `CLAUDE_MODEL` | `auto` | Model routing: `auto`, `sonnet`, or `haiku` |
| `STT_PROVIDER` | `openai` | Speech-to-text: `openai` or `local` |
| `TTS_PROVIDER` | `openai` | Text-to-speech: `openai`, `google`, or `piper` |
| `TTS_VOICE` | `nova` | OpenAI TTS voice name |
| `WORK_DIR` | `./workspace` | Host directory mounted for AI tool execution |
| `WAKE_WORD_PORT` | `9000` | openWakeWord WebSocket service port |
| `BEHIND_PROXY` | `false` | Set `true` when behind a reverse proxy (Traefik, nginx) |
| `CONVERSATIONS_DIR` | `./data/conversations` | Where conversation history is stored (production Docker) |

### Wake Word Detection (openWakeWord)

The repo now includes an optional wake-word service intended for the passive-listening flow:

```bash
WAKE_WORD_PORT=9000
WAKE_WORD_MODEL=./models/wake-word/coda.tflite
WAKE_WORD_THRESHOLD=0.5
WAKE_WORD_VAD_THRESHOLD=0.5
WAKE_WORD_PATIENCE=3
WAKE_WORD_DEBOUNCE=2.0
WAKE_WORD_MODELS_DIR=./models/wake-word
```

This service is designed to keep a lightweight listener running until it hears `"Coda"`, then hand off to the existing active recording / STT / agent / TTS pipeline.

### TTS Provider Options

**OpenAI TTS** (default) -- Uses the OpenAI API. Set `TTS_VOICE` to change the voice (default: `nova`).

**Google Cloud TTS** -- Set `TTS_PROVIDER=google` and configure:
```bash
GOOGLE_TTS_CREDENTIALS_FILE=/path/to/google-credentials.json
GOOGLE_TTS_VOICE=en-US-Standard-C
GOOGLE_TTS_SPEAKING_RATE=1.0
```

**Piper TTS** (local, no API key needed) -- Set `TTS_PROVIDER=piper`. See [Piper Setup](#piper-local-tts) below.

### STT Provider Options

**OpenAI Whisper** (default) -- Uses the OpenAI Whisper API. Requires `OPENAI_API_KEY`.

**Local Whisper** -- Set `STT_PROVIDER=local` and configure:
```bash
WHISPER_MODEL_PATH=/models/ggml-base.en.bin
WHISPER_BINARY=whisper-cpp  # path to whisper-cpp binary
```

## Installation Methods

### 1. Bare Metal (install script)

The install script handles everything on Debian/Ubuntu:

```bash
mkdir -p ~/.config/voice-claude
cp .env.example ~/.config/voice-claude/config.env
vim ~/.config/voice-claude/config.env

./scripts/install.sh
```

What it does:
- Installs Node.js 22 from NodeSource (if not present or outdated)
- Installs system packages (`git`, `curl`, `jq`, `python3`, `ripgrep`, etc.)
- Enables pnpm via corepack
- Creates `~/.config/voice-claude/config.env` from `.env.example` if needed
- Migrates an existing repo-root `.env` into `~/.config/voice-claude/config.env` on first install
- Runs `pnpm install` and `pnpm build`
- Creates a systemd service (`voice-claude.service`) that auto-starts on boot
- Installs the `voice-claude` CLI to `/usr/local/bin/`
- Starts the service

For installed bare-metal deployments, edit `~/.config/voice-claude/config.env` and then run `voice-claude restart`.

To update after a `git pull` (or let the CLI do it for you):
```bash
voice-claude update
```

### 2. Docker (Development)

Docker still uses a repo-local `.env` file because Compose resolves `env_file` from the working directory.

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose up
```

This mounts the source tree into the containers for hot-reloading.

### 3. Docker (Production -- Build Locally)

Docker still uses a repo-local `.env` file because Compose resolves `env_file` from the working directory.

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose -f docker-compose.prod.yml up --build -d
```

Builds multi-stage production images. Includes Traefik labels for reverse proxy routing -- set `VOICE_CLAUDE_HOST` to your domain.

### 4. Docker (Production -- Pre-built Images)

Docker still uses a repo-local `.env` file because Compose resolves `env_file` from the working directory.

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose -f docker-compose.ghcr.yml up -d
```

Pulls pre-built images from `ghcr.io/evanstern/voice-claude`. Use `IMAGE_TAG` to pin a version.

## Piper Local TTS

Piper is a local TTS engine that doesn't require any API keys. You can enable it with either the install script or Docker.

**Bare metal:**
```bash
./scripts/install.sh --with-piper
```
Or set `INSTALL_PIPER=true` before running the script. This creates a Python virtualenv, installs `piper-tts`, and downloads the default voice model (`en_US-lessac-medium`).

**Docker:**
```bash
docker compose -f docker-compose.prod.yml --profile piper up --build -d
```
The `piper-init` sidecar container auto-downloads the model on first run.

For bare metal installs, set this in `~/.config/voice-claude/config.env`.
For Docker, set it in the repo-local `.env`.

```bash
TTS_PROVIDER=piper
```

## Reverse Proxy (Traefik)

For bare metal installs, set `BEHIND_PROXY=true` in `~/.config/voice-claude/config.env`.
For Docker, set it in the repo-local `.env`.

The production Docker Compose files include Traefik labels. To use them:

1. Set `BEHIND_PROXY=true`
2. Set `VOICE_CLAUDE_HOST` to your domain (default: `voice.local.infinity-node.win`)
3. Ensure a `traefik-network` Docker network exists (or set `TRAEFIK_NETWORK` to your network name)

Routes configured:
- `/ws` and `/trpc` → server container (port 4000)
- `/api/health` → server container
- Everything else → web container (port 3000)

## Development

```bash
pnpm dev          # Start server + web in dev mode with hot reload
pnpm build        # Build all packages
pnpm lint         # Biome linter
pnpm format       # Biome formatter
pnpm typecheck    # TypeScript type checking
```

## Project Structure

```
voice-claude/
├── apps/
│   ├── server/          # Hono + tRPC backend (API, WebSocket, tool execution)
│   └── web/             # React Router 7 PWA (mic capture, audio playback)
├── services/
│   └── wake-word/       # openWakeWord service, model config, and training assets
├── packages/
│   ├── contracts/       # Shared Zod schemas & types
│   ├── shared/          # Shared utilities
│   └── ui/              # Radix + Tailwind component library
├── scripts/
│   ├── install.sh       # Full setup script (Node, pnpm, deps, build, systemd)
│   ├── start.sh         # Production process manager (ExecStart for systemd)
│   └── voice-claude     # CLI source (installed to /usr/local/bin by install.sh)
├── docker/              # Dockerfiles and support files
├── models/              # Local model files (Piper voices)
└── docs/                # Additional documentation
```
