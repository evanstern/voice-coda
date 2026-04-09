# CLAUDE.md

## Project: voice-coda

A hands-free voice interface for coding agents. The goal: talk to your agent through Bluetooth earbuds (Pixel Buds) on an Android phone while your hands are busy — like working at a bakery — and have the agent working on code, managing repos, and talking back.

## Origin

This project was spun off from the `evanstern/ideas` repo after exploring the concept. The core insight: Claude Code's web app (claude.ai/code) works today with voice typing, but what we really want is a **full voice loop** — continuous speech-to-text input, Claude processing with tool use, and text-to-speech output back through earbuds.

## Architecture

```
Pixel Buds → Phone Mic → Speech-to-Text (Whisper / Google STT)
    → Claude API (with tool_use for git, file ops, bash)
    → Text-to-Speech (OpenAI TTS / ElevenLabs / Google TTS)
    → Pixel Buds speaker
```

**Components:**
- **Server (`apps/server`)** — Hono + tRPC backend running on a home Mac. Manages the Claude API session, executes tools (git, file I/O, shell commands), handles the STT→Claude→TTS pipeline. WebSocket endpoint for real-time audio streaming.
- **Web client (`apps/web`)** — React Router 7 PWA accessed from phone browser. Captures mic audio, streams to server via WebSocket, plays back TTS audio. SSR-enabled with Hono server proxy to backend tRPC.
- **Voice pipeline** — STT on inbound audio, TTS on outbound text. Needs to handle conversational pacing (know when you're done talking, don't interrupt).

## Tech Stack

- **Monorepo:** pnpm workspaces + Turborepo
- **Runtime:** Node.js 22+ (TypeScript, ES modules)
- **Backend:** Hono + tRPC 11 (typesafe API)
- **Frontend:** React 19 + React Router 7 + Vite 6
- **Styling:** Tailwind CSS 4 + Radix UI
- **UI Library:** `@voice-coda/ui` (shared components with CVA + tailwind-merge)
- **Contracts:** `@voice-coda/contracts` (shared Zod schemas)
- **API:** Anthropic Claude API with tool_use
- **STT:** OpenAI Whisper (may switch to Google Cloud STT)
- **TTS:** OpenAI TTS (may switch to ElevenLabs or Google Cloud TTS)
- **Transport:** tRPC for control plane, WebSocket for audio streaming
- **Code Quality:** Biome (formatter + linter)
- **Containerization:** Docker Compose for local dev

## Key Challenges

- **Latency** — Voice conversations need to feel snappy. STT + API + TTS round-trip needs to stay under ~3-4 seconds.
- **Turn detection** — Knowing when the user is done speaking vs. just pausing. Voice Activity Detection (VAD) is critical.
- **Audio streaming** — Continuous mic capture on mobile browser, reliable WebSocket streaming to server. May need to upgrade beyond basic WebSocket for audio quality.
- **Tool execution context** — Claude needs access to repos, files, and shell on the server. Security model matters.
- **Background audio** — Mobile browser needs to keep the mic/audio session alive when the screen is off or app is backgrounded.

## Project Structure

```
voice-coda/
├── apps/
│   ├── server/          — Hono + tRPC backend (API, WebSocket, tool execution)
│   └── web/             — React Router 7 PWA (mic capture, audio playback)
├── services/
│   └── wake-word/       — openWakeWord service, model config, and training assets
├── packages/
│   ├── contracts/       — Shared Zod schemas & types
│   ├── shared/          — Shared utilities
│   └── ui/              — Radix + Tailwind component library
├── scripts/
│   ├── install.sh       — Full setup script (Node, pnpm, deps, build, systemd)
│   ├── start.sh         — Production process manager (ExecStart for systemd)
│   └── voice-coda       — CLI source (installed to /usr/local/bin by install.sh)
├── docker-compose.yml
├── turbo.json
├── pnpm-workspace.yaml
└── biome.json
```

## Getting Started

### Prerequisites
- Node.js 22+
- pnpm 9.15+
- Docker (for containerized dev)

### Local Development
```bash
cp .env.example .env
pnpm install
pnpm dev          # starts server (port 4000) + web (port 3000)
```

### Docker Development
```bash
cp .env.example .env
docker compose up
```

### Build
```bash
pnpm build        # builds all packages via Turbo
```

### Other Commands
```bash
pnpm lint         # biome check
pnpm format       # biome format
pnpm typecheck    # tsc --noEmit
```

## Build Phases

1. ~~Set up monorepo with Hono + tRPC + React Router~~ (done)
2. Get a minimal WebSocket connection between phone browser and server
3. Wire up STT (speech-to-text) on incoming audio
4. Connect to Claude API with a simple tool (e.g., read a file)
5. Wire up TTS on Claude's response
6. Test the full loop: speak → transcribe → Claude → synthesize → hear

## Production Deployment (Docker)

### Prerequisites
- Docker and Docker Compose v2
- `.env` file with required API keys (see `.env.example`)

### Build and Run
```bash
# Build and start production containers
docker compose -f docker-compose.prod.yml up --build -d

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Stop
docker compose -f docker-compose.prod.yml down
```

### Architecture
Both `apps/server` and `apps/web` have multi-stage production Dockerfiles:
1. **base** -- node:22-slim with pnpm enabled
2. **deps** -- installs all dependencies (full lockfile)
3. **build** -- runs `pnpm build` via Turborepo
4. **runner** -- minimal image with only production dependencies and built artifacts

### Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Server port |
| `WEB_PORT` | `3000` | Web app port |
| `SERVER_URL` | `http://server:4000` | Internal server URL (used by web container) |
| `ANTHROPIC_API_KEY` | -- | Required for Claude API |
| `OPENAI_API_KEY` | -- | Required for Whisper STT / TTS |
| `WORK_DIR` | `/workspace` | Directory mounted into server for Claude tool execution |

### Volume Mounts
The server container mounts `WORK_DIR` (defaults to `./workspace`) into `/workspace` inside the container. This is the directory Claude tools operate on (git, file ops, shell).
