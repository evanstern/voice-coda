# voice-coda migration checklist

Use this alongside [`voice-coda-execution-plan.md`](./voice-coda-execution-plan.md), which defines the recommended sequencing and cutover strategy.

## Rename surface

| Current | Target | Notes |
|---|---|---|
| repo name `voice-claude` | `voice-coda` | GitHub repo, local clone path, README title |
| root package `voice-claude` | `voice-coda` | root `package.json` |
| scope `@voice-claude/*` | `@voice-coda/*` | packages, imports, workspace references |
| CLI `voice-claude` | `voice-coda` | installed binary and help text |
| config dir `~/.config/voice-claude` | `~/.config/voice-coda` | keep migration path from old location |
| systemd service `voice-claude.service` | `voice-coda.service` | install/uninstall scripts |
| env vars `VOICE_CLAUDE_*` | `VOICE_CODA_*` | proxy host/config vars and script environment |
| image path `ghcr.io/evanstern/voice-claude/*` | `ghcr.io/<owner>/voice-coda/*` | container publish workflow + compose files |
| docker labels `voice-claude-*` | `voice-coda-*` | Traefik router/service names |

## Package rename plan

1. Rename workspace packages:
   - `@voice-claude/server` → `@voice-coda/server`
   - `@voice-claude/web` → `@voice-coda/web`
   - `@voice-claude/contracts` → `@voice-coda/contracts`
   - `@voice-claude/ui` → `@voice-coda/ui`
2. Update all import paths and workspace dependency references.
3. Keep file/folder paths stable initially unless a path rename materially improves clarity.
4. Migrate user-facing names before internal directory churn.

## Migration checklist

### Repo/bootstrap

- [x] create the `voice-coda` repository
- [x] copy or transfer the current branch state into the new repo
- [x] update origin URLs, README title, and top-level package name

### Branding + user-facing names

- [x] rename CLI/script references from `voice-claude` to `voice-coda`
- [x] rename config directory references to `~/.config/voice-coda`
- [x] rename service unit names and operational docs
- [x] replace remaining user-facing `Voice Claude` / Claude-only copy

### Package scope migration

- [x] rename all `@voice-claude/*` packages
- [x] update imports across `apps/` and `packages/`
- [x] refresh lockfile after package rename

### Infra/deployment

- [x] rename Docker image coordinates and Compose references
- [x] rename Traefik router/service labels
- [x] rename `VOICE_CLAUDE_*` env vars to `VOICE_CODA_*`
- [x] preserve compatibility aliases where practical for one transition release

### Wake-word-first productization

- [x] promote wake-word setup into the main quick-start path
- [x] document openWakeWord tuning and model placement
- [x] define the passive-listen → wake → request → response state machine in user docs

### Cleanup

- [x] keep backward-compat migration notes for existing installs
- [x] decide whether old historical docs stay under `voice-claude` wording (kept as historical context)
- [ ] cut a first `voice-coda` release once install/update paths are stable

## Recommended order

1. new repo + README/branding
2. package scope rename
3. CLI/config/service rename
4. container/env rename
5. backwards-compat polish and release
