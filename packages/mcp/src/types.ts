export interface MCPClientConfig {
	url: string;
	headers?: Record<string, string>;
	name?: string;
	version?: string;
}

export interface MCPTool {
	name: string;
	description?: string;
	inputSchema: MCPInputSchema;
}

export interface MCPInputSchema {
	type: "object";
	properties?: Record<string, MCPProperty>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface MCPProperty {
	type: string;
	description?: string;
	default?: unknown;
}

export interface MCPListToolsResult {
	tools: MCPTool[];
}

export interface MCPCallToolRequest {
	name: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface MCPCallToolResult {
	content: MCPContent[];
	isError?: boolean;
}

export interface MCPContent {
	type: "text" | "image" | "resource";
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface JSONRPCRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export interface JSONRPCNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: JSONRPCError;
}

export interface JSONRPCError {
	code: number;
	message: string;
	data?: unknown;
}

export interface MCPClientOptions {
	url: string;
	headers?: Record<string, string>;
	name?: string;
	version?: string;
}

export type ToolExecutionMode = "parallel" | "sequential";
