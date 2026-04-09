# voice-coda

Wake with "Coda," code by voice. A hands-free voice interface for coding agents — talk through Bluetooth earbuds while your hands are busy, and have the agent work on code, manage repos, and talk back.

## How It Works

voice-coda keeps a lightweight wake-word listener running in the background. When it hears **"Coda"**, it activates the full voice pipeline:

```
Passive listen → Wake-word detected ("Coda") → Capture request → STT → AI agent/tools → TTS → Earbuds → Return to passive
```

### Voice Interaction Flow

1. **Passive listen** — The browser streams mic audio to the openWakeWord service. Low CPU, no API calls, no transcription.
2. **Wake detected** — The wake-word model hears "Coda" above the configured threshold. The app plays a confirmation tone.
3. **Request capture** — Active recording begins. Speak your request naturally; Voice Activity Detection (VAD) detects when you stop.
4. **Processing** — Audio goes to STT (Whisper), the transcript goes to the AI agent (Anthropic, Claude Code, or OpenCode), the agent runs tools and produces a response.
5. **Response playback** — The response is synthesized via TTS and played back through your earbuds.
6. **Return to passive** — After playback completes, the app returns to passive wake-word listening.

### What Is Pluggable

| Layer | Options |
|---|---|
| AI provider | Anthropic API, Claude Code CLI, OpenCode headless |
| Speech-to-text | OpenAI Whisper API, local whisper-cpp |
| Text-to-speech | OpenAI TTS, Google Cloud TTS, Piper (local, free) |
| Wake-word model | Custom openWakeWord model (training assets included) |

### What Is Experimental

- **Mobile background audio** — keeping the mic/audio session alive when the phone screen is off or the browser is backgrounded is not yet reliable across all devices.
- **False-positive tuning** — the default wake-word threshold works for quiet environments but may need adjustment for noisy settings.
- **Passive mode UX** — the transition between passive listening and active recording is functional but still being refined.

## Quick Start (Bare Metal)

```bash
git clone https://github.com/evanstern/voice-coda.git
cd voice-coda

mkdir -p ~/.config/voice-coda
cp .env.example ~/.config/voice-coda/config.env
vim ~/.config/voice-coda/config.env

./scripts/install.sh
```

The install script sets up Node.js, builds the project, installs a systemd service, and starts it automatically. The web app will be at `http://localhost:3000` and the API server at `http://localhost:4000`.

