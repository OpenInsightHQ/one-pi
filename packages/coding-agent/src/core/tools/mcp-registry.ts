import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "../../config.js";

async function parseMcpResponse<T>(response: Response): Promise<T> {
	const contentType = response.headers.get("content-type") ?? "";

	if (contentType.includes("text/event-stream")) {
		const text = await response.text();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("data:")) {
				const data = trimmed.slice(5).trim();
				if (data && data !== "[DONE]") {
					try {
						return JSON.parse(data) as T;
					} catch {}
				}
			}
		}
		throw new Error("SSE response contained no valid JSON data");
	}

	return (await response.json()) as T;
}

function formatMcpError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as Error & { cause?: { message?: string; code?: string } }).cause;
	if (cause?.message) return `${error.message}: ${cause.message}`;
	if (cause?.code) return `${error.message}: ${cause.code}`;
	return error.message;
}

const TRANSIENT_CODES = new Set([
	"UND_ERR_SOCKET",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
]);

function isTransientError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const cause = (error as Error & { cause?: { code?: string } }).cause;
	if (cause?.code && TRANSIENT_CODES.has(cause.code)) return true;
	return false;
}

const MCP_MAX_RETRIES = 3;
const MCP_RETRY_BASE_MS = 500;

async function mcpFetch(url: string, init: RequestInit, label: string): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= MCP_MAX_RETRIES; attempt++) {
		try {
			return await fetch(url, init);
		} catch (error) {
			lastError = error;
			if (attempt < MCP_MAX_RETRIES && isTransientError(error)) {
				const delay = MCP_RETRY_BASE_MS * 2 ** attempt;
				console.warn(
					`[MCP] ${label} attempt ${attempt + 1} failed (${formatMcpError(error)}), retrying in ${delay}ms...`,
				);
				await new Promise((r) => setTimeout(r, delay));
			} else {
				throw error;
			}
		}
	}
	throw lastError;
}

const MCP_REGISTRY_CLIENT_INFO = { name: "pi-mcp-registry", version: "1.0.0" };

/**
 * Performs the MCP Streamable HTTP handshake: sends `initialize`, captures the
 * `Mcp-Session-Id` header when present (2025-03-26 spec), and delivers the
 * required `notifications/initialized` notification. Returns headers that
 * callers MUST merge into every follow-up request.
 *
 * Session-enforcing servers (e.g. ModelScope, Cloudflare-hosted fastmcp) reject
 * `tools/list` / `tools/call` with HTTP 400 or a JSON-RPC -32602 error until
 * both the session header is replayed and the initialized notification lands.
 */
async function mcpInitializeSession(
	url: string,
	headers: Record<string, string>,
	label: string,
): Promise<Record<string, string>> {
	const initResponse = await mcpFetch(
		url,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: MCP_REGISTRY_CLIENT_INFO,
				},
			}),
		},
		`${label} (initialize)`,
	);

	if (!initResponse.ok) {
		throw new Error(`MCP connection failed: ${initResponse.status} ${initResponse.statusText}`);
	}

	const initData = await parseMcpResponse<{ error?: { message: string } }>(initResponse);
	if (initData.error) {
		throw new Error(`MCP initialize error: ${initData.error.message}`);
	}

	const sessionHeaders: Record<string, string> = { ...headers };
	const sessionId = initResponse.headers.get("Mcp-Session-Id");
	if (sessionId) {
		sessionHeaders["Mcp-Session-Id"] = sessionId;
	}

	try {
		const notifResponse = await mcpFetch(
			url,
			{
				method: "POST",
				headers: sessionHeaders,
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			},
			`${label} (notifications/initialized)`,
		);
		await notifResponse.text().catch(() => {});
	} catch (error) {
		console.warn(`[MCP] ${label} notifications/initialized failed (non-fatal): ${formatMcpError(error)}`);
	}

	return sessionHeaders;
}

/**
 * MCP 工具注册表
 * 将 MCP 服务器的工具自动注册为 PI 原生 Agent 工具
 */

const MCP_REGISTRY_FILE = "mcp-tool-registry.json";

export interface MCPToolConfig {
	serverUrl: string;
	serverName: string;
	toolName: string;
	toolDescription: string;
	parameters: Record<string, MCPParamConfig>;
	headers?: Record<string, string>;
}

