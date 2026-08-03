import type { Agent, AgentTool } from "@mariozechner/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type ApiKeyResolver, MCPClient } from "./client.js";
import { mcpToolToAgentTool } from "./tools.js";
import type { MCPTool } from "./types.js";

export interface MCPServerConfig {
	url: string;
	headers?: Record<string, string>;
	name?: string;
	version?: string;
}

export interface MCPToolManagerConfig {
	userDir?: string;
	projectDir?: string;
	autoload?: boolean;
	apiKeyResolver?: ApiKeyResolver;
}

const DEFAULT_USER_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILENAME = "mcp-servers.json";

interface StoredServerConfig {
	url: string;
	headers?: Record<string, string>;
	name?: string;
	version?: string;
	scope?: "user" | "project";
}

interface ServerConnection {
	client: MCPClient;
	tools: MCPTool[];
	agentTools: Map<string, AgentTool>;
	config: MCPServerConfig;
}

export class MCPToolManager {
	private servers: Map<string, ServerConnection> = new Map();
	private agents: Set<Agent> = new Set();
	private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
	private userDir: string;
	private projectDir: string | null = null;
	private apiKeyResolver: ApiKeyResolver | undefined;

	constructor(config: MCPToolManagerConfig = {}) {
		this.userDir = config.userDir ?? DEFAULT_USER_DIR;
		this.projectDir = config.projectDir ?? null;
		this.apiKeyResolver = config.apiKeyResolver;

		if (config.autoload !== false) {
			this.loadConfig();
		}
	}

	setApiKeyResolver(resolver: ApiKeyResolver): void {
		this.apiKeyResolver = resolver;
	}

	private getUserConfigPath(): string {
		return join(this.userDir, CONFIG_FILENAME);
	}

	private getProjectConfigPath(): string | null {
		if (!this.projectDir) return null;
		return join(this.projectDir, CONFIG_FILENAME);
	}

	private ensureDir(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private loadConfig(): void {
		const userPath = this.getUserConfigPath();
		if (existsSync(userPath)) {
			try {
				const data = JSON.parse(readFileSync(userPath, "utf-8")) as StoredServerConfig[];
				for (const server of data) {
					if (server.scope === "user" || !server.scope) {
						this.addServer(server).catch((err) => {
							console.error(`Failed to load MCP server ${server.url}:`, err);
						});
					}
				}
			} catch (err) {
				console.error("Failed to load user MCP config:", err);
			}
		}

		const projectPath = this.getProjectConfigPath();
		if (projectPath && existsSync(projectPath)) {
			try {
				const data = JSON.parse(readFileSync(projectPath, "utf-8")) as StoredServerConfig[];
				for (const server of data) {
					if (server.scope === "project") {
						this.addServer(server).catch((err) => {
							console.error(`Failed to load project MCP server ${server.url}:`, err);
						});
					}
				}
			} catch (err) {
				console.error("Failed to load project MCP config:", err);
			}
		}
	}

	async saveConfig(scope: "user" | "project" = "user"): Promise<void> {
		const servers: StoredServerConfig[] = [];
		for (const [, connection] of this.servers) {
			if (scope === "user" || scope === "project") {
				servers.push({
					...connection.config,
					scope,
				});
			}
		}

		const path = scope === "user" ? this.getUserConfigPath() : this.getProjectConfigPath();
		if (!path) {
			throw new Error("Project directory not set");
		}

		if (scope === "user") {
			this.ensureDir(this.userDir);
		} else if (this.projectDir) {
			this.ensureDir(this.projectDir);
		}

		writeFileSync(path, JSON.stringify(servers, null, 2));
	}

	setProjectDir(dir: string): void {
		this.projectDir = dir;
	}

	async addServer(config: MCPServerConfig, save: boolean = true): Promise<void> {
		if (this.servers.has(config.url)) {
			throw new Error(`Server already added: ${config.url}`);
		}

		const client = new MCPClient(config, this.apiKeyResolver);
		await client.connect();
		const mcpTools = await client.listTools();

		const agentTools = new Map<string, AgentTool>();
		for (const tool of mcpTools) {
			agentTools.set(tool.name, mcpToolToAgentTool(tool, client));
		}

		const connection: ServerConnection = {
			client,
			tools: mcpTools,
			agentTools,
			config,
		};

		this.servers.set(config.url, connection);
		this.notifyAgents();

		if (save) {
			await this.saveConfig("user");
		}
	}

	async removeServer(url: string, save: boolean = true): Promise<void> {
		const connection = this.servers.get(url);
		if (!connection) {
			throw new Error(`Server not found: ${url}`);
		}

		this.stopPolling(url);
		this.servers.delete(url);
		this.notifyAgents();

		if (save) {
			await this.saveConfig("user");
		}
	}

	async refreshServer(url: string): Promise<void> {
		const connection = this.servers.get(url);
		if (!connection) {
			throw new Error(`Server not found: ${url}`);
		}

		const mcpTools = await connection.client.listTools();
		connection.tools = mcpTools;
		connection.agentTools.clear();

		for (const tool of mcpTools) {
			connection.agentTools.set(tool.name, mcpToolToAgentTool(tool, connection.client));
		}

		this.notifyAgents();
	}

	registerAgent(agent: Agent): void {
		this.agents.add(agent);
		this.syncToolsToAgent(agent);
	}

	unregisterAgent(agent: Agent): void {
		this.agents.delete(agent);
	}

	startPolling(url: string, intervalMs: number = 30000): void {
		if (this.pollingIntervals.has(url)) {
			return;
		}

		const interval = setInterval(async () => {
			try {
				await this.refreshServer(url);
			} catch (error) {
				console.error(`MCP polling error for ${url}:`, error);
			}
		}, intervalMs);

		this.pollingIntervals.set(url, interval);
	}

	stopPolling(url: string): void {
		const interval = this.pollingIntervals.get(url);
		if (interval) {
			clearInterval(interval);
			this.pollingIntervals.delete(url);
		}
	}

	stopAllPolling(): void {
		for (const url of this.pollingIntervals.keys()) {
			this.stopPolling(url);
		}
	}

	getServers(): string[] {
		return Array.from(this.servers.keys());
	}

	getToolsByServer(url: string): AgentTool[] {
		const connection = this.servers.get(url);
		return connection ? Array.from(connection.agentTools.values()) : [];
	}

	getAllTools(): AgentTool[] {
		const allTools: AgentTool[] = [];
		for (const connection of this.servers.values()) {
			allTools.push(...connection.agentTools.values());
		}
		return allTools;
	}

	private notifyAgents(): void {
		for (const agent of this.agents) {
			this.syncToolsToAgent(agent);
		}
	}

	private syncToolsToAgent(agent: Agent): void {
		const allTools = this.getAllTools();
		agent.setTools(allTools);
	}
}

export function createMCPToolManager(config?: MCPToolManagerConfig): MCPToolManager {
	return new MCPToolManager(config);
}
