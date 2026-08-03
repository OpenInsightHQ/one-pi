import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MCPClient } from "../src/client.js";
import { createMCPToolManager } from "../src/manager.js";
import { convertInputSchema, mcpToolToAgentTool } from "../src/tools.js";
import type { MCPTool } from "../src/types.js";

const MOCK_SERVER_URL = "http://localhost:3002/mcp";

const mockMcpTool: MCPTool = {
	name: "test_tool",
	description: "A test tool",
	inputSchema: {
		type: "object",
		properties: {
			message: { type: "string", description: "Message to echo" },
		},
		required: ["message"],
	},
};

const mockMcpToolsResponse = {
	tools: [mockMcpTool],
};

const mockMcpCallResponse = {
	content: [{ type: "text" as const, text: "Echo: hello" }],
};

let mockServer: any;

async function startMockServer(port: number = 3002) {
	const { createServer } = await import("http");

	const server = createServer(async (req, res) => {
		if (req.method === "POST") {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const json = JSON.parse(body);

			if (json.method === "initialize") {
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: {
							protocolVersion: "2024-11-05",
							capabilities: {},
							serverInfo: { name: "mock-mcp", version: "1.0.0" },
						},
					}),
				);
			} else if (json.method === "tools/list") {
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: mockMcpToolsResponse,
					}),
				);
			} else if (json.method === "tools/call") {
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: mockMcpCallResponse,
					}),
				);
			}
		}
	});

	await new Promise<void>((resolve) => server.listen(port, resolve));
	return server;
}

describe("MCPClient", () => {
	beforeAll(async () => {
		mockServer = await startMockServer(3002);
	});

	afterAll(async () => {
		if (mockServer) {
			await new Promise<void>((resolve) => mockServer.close(resolve));
		}
	});

	it("should connect to MCP server", async () => {
		const client = new MCPClient({ url: MOCK_SERVER_URL });
		await client.connect();
	});

	it("should list tools from MCP server", async () => {
		const client = new MCPClient({ url: MOCK_SERVER_URL });
		await client.connect();
		const tools = await client.listTools();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("test_tool");
	});

	it("should call tool on MCP server", async () => {
		const client = new MCPClient({ url: MOCK_SERVER_URL });
		await client.connect();
		const result = await client.callTool({
			name: "test_tool",
			arguments: { message: "hello" },
		});
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toBe("Echo: hello");
	});

	it("should use apiKeyResolver for authentication", async () => {
		const apiKeyResolver = vi.fn().mockResolvedValue("test-api-key");
		const client = new MCPClient({ url: MOCK_SERVER_URL }, apiKeyResolver);
		await client.connect();

		expect(apiKeyResolver).toHaveBeenCalledWith("mcp");
	});
});

describe("tools", () => {
	let toolsServer: any;

	beforeAll(async () => {
		toolsServer = await startMockServer(3004);
	});

	afterAll(async () => {
		if (toolsServer) {
			await new Promise<void>((resolve) => toolsServer.close(resolve));
		}
	});

	it("should convert MCP input schema to TypeBox", () => {
		const schema = convertInputSchema(mockMcpTool.inputSchema);
		expect(schema).toBeDefined();
	});

	it("should convert MCP tool to AgentTool", async () => {
		const client = new MCPClient({ url: "http://localhost:3004/mcp" });
		await client.connect();

		const agentTool = mcpToolToAgentTool(mockMcpTool, client);
		expect(agentTool.name).toBe("test_tool");
		expect(agentTool.label).toBe("Test Tool");
		expect(agentTool.description).toBe("A test tool");

		const result = await agentTool.execute("tool-call-id", { message: "hello" });
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as any).text).toContain("Echo:");
	});
});

describe("MCPToolManager", () => {
	beforeAll(async () => {
		mockServer = await startMockServer(3003);
	});

	afterAll(async () => {
		if (mockServer) {
			await new Promise<void>((resolve) => mockServer.close(resolve));
		}
	});

	it("should create MCPToolManager", () => {
		const manager = createMCPToolManager({ autoload: false });
		expect(manager).toBeDefined();
	});

	it("should add and remove server", async () => {
		const manager = createMCPToolManager({ autoload: false });
		const url = "http://localhost:3003/mcp";

		await manager.addServer({ url });
		expect(manager.getServers()).toContain(url);

		const tools = manager.getAllTools();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("test_tool");

		await manager.removeServer(url);
		expect(manager.getServers()).not.toContain(url);
	});

	it("should persist server config", async () => {
		const { mkdtempSync, rmSync, readFileSync } = await import("fs");
		const { join } = await import("path");
		const { tmpdir } = await import("os");

		const tempDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
		const configPath = join(tempDir, "mcp-servers.json");

		try {
			const manager = createMCPToolManager({
				userDir: tempDir,
				autoload: false,
			});

			await manager.addServer({ url: "http://localhost:3003/mcp" });

			const config = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(config).toHaveLength(1);
			expect(config[0].url).toBe("http://localhost:3003/mcp");

			await manager.removeServer("http://localhost:3003/mcp");

			const configAfter = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(configAfter).toHaveLength(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("should use apiKeyResolver", async () => {
		const apiKeyResolver = vi.fn().mockResolvedValue("test-key");

		const manager = createMCPToolManager({
			autoload: false,
			apiKeyResolver,
		});

		await manager.addServer({ url: "http://localhost:3003/mcp" });

		expect(apiKeyResolver).toHaveBeenCalledWith("mcp");
	});

	it("should sync tools to registered agents", async () => {
		const { Agent } = await import("@mariozechner/pi-agent-core");
		const { getModel } = await import("@mariozechner/pi-ai");

		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: getModel("anthropic", "claude-sonnet-4-20250514"),
				tools: [],
			},
		});

		const manager = createMCPToolManager({ autoload: false });
		manager.registerAgent(agent);

		await manager.addServer({ url: "http://localhost:3003/mcp" });

		expect(agent.state.tools).toHaveLength(1);
		expect(agent.state.tools[0].name).toBe("test_tool");

		await manager.removeServer("http://localhost:3003/mcp");

		expect(agent.state.tools).toHaveLength(0);
	});
});