export interface MCPParamConfig {
	type: "string" | "number" | "boolean";
	description?: string;
	required?: boolean;
}

interface MCPRegistryEntry {
	serverUrl: string;
	serverName: string;
	headers?: Record<string, string>;
	tools: MCPToolConfig[];
}

function getRegistryPath(): string {
	return join(getAgentDir(), MCP_REGISTRY_FILE);
}

export function loadMCPRegistry(): MCPRegistryEntry[] {
	const path = getRegistryPath();
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return [];
	}
}

function saveMCPRegistry(entries: MCPRegistryEntry[]): void {
	writeFileSync(getRegistryPath(), JSON.stringify(entries, null, 2));
}

/**
 * 从 MCP 服务器发现工具并注册
 * 返回注册的工具数量
 */
export async function discoverAndRegisterMCPTools(
	serverUrl: string,
	serverName: string,
	headers?: Record<string, string>,
): Promise<{ tools: MCPToolConfig[]; error?: string }> {
	const mcpHeaders = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...(headers || {}),
	};

	// 1. 连接 MCP 服务器，初始化（含会话握手）
	let sessionHeaders: Record<string, string>;
	try {
		sessionHeaders = await mcpInitializeSession(serverUrl, mcpHeaders, `discoverAndRegisterMCPTools ${serverUrl}`);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] discoverAndRegisterMCPTools fetch failed for ${serverUrl} (initialize):`, msg, error);
		return { tools: [], error: `MCP connection failed: ${msg}` };
	}

	// 2. 获取工具列表（包含完整的 schema）
	let listResponse: Response;
	try {
		listResponse = await mcpFetch(
			serverUrl,
			{
				method: "POST",
				headers: sessionHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {},
				}),
			},
			`discoverAndRegisterMCPTools ${serverUrl} (tools/list)`,
		);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] discoverAndRegisterMCPTools fetch failed for ${serverUrl} (tools/list):`, msg, error);
		return { tools: [], error: `MCP tools/list failed: ${msg}` };
	}

	if (!listResponse.ok) {
		return { tools: [], error: `MCP list tools failed: ${listResponse.status}` };
	}

	const listData = await parseMcpResponse<{
		error?: { message: string };
		result?: {
			tools: Array<{
				name: string;
				description?: string;
				inputSchema?: {
					type: string;
					properties?: Record<string, any>;
					required?: string[];
				};
			}>;
		};
	}>(listResponse);

	if (listData.error) {
		return { tools: [], error: `MCP error: ${listData.error.message}` };
	}

	const tools: MCPToolConfig[] = (listData.result?.tools || []).map((tool) => {
		// 从 inputSchema 提取参数
		const params: Record<string, MCPParamConfig> = {};
		if (tool.inputSchema?.properties) {
			for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
				const s = schema as any;
				params[key] = {
					type: mapJSONSchemaType(s.type),
					description: s.description || "",
					required: tool.inputSchema.required?.includes(key) || false,
				};
			}
		}

		return {
			serverUrl,
			serverName,
			toolName: tool.name,
			toolDescription: tool.description || `${tool.name} from ${serverName}`,
			parameters: params,
			headers,
		};
	});

	// 3. 保存到注册表
	const registry = loadMCPRegistry();
	const existingIndex = registry.findIndex((e) => e.serverUrl === serverUrl);
	const entry: MCPRegistryEntry = { serverUrl, serverName, headers, tools };

	if (existingIndex >= 0) {
		registry[existingIndex] = entry;
	} else {
		registry.push(entry);
	}
	saveMCPRegistry(registry);

	// 4. 更新运行时工具缓存
	refreshRuntimeTools();

	return { tools };
}

/**
 * 从注册表移除 MCP 服务器的工具
 */
export function unregisterMCPTools(serverUrl: string): boolean {
	const registry = loadMCPRegistry();
	const index = registry.findIndex((e) => e.serverUrl === serverUrl);
	if (index < 0) return false;

	registry.splice(index, 1);
	saveMCPRegistry(registry);
	refreshRuntimeTools();
	return true;
}

/**
 * 调用 MCP 工具
 */
