<h1 align="center">ONE-PI — Enterprise Agent Platform</h1>

<p align="center">
  The reasoning engine of AI employees.<br/>
  A server-side agent platform that turns LLMs into virtual experts —<br/>
  equipped with shared skills, exposed as an OpenAI-compatible API.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-green" alt="Node >= 22">
  <img src="https://img.shields.io/badge/runtime-Docker-2496ED" alt="Docker">
</p>

## What is ONE-PI?

ONE-PI is the **enterprise agent platform** in the Open Insight stack — the "brain"
of AI employees. It takes PI, a proven open-source agent core, and rebuilds it for
the server side: stateful sessions, authentication, a shared skill repository, and
an HTTP API that any client can call.

| Component | Role |
| --- | --- |
| [openinsight](https://github.com/OpenInsightHQ/openinsight) | One-command deployment & release entry |
| [ARP](https://github.com/OpenInsightHQ/arp) (Agent Runtime Platform) | Where AI employees run — chat, auth, integrations, UI |
| **ONE-PI** (this repo) | How AI employees think — expert agents, skills, the agent loop as a service |
| DMP *(commercial)* | Trains AI employees on your business before they start |

A single component is not the product. ARP without ONE-PI is a chat shell; ONE-PI
without ARP is an API with no workplace. AI employees come alive when the pieces
assemble — and the training layer (DMP) is what enterprises pay for.

## How AI employees think

Every ONE-PI agent runs the same loop:

**Understand → Reason → Discover → Compose → Execute**

On top of the loop sits a bench of **virtual experts** — each a prompt-defined
specialist with its own tools:

| Virtual expert | Defined by | Equipped with |
| --- | --- | --- |
| Sales Analytics Expert | prompt | MCP / API / SKILL |
| Financial Analytics Expert | prompt | MCP / API / SKILL |
| Customer Churn Expert | prompt | MCP / API / SKILL |
| … Expert N | prompt | MCP / API / SKILL |

Experts are cheap to define and endlessly extensible: a new expert is a prompt plus
a tool set, not a new codebase.

## Skills: build once, every agent can call it

Skills are the platform's capability library. A skill is a directory with a spec —
a frontmatter manifest plus scripts and resources. Skills live in a skill repository
(`SKILL_REPO_DIR`) and are discovered automatically.

The same skill system is shared with ARP — this is what *"Any skill"* in the
[ARP README](https://github.com/OpenInsightHQ/arp#why-arp) refers to. An enterprise
builds a skill once (say, *query the sales warehouse*); every agent and every expert
on the platform can invoke it at runtime.

## Server mode: an agent loop behind an OpenAI-compatible API

This is how ONE-PI plugs into the rest of the platform.

ONE-PI speaks `/v1/chat/completions`. To ARP — or any OpenAI-compatible client — it
looks like just another model. Behind the endpoint a full agent runs: planning, tool
calls, skills, and stateful sessions.

```bash
# .env
PI_HTTP_PORT=3000
PI_API_KEY=your-secure-api-key
SKILL_REPO_DIR=/app/skill-repo
PI_PROVIDER=opencode-go     # any provider you configure
PI_MODEL=minimax-m2.7
```

- `POST /v1/chat/completions` — OpenAI-compatible chat (streaming), backed by an agent session
- File-upload and skill-management endpoints for the skill repository
- API-key auth (`PI_API_KEY`), multi-session management

## Packages

Monorepo with lockstep versioning:

| Package | What it is |
| --- | --- |
| `ai` | Unified LLM API with automatic model discovery |
| `agent` | General-purpose agent loop — transport, state, attachments |
| `coding-agent` | Agent core: CLI tools + **enterprise HTTP server** (the focus of this fork) |
| `tui` | Terminal UI library with differential rendering |
| `web-ui` | Web UI components for AI chat interfaces |
| `mcp` | MCP client for external tool servers |
| `mom` | Slack bot that delegates to the agent |
| `pods` | CLI for managing vLLM deployments on GPU pods |

## Quick Start

### Run as a server (Docker)

```bash
cp .env.example .env          # set PI_API_KEY + one provider key
mkdir skill-repo
docker build -t one-pi .
docker run -d --env-file .env -p 3000:3000 -v "$PWD/skill-repo:/app/skill-repo" one-pi

curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $PI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax-m2.7","messages":[{"role":"user","content":"hello"}]}'
```

### Run locally (CLI)

```bash
npm install
npm run build
node packages/coding-agent/dist/cli.js
```

## Development

Build order matters — the root `npm run build` respects the dependency graph:

```
tui → ai → agent → mcp → coding-agent → mom → web-ui → pods
```

Each package emits via its own `tsconfig.build.json`; the root `tsconfig.json` is
for IDE resolution only. See [AGENTS.md](AGENTS.md) for the full development rules.

## Built on pi-mono

> ℹ️ Technical note: ONE-PI is built on a fork of
> [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner. The upstream
> CLI, agent core, and provider layer are inherited from it.

ONE-PI would not exist without Mario Zechner's work on PI.

## License

Released under the Apache-2.0 License.

> Portions of this project derive from pi-mono
> (MIT, © Mario Zechner).
