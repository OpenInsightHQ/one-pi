# @mariozechner/pi-mcp

MCP (Model Context Protocol) client for connecting to external MCP servers and exposing their tools as pi-agent-core tools.

## Installation

```bash
npm install @mariozechner/pi-mcp
```

## Quick Start

```typescript
import { MCPToolManager } from "@mariozechner/pi-mcp";
import { Agent } from "@mariozechner/pi-agent-core";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    tools: [],
  },
});

const manager = createMCPToolManager();
manager.registerAgent(agent);

await manager.addServer({ url: "https://mcp-server.example.com/mcp" });
```

## MCPToolManager

The `MCPToolManager` manages multiple MCP server connections and automatically syncs tools to registered agents.

### Basic Usage

```typescript
import { createMCPToolManager } from "@mariozechner/pi-mcp";

const manager = createMCPToolManager();
manager.registerAgent(agent);

await manager.addServer({ url: "https://mcp-server.example.com/mcp" });
await manager.addServer({
  url: "https://another-server.example.com/mcp",
  headers: { "Authorization": "Bearer token" },
});
```

### Dynamic Add/Remove Servers

```typescript
await manager.addServer({ url: "https://server-a.example.com/mcp" });
await manager.addServer({ url: "https://server-b.example.com/mcp" });

// Remove a server (tools automatically removed from agents)
await manager.removeServer("https://server-a.example.com/mcp");

// Refresh tools from a server
await manager.refreshServer("https://server-b.example.com/mcp");
```

### Polling for Updates

Automatically refresh tools from servers at regular intervals:

```typescript
manager.startPolling("https://mcp-server.example.com/mcp", 30000);

manager.stopPolling("https://mcp-server.example.com/mcp");

manager.stopAllPolling();
```

### Query Server State

```typescript
manager.getServers();
manager.getToolsByServer("https://mcp-server.example.com/mcp");
manager.getAllTools();
```

## Persistence

MCP servers are automatically saved to `~/.pi/agent/mcp-servers.json` and loaded on startup.

```typescript
const manager = createMCPToolManager({
  userDir: "~/.pi/agent",
  projectDir: "./.pi",
  autoload: true,
});

// Manually save/load
await manager.saveConfig("user");
await manager.saveConfig("project");

// Set project directory for local storage
manager.setProjectDir("/path/to/project/.pi");
```

## API Key Authentication

MCP tool calls can use dynamic API key resolution:

```typescript
const manager = createMCPToolManager({
  apiKeyResolver: async (provider) => {
    // Return the API key for the given provider
    return process.env.MCP_API_KEY;
  },
});

// Or set it later
manager.setApiKeyResolver(async (provider) => {
  return getApiKeyFromStorage(provider);
});
```

The resolver is called before each MCP request to get the current API key, enabling short-lived tokens (like OAuth) to be refreshed automatically.

## MCPClient

For fine-grained control, use `MCPClient` directly:

```typescript
import { MCPClient } from "@mariozechner/pi-mcp";

const client = new MCPClient({
  url: "https://mcp-server.example.com/mcp",
  headers: { "Authorization": "Bearer token" },
  name: "my-app",
  version: "1.0.0",
});

await client.connect();
const tools = await client.listTools();
const result = await client.callTool({ name: "tool_name", arguments: { arg: "value" } });
```

## Converting MCP Tools

Convert MCP tools to pi-agent-core `AgentTool` format:

```typescript
import { MCPClient, mcpToolToAgentTool } from "@mariozechner/pi-mcp";

const client = new MCPClient({ url: "https://mcp-server.example.com/mcp" });
await client.connect();

const mcpTools = await client.listTools();
const agentTools = mcpTools.map(tool => mcpToolToAgentTool(tool, client));

agent.setTools(agentTools);
```

## License

MIT