async function callMCPTool(config: MCPToolConfig, params: Record<string, unknown>): Promise<unknown> {
	const mcpHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...(config.headers || {}),
	};

	let sessionHeaders: Record<string, string>;
	try {
		sessionHeaders = await mcpInitializeSession(config.serverUrl, mcpHeaders, `callMCPTool ${config.serverUrl}`);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(
			`[MCP] callMCPTool handshake failed for ${config.serverUrl} (tools/call ${config.toolName}):`,
			msg,
			error,
		);
		throw new Error(`MCP call failed: ${msg}`);
	}

	let response: Response;
	try {
		response = await mcpFetch(
			config.serverUrl,
			{
				method: "POST",
				headers: sessionHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: Date.now(),
					method: "tools/call",
					params: {
						name: config.toolName,
						arguments: params,
					},
				}),
			},
			`callMCPTool ${config.serverUrl} (tools/call ${config.toolName})`,
		);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(
			`[MCP] callMCPTool fetch failed for ${config.serverUrl} (tools/call ${config.toolName}):`,
			msg,
			error,
		);
		throw new Error(`MCP call failed: ${msg}`);
	}

	if (!response.ok) {
		throw new Error(`MCP call failed: ${response.status} ${response.statusText}`);
	}

	const data = await parseMcpResponse<{
		error?: { message: string };
		result?: { content?: Array<{ type: string; text?: string }> };
	}>(response);

	if (data.error) {
		throw new Error(`MCP tool error: ${data.error.message}`);
	}

	// 提取文本内容
	if (data.result?.content) {
		const texts = data.result.content.filter((c) => c.type === "text" && c.text).map((c) => c.text!);
		if (texts.length > 0) {
			try {
				return JSON.parse(texts.join("\n"));
			} catch {
				return texts.join("\n");
			}
		}
	}

	return data.result;
}

function mapJSONSchemaType(type: string | undefined): "string" | "number" | "boolean" {
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	return "string";
}

// ========== 运行时工具缓存 ==========

let _cachedTools: AgentTool[] | null = null;

/**
 * 根据 MCP 注册表动态生成原生 Agent 工具
 */
export function generateMCPAgentTools(): AgentTool[] {
	const registry = loadMCPRegistry();
	const tools: AgentTool[] = [];

	for (const entry of registry) {
		for (const config of entry.tools) {
			tools.push(createMCPAgentTool(config));
		}
	}

	return tools;
}

/**
 * 获取缓存的 MCP 工具（避免每次请求都重新生成）
 */
export function getCachedMCPTools(): AgentTool[] {
	if (!_cachedTools) {
		_cachedTools = generateMCPAgentTools();
	}
	return _cachedTools;
}

/**
 * 刷新运行时工具缓存
 */
function refreshRuntimeTools(): void {
	_cachedTools = null; // 下次 getCachedMCPTools 会重新生成
	console.log(`[MCP Registry] Tools cache refreshed`);
}

/**
 * 将单个 MCP 工具配置转为 PI 原生 Agent 工具
 */
function createMCPAgentTool(config: MCPToolConfig): AgentTool {
	// 动态构建参数 JSON Schema（简单的 object schema）
	const properties: Record<string, any> = {};
	for (const [key, param] of Object.entries(config.parameters)) {
		properties[key] = { type: param.type, description: param.description || "" };
	}
	const requiredKeys = Object.entries(config.parameters)
		.filter(([, p]) => p.required)
		.map(([k]) => k);

	// 用简单的 object schema（与 AgentTool parameters 兼容）
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const parameters: any = {
		type: "object",
		properties,
		required: requiredKeys.length > 0 ? requiredKeys : undefined,
		additionalProperties: true,
	};

	const toolName = `mcp_${config.toolName}`;
	const description = `[${config.serverName}] ${config.toolDescription}`;

	return {
		name: toolName,
		label: toolName,
		description,
		parameters,
		async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<AgentToolResult<any>> {
			try {
				const result = await callMCPTool(config, params);
				const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				return {
					content: [{ type: "text" as const, text }],
					details: { server: config.serverName, tool: config.toolName },
				};
			} catch (error) {
				const message = formatMcpError(error);
				console.error(`[MCP] tool execution failed for ${config.serverName}/${config.toolName}:`, message, error);
				return {
					content: [{ type: "text" as const, text: `MCP 工具调用失败: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}