To enable wake-word detection, start the wake-word service alongside the main app (see [Wake Word Setup](#wake-word-setup) below).

After installation, manage the service with:

```bash
voice-coda status            # check if running
voice-coda logs -f           # follow logs
voice-coda restart           # restart after config changes
voice-coda stop              # stop the service
voice-coda start             # start it back up
voice-coda update            # git pull, rebuild, restart
voice-coda uninstall         # remove service and CLI
```

## Wake Word Setup

The wake-word service uses [openWakeWord](https://github.com/dscripka/openWakeWord) to detect the "Coda" activation phrase. It runs as a separate process or Docker container alongside the main app.

### Docker (recommended)

The dev compose file includes a `wake-word` service:

```bash
docker compose up
```

### Bare metal

```bash
cd services/wake-word
pip install -r requirements.txt
python wake_word_service.py
```

The service listens on port `9000` (configurable via `WAKE_WORD_PORT`) and accepts WebSocket connections from the browser. The browser streams raw 16-bit PCM audio; the service responds with wake events when it detects "Coda".

### Tuning

| Variable | Default | What it controls |
|---|---|---|
| `WAKE_WORD_THRESHOLD` | `0.5` | Detection confidence (0–1). Higher = fewer false positives, more missed wakes. Start at 0.5 and increase if you get false triggers. |
| `WAKE_WORD_VAD_THRESHOLD` | `0.5` | Voice Activity Detection filter (0–1). Filters non-speech audio before wake detection. |
| `WAKE_WORD_PATIENCE` | `3` | Consecutive frames above threshold required before triggering. Higher = more resistant to brief noise spikes. |
| `WAKE_WORD_DEBOUNCE` | `2.0` | Seconds to wait between detections. Prevents rapid re-triggering after a wake event. |
| `WAKE_WORD_MODEL` | (built-in) | Path to a custom `.tflite` or `.onnx` model file. Leave empty to use the pre-trained models. Training assets for the custom "Coda" model are in `services/wake-word/training/`. |
| `WAKE_WORD_MODELS_DIR` | `./models/wake-word` | Host directory containing model files. |

**Tuning tips:**
- Quiet home office: `WAKE_WORD_THRESHOLD=0.5`, `WAKE_WORD_PATIENCE=3` (defaults work well)
- Noisy environment (kitchen, workshop): `WAKE_WORD_THRESHOLD=0.7`, `WAKE_WORD_PATIENCE=5`, `WAKE_WORD_VAD_THRESHOLD=0.7`
- Getting false triggers: increase `WAKE_WORD_THRESHOLD` in 0.1 increments
- Missing real wakes: decrease `WAKE_WORD_THRESHOLD` or `WAKE_WORD_PATIENCE`

## Configuration

Installed bare-metal config lives at `~/.config/voice-coda/config.env`.

The install script creates that file from `.env.example` if it is missing, and migrates an existing `~/.config/voice-claude` config or repo-root `.env` on first install so current setups keep working.

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
| `BEHIND_PROXY` | `false` | Set `true` when behind a reverse proxy (Traefik, nginx) |
| `CONVERSATIONS_DIR` | `./data/conversations` | Where conversation history is stored (production Docker) |

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
mkdir -p ~/.config/voice-coda
cp .env.example ~/.config/voice-coda/config.env
vim ~/.config/voice-coda/config.env

./scripts/install.sh
```

What it does:
- Installs Node.js 22 from NodeSource (if not present or outdated)
- Installs system packages (`git`, `curl`, `jq`, `python3`, `ripgrep`, etc.)
- Enables pnpm via corepack
- Creates `~/.config/voice-coda/config.env` from `.env.example` if needed
- Migrates an existing `~/.config/voice-claude` config on first install
- Runs `pnpm install` and `pnpm build`
- Creates a systemd service (`voice-coda.service`) that auto-starts on boot
- Installs the `voice-coda` CLI to `/usr/local/bin/`
- Starts the service

For installed bare-metal deployments, edit `~/.config/voice-coda/config.env` and then run `voice-coda restart`.

To update after a `git pull` (or let the CLI do it for you):
```bash
voice-coda update
```

### 2. Docker (Development)

Docker uses a repo-local `.env` file because Compose resolves `env_file` from the working directory.

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose up
```

This mounts the source tree into the containers for hot-reloading. Includes the wake-word service.

### 3. Docker (Production -- Build Locally)

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose -f docker-compose.prod.yml up --build -d
```

Builds multi-stage production images. Includes Traefik labels for reverse proxy routing -- set `VOICE_CODA_HOST` to your domain.

### 4. Docker (Production -- Pre-built Images)

```bash
cp .env.example .env
# Edit .env with your API keys
docker compose -f docker-compose.ghcr.yml up -d
```

Pulls pre-built images from `ghcr.io/evanstern/voice-coda`. Use `IMAGE_TAG` to pin a version.

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

For bare metal installs, set this in `~/.config/voice-coda/config.env`.
For Docker, set it in the repo-local `.env`.

```bash
TTS_PROVIDER=piper
```

## Reverse Proxy (Traefik)

For bare metal installs, set `BEHIND_PROXY=true` in `~/.config/voice-coda/config.env`.
For Docker, set it in the repo-local `.env`.

The production Docker Compose files include Traefik labels. To use them:

1. Set `BEHIND_PROXY=true`
2. Set `VOICE_CODA_HOST` to your domain (default: `voice.local.infinity-node.win`)
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
voice-coda/
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
│   └── voice-coda       # CLI source (installed to /usr/local/bin by install.sh)
├── docker/              # Dockerfiles and support files
├── models/              # Local model files (Piper voices, wake-word models)
└── docs/                # Additional documentation
```

## Migrating from voice-claude

`voice-coda` is the successor to `voice-claude`. If you have an existing `voice-claude` install:

1. **Config** — The install script automatically migrates `~/.config/voice-claude/config.env` to the new `~/.config/voice-coda/` location on first install. The `VOICE_CLAUDE_CONFIG` environment variable is still recognized as a fallback.
2. **CLI** — Replace `voice-claude` commands with `voice-coda` (same subcommands). The uninstall command cleans up the old CLI binary.
3. **Docker** — Update image paths from `ghcr.io/evanstern/voice-claude/*` to `ghcr.io/evanstern/voice-coda/*`. Rename `VOICE_CLAUDE_HOST` to `VOICE_CODA_HOST` in your `.env`.
4. **Imports** — If you have custom code depending on `@voice-claude/*` packages, update to `@voice-coda/*`.

See [`docs/successor/voice-coda-migration-checklist.md`](docs/successor/voice-coda-migration-checklist.md) for the full checklist.
