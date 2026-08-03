> pi can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Pi implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Pi loads skills from:

- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- Direct `.md` files in the skills directory root
- Recursive `SKILL.md` files under subdirectories

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.pi/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, pi scans skill locations and extracts names and descriptions
2. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses `read` to load the full SKILL.md (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

```markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
\`\`\`bash
cd /path/to/skill && npm install
\`\`\`

## Usage

\`\`\`bash
./scripts/process.sh <input>
\`\`\`
```

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Pi validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
```markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

\`\`\`bash
cd /path/to/brave-search && npm install
\`\`\`

## Search

\`\`\`bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
\`\`\`

## Extract Page Content

\`\`\`bash
./content.js https://example.com
\`\`\`
```

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription

## HTTP API: Generate Skill from Conversation

The `/skills/generate` endpoint creates a skill from conversation history containing tool calls.

### Endpoint

```
POST /skills/generate
```

### Request

```json
{
  "name": "my-skill",
  "description": "Extract data and generate report",
  "messages": [
    { "role": "user", "content": "...", "timestamp": 1234567890000 },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I'll help you..." },
        { "type": "toolCall", "id": "call_1", "name": "fetch_data", "arguments": { "query": "sales 2024" } }
      ],
      "timestamp": 1234567891000
    },
    {
      "role": "toolResult",
      "toolCallId": "call_1",
      "toolName": "fetch_data",
      "content": [{ "type": "text", "text": "..." }],
      "isError": false,
      "timestamp": 1234567892000
    }
  ],
  "parameters": [
    { "name": "date_range", "type": "date-range", "required": true, "description": "Query date range" },
    { "name": "region", "type": "string", "required": false, "description": "Geographic region" }
  ],
  "outputPath": "~/.agents/skills"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Skill name (lowercase a-z, 0-9, hyphens, 1-64 chars) |
| `description` | string | Yes | Skill description (max 1024 chars) |
| `messages` | array | Yes | Conversation history with tool calls |
| `parameters` | array | No | Parameter definitions (inferred from tool calls if omitted) |
| `outputPath` | string | No | Output directory (default: `~/.agents/skills/`) |

### Parameter Definition

```typescript
interface SkillParameterDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "date-range" | "file" | "file[]";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}
```

### Response

```json
{
  "success": true,
  "skill": {
    "name": "my-skill",
    "path": "~/.agents/skills/my-skill/SKILL.md",
    "scriptPath": "~/.agents/skills/my-skill/scripts/main.py",
    "requirementsPath": "~/.agents/skills/my-skill/scripts/requirements.txt"
  }
}
```

### Output Structure

```
my-skill/
├── SKILL.md           # Skill description and workflow
├── scripts/
│   ├── main.py        # Generated Python script
│   └── requirements.txt
```

### Generated Python Script

The script includes:
- Parameter parsing and validation
- Tool call chain execution
- Result passing between steps
- JSON output

### Example Usage

1. Generate skill from conversation:
```bash
curl -X POST http://localhost:3000/skills/generate \
  -H "Content-Type: application/json" \
  -d '{
    "name": "sales-report",
    "description": "Generate sales report from query",
    "messages": [ ... ]
  }'
```

2. Use the skill:
```bash
cd ~/.agents/skills/sales-report
pip install -r scripts/requirements.txt
python scripts/main.py --date_range "2024-01-01,2024-12-31" --region "North"
```
