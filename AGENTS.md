# Development Rules

## First Message

If the user did not give you a concrete task in their first message, read README.md, then ask which module(s) to work on. Based on the answer, read the relevant README.md files in parallel:

- packages/ai/README.md
- packages/tui/README.md
- packages/agent/README.md
- packages/coding-agent/README.md
- packages/mom/README.md
- packages/pods/README.md
- packages/web-ui/README.md

## Architecture

Monorepo with lockstep versioning: all packages share the same version number, updated together on every release.

**Build order matters.** The root `npm run build` builds in dependency order:

```
tui → ai → agent → mcp → coding-agent → mom → web-ui → pods
```

Workspace-internal dependency graph:

```
ai (leaf)          tui (leaf)
  ↓                  ↓
agent               │
  ├→ mcp            │
  ├→ pods            │
  ├→ coding-agent ←──┘ (depends on ai, agent, tui)
  └→ mom            │
web-ui ←────────────┘ (depends on ai, tui)
```

Each package uses `tsconfig.build.json` (not `tsconfig.json`) for emitting to `dist/`. The root `tsconfig.json` (with `noEmit: true` and path aliases) is for IDE resolution only.

**web-ui differs from other packages**: uses `tsc` instead of `tsgo`, has its own `check` script (`biome + tsc --noEmit`), and is excluded from the root tsconfig. Type-check web-ui separately: `cd packages/web-ui && npm run check`.

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). All keybindings must be configurable. Add defaults to the matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)
- **Generated files** — never manually edit: `models.generated.ts`, `test-sessions.ts`, `packages/web-ui/src/app.css`

## Commands

- **`npm run build` must run before `npm run check`.** web-ui's `tsc` needs `.d.ts` files from compiled workspace dependencies.
- After code changes (not docs): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
  - Root check runs: biome (lint+format+write) → `tsgo --noEmit` → browser-smoke check → web-ui check
- `npm run check` does not run tests.
- **Pre-commit hook** runs `npm run check` (+ browser-smoke if ai/web-ui files changed). Reformatted files are re-staged automatically.
- **Running tests:**
  - Full suite: `./test.sh` — unsets API keys so LLM-dependent tests are skipped
  - Single test (vitest packages — ai, agent, coding-agent, mcp): `cd packages/<pkg> && npx vitest --run test/specific.test.ts`
  - **tui** uses `node --test`, not vitest: `cd packages/tui && node --test --import tsx test/specific.test.ts`
  - **web-ui** and **mom** have no test scripts; **pods** has no test script either
  - Always run tests from the package root, not the repo root
  - If you create or modify a test file, you MUST run it and iterate until it passes
- Do not run `npm run dev` or `npm test` (full suite). Only run specific tests as instructed.

## Code Style (biome)

Config in `biome.json`:
- Tabs for indentation (width 3), line width 120
- Scoped to `packages/*/src/**/*.ts` and `packages/*/test/**/*.ts`
- Key rule overrides: `noNonNullAssertion: off`, `noExplicitAny: off`, `noEmptyInterface: off`, `useNodejsImportProtocol: off`

## GitHub Issues

When reading issues:
- Always read all comments: `gh issue view <number> --json title,body,comments,labels,state`

When creating issues:
- Add `pkg:*` labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`
- If an issue spans multiple packages, add all relevant labels

When posting issue/PR comments:
- Write full comment to a temp file, use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown via `--body` in shell commands
- Preview the exact comment text before posting; post exactly one final comment
- If a comment is malformed, delete it immediately and post one corrected comment
- Keep comments concise, technical

When closing issues via commit:
- Include `fixes #<number>` or `closes #<number>` in the commit message

## PR Workflow

- Analyze PRs without pulling locally first
- If user approves: create feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, leave comment in user's tone
- Never open PRs yourself; work in feature branches, merge to main, and push

