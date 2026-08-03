# Skills API

Skill management endpoints for the HTTP API server.

## Configuration

- `SKILL_REPO_DIR`: Base directory for skill repository (default: `/app/skill-repo`)

## Endpoints

### List Skills

Retrieve all available skills from local storage, MCP, HTTP, and the skill repository.

```
GET /skills
```

**Query Parameters:**

| Parameter | Type   | Description                          |
|-----------|--------|--------------------------------------|
| groupBy   | string | Group skills by `source` or `category` |
| category  | string | Filter skills by category (repo only) |

**Response:**

```json
{
  "skills": [
    {
      "name": "skill-name",
      "description": "Skill description",
      "source": "repo",
      "scope": "global",
      "group": "coding"
    }
  ]
}
```

With `groupBy=source`:
```json
{
  "groups": [
    {
      "name": "repo",
      "source": "repo",
      "items": [...]
    }
  ]
}
```

With `groupBy=category`:
```json
{
  "categories": [
    {
      "name": "coding",
      "items": [...]
    }
  ]
}
```

---

### Upload Skill

Upload a skill as a zip archive to the skill repository.

```
POST /skills/upload
Content-Type: multipart/form-data
```

**Form Fields:**

| Field    | Type   | Required | Description              |
|----------|--------|----------|--------------------------|
| category | string | Yes      | Category for the skill   |
| file     | file   | Yes      | Zip archive of the skill |

**Response:**

```json
{
  "success": true,
  "skill": {
    "name": "my-skill",
    "description": "Skill description from SKILL.md",
    "category": "coding",
    "path": "/app/skill-repo/coding/my-skill"
  }
}
```

---

### Authorize Skill

Create a symbolic link to make a skill available to users.

```
POST /skills/authorize
```

**Request Body:**

| Field     | Type   | Required | Description                            |
|-----------|--------|----------|----------------------------------------|
| skillName | string | Yes      | Name of the skill                      |
| category  | string | Yes      | Category of the skill                  |
| target    | string | No       | User ID to authorize for (omit for global) |

**Response (global):**

```json
{
  "success": true,
  "scope": "global",
  "linkPath": "/home/user/.pi/agent/skills/my-skill"
}
```

**Response (user-specific):**

```json
{
  "success": true,
  "scope": "user",
  "target": "user123",
  "linkPath": "/app/http-sessions/user123/skills/my-skill"
}
```

---

### Deauthorize Skill

Remove a symbolic link to revoke a user's access to a skill.

```
DELETE /skills/authorize
```

**Request Body:**

| Field     | Type   | Required | Description                            |
|-----------|--------|----------|----------------------------------------|
| skillName | string | Yes      | Name of the skill                      |
| target    | string | No       | User ID to deauthorize (omit for global) |

**Response:**

```json
{
  "success": true,
  "scope": "global",
  "removed": "/home/user/.pi/agent/skills/my-skill"
}
```

---

### Execute Skill

Execute an MCP or HTTP skill.

```
POST /skills/execute
```

**Request Body:**

| Field      | Type   | Required | Description                      |
|------------|--------|----------|----------------------------------|
| skillName  | string | Yes      | Name of the skill (with prefix)  |
| parameters | object | No       | Parameters to pass to the skill  |

**Response:**

```json
{
  "success": true,
  "result": {}
}
```

---

### Generate Skill

Generate a skill from conversation messages.

```
POST /skills/generate
```

**Request Body:**

| Field       | Type   | Required | Description                      |
|-------------|--------|----------|----------------------------------|
| name        | string | Yes      | Name for the new skill           |
| description | string | Yes      | Description for the skill         |
| messages    | array  | Yes      | Conversation messages to convert |

**Response:**

```json
{
  "success": true,
  "outputPath": "/path/to/generated/skill"
}
```