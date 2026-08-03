import type {
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPCallToolRequest,
	MCPCallToolResult,
	MCPClientConfig,
	MCPListToolsResult,
	MCPTool,
} from "./types.js";

export type ApiKeyResolver = (provider: string) => Promise<string | undefined> | string | undefined;

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

export async function mcpFetch(url: string, init: RequestInit, label: string): Promise<Response> {
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

export function formatMcpError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as Error & { cause?: { message?: string; code?: string } }).cause;
	if (cause?.message) return `${error.message}: ${cause.message}`;
	if (cause?.code) return `${error.message}: ${cause.code}`;
	return error.message;
}

export async function parseMcpResponse<T>(response: Response): Promise<T> {
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

export class MCPClient {
	private url: string;
	private baseHeaders: Record<string, string>;
	private name: string;
	private version: string;
	private requestId = 0;
	private apiKeyResolver: ApiKeyResolver | undefined;
	private sessionId: string | undefined;

	constructor(config: MCPClientConfig, apiKeyResolver?: ApiKeyResolver) {
		this.url = config.url;
		this.baseHeaders = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...config.headers,
		};
		this.name = config.name ?? "pi-mcp-client";
		this.version = config.version ?? "1.0.0";
		this.apiKeyResolver = apiKeyResolver;
	}

	private async getHeaders(): Promise<Record<string, string>> {
		const headers = { ...this.baseHeaders };
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		if (this.apiKeyResolver) {
			const apiKey = await this.apiKeyResolver("mcp");
			if (apiKey) {
				headers.Authorization = `Bearer ${apiKey}`;
			}
		}
		return headers;
	}

	async connect(): Promise<void> {
		const headers = await this.getHeaders();
		let response: Response;
		try {
			response = await mcpFetch(
				this.url,
				{
					method: "POST",
					headers,
					body: JSON.stringify(
						this.createRequest("initialize", {
							protocolVersion: "2024-11-05",
							capabilities: {},
							clientInfo: {
								name: this.name,
								version: this.version,
							},
						}),
					),
				},
				`fetch ${this.url} (initialize)`,
			);
		} catch (error) {
			console.error(`[MCP] fetch failed for ${this.url} (initialize):`, formatMcpError(error), error);
			throw new Error(`MCP connection failed: ${formatMcpError(error)}`);
		}

		if (!response.ok) {
			throw new Error(`MCP connection failed: ${response.status} ${response.statusText}`);
		}

		const data = await parseMcpResponse<JSONRPCResponse>(response);
		if (data.error) {
			throw new Error(`MCP initialize error: ${data.error.message}`);
		}

		// Capture the session id when the server assigns one (MCP Streamable
		// HTTP transport, 2025-03-26 spec). It is replayed on every subsequent
		// request via getHeaders().
		const sessionId = response.headers.get("Mcp-Session-Id");
		if (sessionId) {
			this.sessionId = sessionId;
		}

		// Per spec, clients must send notifications/initialized after a
		// successful initialize. Session-enforcing servers reject tools/list /
		// tools/call (HTTP 400 or JSON-RPC -32602) until this is delivered, so
		// always send it. It is a notification (no id, no result); drain the
		// response body and ignore failures.
		try {
			const notifHeaders = await this.getHeaders();
			const notifResponse = await mcpFetch(
				this.url,
				{
					method: "POST",
					headers: notifHeaders,
					body: JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/initialized",
					} satisfies JSONRPCNotification),
				},
				`fetch ${this.url} (notifications/initialized)`,
			);
			await notifResponse.text().catch(() => {});
		} catch (error) {
			console.warn(`[MCP] ${this.url} notifications/initialized failed (non-fatal): ${formatMcpError(error)}`);
		}
	}

	async listTools(): Promise<MCPTool[]> {
		const headers = await this.getHeaders();
		let response: Response;
		try {
			response = await mcpFetch(
				this.url,
				{
					method: "POST",
					headers,
					body: JSON.stringify(this.createRequest("tools/list")),
				},
				`fetch ${this.url} (tools/list)`,
			);
		} catch (error) {
			console.error(`[MCP] fetch failed for ${this.url} (tools/list):`, formatMcpError(error), error);
			throw new Error(`MCP list tools failed: ${formatMcpError(error)}`);
		}

		if (!response.ok) {
			throw new Error(`MCP list tools failed: ${response.status} ${response.statusText}`);
		}

		const data = await parseMcpResponse<JSONRPCResponse>(response);
		if (data.error) {
			throw new Error(`MCP list tools error: ${data.error.message}`);
		}

		const result = data.result as MCPListToolsResult;
		return result.tools;
	}

	async callTool(request: MCPCallToolRequest): Promise<MCPCallToolResult> {
		const headers = await this.getHeaders();
		let response: Response;
		try {
			response = await mcpFetch(
				this.url,
				{
					method: "POST",
					headers,
					body: JSON.stringify(this.createRequest("tools/call", request)),
				},
				`fetch ${this.url} (tools/call)`,
			);
		} catch (error) {
			console.error(`[MCP] fetch failed for ${this.url} (tools/call):`, formatMcpError(error), error);
			throw new Error(`MCP call tool failed: ${formatMcpError(error)}`);
		}

		if (!response.ok) {
			throw new Error(`MCP call tool failed: ${response.status} ${response.statusText}`);
		}

		const data = await parseMcpResponse<JSONRPCResponse>(response);
		if (data.error) {
			throw new Error(`MCP call tool error: ${data.error.message}`);
		}

		return data.result as MCPCallToolResult;
	}

	private createRequest(method: string, params?: Record<string, unknown>): JSONRPCRequest {
		return {
			jsonrpc: "2.0",
			id: ++this.requestId,
			method,
			params,
		};
	}
}

export function createMCPClient(config: MCPClientConfig): MCPClient {
	return new MCPClient(config);
}