## Testing pi Interactive Mode with tmux

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "cd /path/to/pi-mono && ./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape
tmux send-keys -t pi-test C-o  # ctrl+o
tmux kill-session -t pi-test
```

## HTTP API Server (packages/coding-agent)

The coding agent can run as an HTTP API server via `--http` or `--mode http`. Source files are in `packages/coding-agent/src/core/`:

- `http-api.ts` — Router and server startup (`createHttpApiServer`, `startHttpServer`)
- `http-api-shared.ts` — Auth (`PI_API_KEY`), session store, upload limits, helpers, HTTP skill loading
- `http-api-chat.ts` — `/prompt` and `/v1/chat/completions` endpoints (SSE streaming support)
- `http-api-skill.ts` — Skill CRUD, skill generation from OpenAPI specs and MCP servers
- `http-api-file.ts` — File operations (list, upload, download, search, mkdir, move, rename, unzip, chunked upload)

### Architecture

`http-api.ts:handleRequest` is a single function that routes all requests by method + pathname — no framework, no middleware stack. Every handler receives raw `IncomingMessage`/`ServerResponse`. Auth is checked once at the top via `authenticate()` (checks `api-key` header against `PI_API_KEY` env var; if unset, auto-generates one and logs it).

Sessions are multi-tenant: keyed by `agentId + sessionId`, with per-user working directories under `~/.pi/agent/sessions/<userId>/<agentId>/<sessionId>/`. Request headers `X-User-Id` and `X-Agent-Id` identify the tenant; some endpoints also accept them in the request body.

### Key endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (no auth required) |
| GET | `/sessions` | List active sessions |
| DELETE | `/sessions/:agentId/:sessionId` | Delete session |
| POST | `/prompt` | Send prompt, get response (with optional SSE streaming) |
| POST | `/v1/chat/completions` | OpenAI-compatible chat completions (streaming via SSE) |
| GET/POST | `/skills`, `/skills/:id`, `/skills/execute/:id` | Skill listing, detail, execution |
| POST | `/skills/upload`, `/skills/generate`, `/skills/from-http-apis`, `/skills/from-mcp` | Skill creation |
| POST | `/skills/register-mcp` | Register MCP server as skill source |
| GET/POST/DELETE | `/files`, `/files/upload/*`, `/files/download`, `/files/search`, etc. | File management |
| GET | `/mcp/servers`, `/mcp/tools` | List registered MCP servers and their tools |
| POST | `/prompts` | Save prompt to disk |
| DELETE | `/prompts` | Delete saved prompt |

### Environment variables

- `PI_API_KEY` — API key for authentication. If unset, one is auto-generated on startup and logged.
- `SKILL_REPO_DIR` — Root directory for skill storage (default: `/app/skill-repo`)

### Conventions

- Skill names starting with `dmp-` automatically get DMP context headers (`X-User-Id`, `X-Agent-Id`, `X-Conversation-Id`) injected into their API definitions and Python scripts.
- Skills are stored on disk as `SKILL.md` + `apis.json` + `scripts/main.py` directories under `SKILL_REPO_DIR/<category>/<name>/`.
- The `/prompt` and `/v1/chat/completions` endpoints auto-append DMP context to the system prompt when `X-User-Id` is present.
- Chunked file uploads use a 3-step flow: `/files/upload/init` → `/files/upload/chunk` → `/files/upload/complete`, with 24-hour session expiry.
- Upload limits are configurable via `HttpServerOptions.uploadLimits` (default: 100MB per file, 500MB total).

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct

## Changelog

Each package has its own `packages/*/CHANGELOG.md` (except `pods` and `mcp`). Do not edit changelogs for external contributor PRs (maintainers add entries).

### Format

Sections under `## [Unreleased]`:

- `### Breaking Changes` — API changes requiring migration
- `### Added` — New features
- `### Changed` — Changes to existing functionality
- `### Fixed` — Bug fixes
- `### Removed` — Removed features

### Rules

- Read the full `[Unreleased]` section before adding entries
- New entries ALWAYS go under `## [Unreleased]`; append to existing subsections, do not create duplicates
- NEVER modify already-released version sections

### Attribution

- Internal: `Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- External: `Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## Adding a New LLM Provider (packages/ai)

Adding a new provider requires changes across multiple files:

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `Api` type union (e.g. `"bedrock-converse-stream"`)
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `KnownProvider` type union

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `packages/ai/package.json` pointing at `./dist/providers/<provider>.js`
- Add `export type` re-exports in `packages/ai/src/index.ts` for provider option types that should remain available from the root entry
- Register the provider in `packages/ai/src/providers/register-builtins.ts` via lazy loader wrappers, do not statically import provider implementation modules there
- Add credential detection in `packages/ai/src/env-api-keys.ts`

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`packages/ai/test/`)

Add provider to: `stream.test.ts`, `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (e.g. GPT and Claude), add at least one pair per family.

For non-standard auth, create utility (e.g. `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: Add default model ID to `DEFAULT_MODELS`
- `src/cli/args.ts`: Add env var documentation
- `README.md`: Add provider setup instructions

### 7. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth, add env vars
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`

## Releasing

**Lockstep versioning**: All packages share the same version number. Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

### Steps

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md
2. **Run release script**:
   ```bash
   npm run release:patch    # Fixes and additions
   npm run release:minor    # API breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

## **CRITICAL** Tool Usage Rules **CRITICAL**

- NEVER use sed/cat to read a file or a range of a file. Always use the read tool (use offset + limit for ranged reads).
- You MUST read every file you modify in full before editing.

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` — these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` — destroys uncommitted changes
- `git checkout .` — destroys uncommitted changes
- `git clean -fd` — deletes untracked files
- `git stash` — stashes ALL changes including other agents' work
- `git add -A` / `git add .` — stages other agents' uncommitted work
- `git commit --no-verify` — bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push