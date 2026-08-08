import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import archiver from "archiver";
import extract from "extract-zip";
import { parse as parseYaml } from "yaml";
import { getAgentDir, getSessionsDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import {
	executeHttpSkill,
	getSkillRepoDir,
	getUserId,
	type HttpSkill,
	loadHttpSkills,
	parseJsonBody,
	removeLinkOrDir,
	SKILL_REPO_BASE_DIR,
	sanitizeId,
	saveHttpSkills,
	sendError,
	sendJson,
} from "./http-api-shared.js";
import { loadSkills, type SkillFrontmatter } from "./skills.js";
import { discoverAndRegisterMCPTools, loadMCPRegistry, unregisterMCPTools } from "./tools/mcp-registry.js";

const DMP_REQUIRED_HEADERS: ApiParam[] = [
	{ name: "X-Agent-Id", type: "string", description: "Agent ID", required: false },
	{ name: "X-User-Id", type: "string", description: "User SN", required: false },
	{ name: "X-Conversation-Id", type: "string", description: "Conversation / Session ID", required: false },
];

function ensureDmpHeaderParams(skillName: string, apis: HttpApiDefinition[]): void {
	if (!skillName.startsWith("dmp-")) return;
	for (const api of apis) {
		const existing = new Set((api.headerParams ?? []).map((p) => p.name.toLowerCase()));
		if (!api.headerParams) api.headerParams = [];
		for (const header of DMP_REQUIRED_HEADERS) {
			if (!existing.has(header.name.toLowerCase())) {
				api.headerParams.push({ ...header });
			}
		}
	}
}

// ============================================================
// Types
// ============================================================

export interface CreateSkillFromHttpApisRequest {
	name: string;
	description: string;
	category?: string;
	baseUrl?: string;
	defaultHeaders?: Record<string, string>;
	auth?: AuthConfig;
	spec?: OpenApiSpecInput;
	apis?: HttpApiDefinition[];
	overwrite?: boolean;
}

export interface AuthConfig {
	type: "bearer" | "basic" | "api-key";
	token?: string;
	username?: string;
	password?: string;
	headerName?: string;
	apiKey?: string;
}

export interface OpenApiSpecInput {
	document?: unknown;
	url?: string;
	format?: "json" | "yaml";
	operations?: string[];
}

export interface HttpApiDefinition {
	name: string;
	description?: string;
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	url: string;
	headers?: Record<string, string>;
	pathParams?: ApiParam[];
	queryParams?: ApiParam[];
	headerParams?: ApiParam[];
	body?: BodyDefinition;
	formData?: FormDataField[];
	responseType?: "json" | "text" | "binary";
	responseDescription?: string;
}

export interface BodyDefinition {
	contentType: "json" | "form-data" | "x-www-form-urlencoded" | "binary";
	schema?: ApiParam[];
	rawSchema?: Record<string, unknown>;
}

export interface ApiParam {
	name: string;
	type: "string" | "number" | "boolean" | "array" | "object";
	description?: string;
	required?: boolean;
	default?: string | number | boolean;
	enum?: string[];
	children?: ApiParam[];
}

export interface FormDataField {
	name: string;
	type: "text" | "file";
	description?: string;
	required?: boolean;
}

export interface CreateSkillFromHttpApisResponse {
	success: boolean;
	skill: {
		name: string;
		path: string;
		dir: string;
		scriptPath: string;
		requirementsPath: string;
		apiCount: number;
	};
	warnings?: string[];
	error?: string;
}

// ============================================================
// OpenAPI 3.x Parser
// ============================================================

interface OpenApiDocument {
	openapi?: string;
	info?: { title?: string; description?: string; version?: string };
	servers?: Array<{ url?: string; description?: string }>;
	paths?: Record<string, Record<string, OpenApiOperation>>;
	components?: {
		schemas?: Record<string, OpenApiSchema>;
		securitySchemes?: Record<string, OpenApiSecurityScheme>;
	};
	security?: OpenApiSecurityRequirement[];
}

interface OpenApiOperation {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
	deprecated?: boolean;
	parameters?: OpenApiParameter[];
	requestBody?: OpenApiRequestBody;
	responses?: Record<string, OpenApiResponse>;
	security?: OpenApiSecurityRequirement[];
}

interface OpenApiParameter {
	name: string;
	in: "query" | "header" | "path" | "cookie";
	description?: string;
	required?: boolean;
	deprecated?: boolean;
	schema?: OpenApiSchema;
}

interface OpenApiRequestBody {
	description?: string;
	required?: boolean;
	content?: Record<string, OpenApiMediaType>;
}

interface OpenApiMediaType {
	schema?: OpenApiSchema;
}

interface OpenApiResponse {
	description?: string;
	content?: Record<string, OpenApiMediaType>;
}

interface OpenApiSchema {
	type?: string;
	format?: string;
	properties?: Record<string, OpenApiSchema>;
	items?: OpenApiSchema;
	required?: string[];
	description?: string;
	enum?: string[];
	default?: unknown;
	$ref?: string;
	additionalProperties?: boolean | OpenApiSchema;
	allOf?: OpenApiSchema[];
	oneOf?: OpenApiSchema[];
	anyOf?: OpenApiSchema[];
}

interface OpenApiSecurityScheme {
	type: "apiKey" | "http" | "oauth2" | "openIdConnect";
	in?: "query" | "header" | "cookie";
	name?: string;
	scheme?: string;
	bearerFormat?: string;
}

interface OpenApiSecurityRequirement {
	[name: string]: string[];
}

function resolveRef<T>(doc: OpenApiDocument, ref: string): T | undefined {
	if (!ref.startsWith("#/")) return undefined;
	const parts = ref.slice(2).split("/");
	let current: unknown = doc as unknown;
	for (const part of parts) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current as T | undefined;
}

function resolveSchema(doc: OpenApiDocument, schema: OpenApiSchema | undefined): OpenApiSchema {
	if (!schema) return {};
	if (schema.$ref) {
		const resolved = resolveRef<OpenApiSchema>(doc, schema.$ref);
		return resolved ? resolveSchema(doc, resolved) : {};
	}
	if (schema.allOf) {
		const merged: OpenApiSchema = {};
		for (const sub of schema.allOf) {
			const resolved = resolveSchema(doc, sub);
			Object.assign(merged, resolved);
			if (resolved.properties) {
				merged.properties = { ...merged.properties, ...resolved.properties };
			}
			if (resolved.required) {
				merged.required = [...(merged.required ?? []), ...resolved.required];
			}
		}
		return merged;
	}
	return schema;
}

function schemaToApiParam(doc: OpenApiDocument, schema: OpenApiSchema, name: string, required: boolean): ApiParam {
	const resolved = resolveSchema(doc, schema);
	const paramType = openApiTypeToApiParamType(resolved.type, resolved.format);
	const result: ApiParam = {
		name,
		type: paramType,
		description: resolved.description,
		required,
	};

	if (resolved.enum && resolved.enum.length > 0) {
		result.enum = resolved.enum;
	}
	if (resolved.default !== undefined) {
		result.default = resolved.default as string | number | boolean;
	}
	if (paramType === "object" && resolved.properties) {
		result.children = Object.entries(resolved.properties).map(([childName, childSchema]) => {
			const childRequired = resolved.required?.includes(childName) ?? false;
			return schemaToApiParam(doc, childSchema, childName, childRequired);
		});
	}
	if (paramType === "array" && resolved.items) {
		const itemSchema = resolveSchema(doc, resolved.items);
		if (itemSchema.type === "object" && itemSchema.properties) {
			result.children = Object.entries(itemSchema.properties).map(([childName, childSchema]) => {
				const childRequired = itemSchema.required?.includes(childName) ?? false;
				return schemaToApiParam(doc, childSchema, childName, childRequired);
			});
		}
	}

	return result;
}

function openApiTypeToApiParamType(type?: string, _format?: string): ApiParam["type"] {
	switch (type) {
		case "integer":
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "array":
			return "array";
		case "object":
			return "object";
		default:
			return "string";
	}
}

function parseAuthFromSpec(doc: OpenApiDocument, operation: OpenApiOperation): AuthConfig | undefined {
	const securityReqs = operation.security ?? doc.security;
	if (!securityReqs || securityReqs.length === 0) return undefined;

	const schemes = doc.components?.securitySchemes;
	if (!schemes) return undefined;

	for (const req of securityReqs) {
		for (const [schemeName] of Object.entries(req)) {
			const scheme = schemes[schemeName];
			if (!scheme) continue;

			switch (scheme.type) {
				case "http":
					if (scheme.scheme === "bearer") {
						return { type: "bearer" };
					}
					if (scheme.scheme === "basic") {
						return { type: "basic" };
					}
					break;
				case "apiKey":
					return {
						type: "api-key",
						headerName: scheme.in === "header" ? scheme.name : undefined,
					};
			}
		}
	}
	return undefined;
}

function filterOperations(
	paths: Record<string, Record<string, OpenApiOperation>>,
	operations?: string[],
): Array<{ path: string; method: string; operation: OpenApiOperation }> {
	const results: Array<{ path: string; method: string; operation: OpenApiOperation }> = [];
	const httpMethods = new Set(["get", "post", "put", "delete", "patch"]);

	for (const [path, methods] of Object.entries(paths)) {
		for (const [method, operation] of Object.entries(methods)) {
			if (!httpMethods.has(method.toLowerCase())) continue;

			if (operations && operations.length > 0) {
				const matched = operations.some((op) => {
					if (op.includes(" ")) {
						const parts = op.split(" ");
						return parts[0].toUpperCase() === method.toUpperCase() && parts[1] === path;
					}
					return operation.operationId === op;
				});
				if (!matched) continue;
			}

			results.push({ path, method, operation });
		}
	}

	return results;
}

export function parseOpenApiSpec(spec: OpenApiSpecInput): {
	apis: HttpApiDefinition[];
	baseUrl?: string;
	auth?: AuthConfig;
	warnings: string[];
} {
	const warnings: string[] = [];
	let doc: OpenApiDocument;

	if (spec.document && typeof spec.document === "object") {
		doc = spec.document as OpenApiDocument;
	} else if (typeof spec.document === "string") {
		try {
			if (spec.format === "yaml" || spec.format !== "json") {
				doc = parseYaml(spec.document) as OpenApiDocument;
			} else {
				doc = JSON.parse(spec.document) as OpenApiDocument;
			}
		} catch (e) {
			throw new Error(`Failed to parse OpenAPI document: ${e instanceof Error ? e.message : String(e)}`);
		}
	} else {
		throw new Error("spec.document is required when spec.url is not provided");
	}

	if (!doc.paths || Object.keys(doc.paths).length === 0) {
		throw new Error("OpenAPI document contains no paths");
	}

	const baseUrl = doc.servers?.[0]?.url;

	const matchedOps = filterOperations(doc.paths, spec.operations);
	if (matchedOps.length === 0) {
		throw new Error("No matching operations found in OpenAPI document");
	}

	const apis: HttpApiDefinition[] = [];
	let globalAuth: AuthConfig | undefined;

	for (const { path, method, operation } of matchedOps) {
		const name =
			operation.operationId ||
			`${method.toLowerCase()}_${path.replace(/[{}]/g, "").replace(/[/]+/g, "_").replace(/^_/, "")}`;

		if (operation.deprecated) {
			warnings.push(`Operation ${method.toUpperCase()} ${path} is deprecated`);
		}

		const pathParams: ApiParam[] = [];
		const queryParams: ApiParam[] = [];
		const headerParams: ApiParam[] = [];
		const fixedHeaders: Record<string, string> = {};

		for (const param of operation.parameters ?? []) {
			const apiParam = schemaToApiParam(doc, param.schema ?? {}, param.name, param.required ?? false);
			if (param.description && !apiParam.description) {
				apiParam.description = param.description;
			}

			switch (param.in) {
				case "path":
					pathParams.push(apiParam);
					break;
				case "query":
					queryParams.push(apiParam);
					break;
				case "header":
					headerParams.push(apiParam);
					break;
			}
		}

		let body: BodyDefinition | undefined;
		let formData: FormDataField[] | undefined;

		if (operation.requestBody?.content) {
			for (const [contentType, mediaType] of Object.entries(operation.requestBody.content)) {
				if (contentType === "application/json") {
					const schema = resolveSchema(doc, mediaType.schema ?? {});
					body = {
						contentType: "json",
						schema: schema.properties
							? Object.entries(schema.properties).map(([propName, propSchema]) => {
									const propRequired = schema.required?.includes(propName) ?? false;
									return schemaToApiParam(doc, propSchema, propName, propRequired);
								})
							: undefined,
						rawSchema: mediaType.schema as Record<string, unknown> | undefined,
					};
					break;
				} else if (contentType === "multipart/form-data") {
					const schema = resolveSchema(doc, mediaType.schema ?? {});
					if (schema.properties) {
						formData = Object.entries(schema.properties).map(([propName, propSchema]) => {
							const resolved = resolveSchema(doc, propSchema);
							const propRequired = schema.required?.includes(propName) ?? false;
							return {
								name: propName,
								type: resolved.format === "binary" ? ("file" as const) : ("text" as const),
								description: resolved.description,
								required: propRequired,
							};
						});
					}
					body = {
						contentType: "form-data",
						schema: schema.properties
							? Object.entries(schema.properties).map(([propName, propSchema]) => {
									const propRequired = schema.required?.includes(propName) ?? false;
									return schemaToApiParam(doc, propSchema, propName, propRequired);
								})
							: undefined,
					};
					break;
				} else if (contentType === "application/x-www-form-urlencoded") {
					const schema = resolveSchema(doc, mediaType.schema ?? {});
					body = {
						contentType: "x-www-form-urlencoded",
						schema: schema.properties
							? Object.entries(schema.properties).map(([propName, propSchema]) => {
									const propRequired = schema.required?.includes(propName) ?? false;
									return schemaToApiParam(doc, propSchema, propName, propRequired);
								})
							: undefined,
					};
					break;
				} else if (contentType === "application/octet-stream") {
					body = { contentType: "binary" };
					break;
				}
			}
		}

		let responseType: "json" | "text" | "binary" | undefined;
		let responseDescription: string | undefined;

		for (const [statusCode, response] of Object.entries(operation.responses ?? {})) {
			if (statusCode.startsWith("2") || statusCode === "default") {
				responseDescription = response.description;
				if (response.content) {
					for (const ct of Object.keys(response.content)) {
						if (ct.includes("json")) {
							responseType = "json";
						} else if (ct.includes("text") || ct.includes("xml")) {
							responseType = "text";
						} else if (ct.includes("octet-stream")) {
							responseType = "binary";
						}
					}
				}
				break;
			}
		}

		const opAuth = parseAuthFromSpec(doc, operation);
		if (opAuth && !globalAuth) {
			globalAuth = opAuth;
		}

		apis.push({
			name,
			description: operation.summary || operation.description || `${method.toUpperCase()} ${path}`,
			method: method.toUpperCase() as HttpApiDefinition["method"],
			url: path,
			headers: Object.keys(fixedHeaders).length > 0 ? fixedHeaders : undefined,
			pathParams: pathParams.length > 0 ? pathParams : undefined,
			queryParams: queryParams.length > 0 ? queryParams : undefined,
			headerParams: headerParams.length > 0 ? headerParams : undefined,
			body,
			formData,
			responseType,
			responseDescription,
		});
	}

	return { apis, baseUrl, auth: globalAuth, warnings };
}

// ============================================================
// MCP Skill
// ============================================================

export interface CreateSkillFromMcpRequest {
	name: string;
	description: string;
	category?: string;
	serverUrl: string;
	serverHeaders?: Record<string, string>;
	tools?: string[];
	overwrite?: boolean;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

export interface CreateSkillFromMcpResponse {
	success: boolean;
	skill: {
		name: string;
		path: string;
		dir: string;
		scriptPath: string;
		requirementsPath: string;
		toolCount: number;
		tools: Array<{ name: string; description?: string }>;
	};
	warnings?: string[];
	error?: string;
}

const EMPTY_MCP_SKILL = {
	name: "",
	path: "",
	dir: "",
	scriptPath: "",
	requirementsPath: "",
	toolCount: 0,
	tools: [],
};

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

const MCP_CLIENT_INFO = { name: "pi-coding-agent", version: "1.0.0" };

/**
 * Performs the MCP Streamable HTTP handshake: sends `initialize`, and when the
 * server returns a `Mcp-Session-Id` header (per the 2025-03-26 spec), records it
 * and sends the required `notifications/initialized` notification. Returns a
 * headers object that callers MUST use for every follow-up request.
 *
 * Servers that enforce session lifecycle (e.g. ModelScope, Cloudflare-hosted
 * fastmcp) reject `tools/list` / `tools/call` with HTTP 400 or a JSON-RPC
 * -32602 error until both the session header is replayed and the initialized
 * notification has been delivered.
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
					clientInfo: MCP_CLIENT_INFO,
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

	// Per spec, clients must send notifications/initialized after a successful
	// initialize. Some servers reject tools/list until this is delivered, so
	// send it for every server (harmless when not required). It is a JSON-RPC
	// notification (no id, no result); drain and ignore the response body.
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

export async function fetchMcpTools(serverUrl: string, serverHeaders?: Record<string, string>): Promise<McpToolInfo[]> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...serverHeaders,
	};

	let sessionHeaders: Record<string, string>;
	try {
		sessionHeaders = await mcpInitializeSession(serverUrl, headers, `fetch ${serverUrl}`);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] fetch failed for ${serverUrl} (initialize):`, msg, error);
		throw new Error(`MCP connection failed: ${msg}`);
	}

	let listResponse: Response;
	try {
		listResponse = await mcpFetch(
			serverUrl,
			{
				method: "POST",
				headers: sessionHeaders,
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			},
			`fetch ${serverUrl} (tools/list)`,
		);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] fetch failed for ${serverUrl} (tools/list):`, msg, error);
		throw new Error(`MCP tools/list failed: ${msg}`);
	}

	if (!listResponse.ok) {
		throw new Error(`MCP tools/list failed: ${listResponse.status} ${listResponse.statusText}`);
	}

	const listData = await parseMcpResponse<{
		error?: { message: string };
		result?: { tools: McpToolInfo[] };
	}>(listResponse);
	if (listData.error) {
		throw new Error(`MCP tools/list error: ${listData.error.message}`);
	}

	return listData.result?.tools ?? [];
}

function jsonSchemaToApiParams(
	schema: Record<string, unknown> | undefined,
	requiredList: string[] | undefined,
): ApiParam[] {
	if (!schema || typeof schema !== "object") return [];
	const params: ApiParam[] = [];
	for (const [name, def] of Object.entries(schema)) {
		if (typeof def !== "object" || def === null) continue;
		const d = def as Record<string, unknown>;
		const t = d.type as string;
		let paramType: ApiParam["type"] = "string";
		if (t === "integer" || t === "number") paramType = "number";
		else if (t === "boolean") paramType = "boolean";
		else if (t === "array") paramType = "array";
		else if (t === "object") paramType = "object";

		const param: ApiParam = {
			name,
			type: paramType,
			description: (d.description as string) || undefined,
			required: requiredList?.includes(name) ?? false,
		};
		if (d.default !== undefined) param.default = d.default as string | number | boolean;
		if (d.enum && Array.isArray(d.enum)) param.enum = d.enum as string[];
		if ((t === "object" || t === "array") && d.items && typeof d.items === "object") {
			const childSchema = t === "array" ? (d.items as Record<string, unknown>).properties : d.properties;
			if (childSchema && typeof childSchema === "object") {
				const childRequired = (d.items as Record<string, unknown>)?.required as string[] | undefined;
				param.children = jsonSchemaToApiParams(childSchema as Record<string, unknown>, childRequired);
			}
		}
		params.push(param);
	}
	return params;
}

/**
 * Formats a description string as a YAML `description:` field value.
 * Multi-line descriptions are emitted as literal block scalars (`|-`) so the
 * generated frontmatter stays valid YAML and survives round-trip parsing
 * (naive interpolation breaks on embedded newlines).
 */
function formatYamlDescription(description: string): string {
	const trimmed = description.trim();
	if (!trimmed.includes("\n")) {
		return `description: ${trimmed}`;
	}
	const indented = trimmed
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
	return `description: |-\n${indented}`;
}

const SKILL_NAME_REGEX = /^[a-z0-9-]+$/;

/**
 * Validates a skill name. Returns `null` when valid, otherwise a human-readable
 * error message describing the first violated rule.
 *
 * Rules:
 *   1. Non-empty.
 *   2. At most 64 characters.
 *   3. Only lowercase `a-z`, digits `0-9`, and hyphens (`SKILL_NAME_REGEX`).
 *   4. Must not start or end with a hyphen.
 *   5. Must not contain consecutive hyphens (`--`).
 *
 * The supplied name is also used as the on-disk parent directory name
 * (`<skillRepoDir>/<category>/<name>`), so callers must ensure the request
 * name matches the desired folder name exactly. Names starting with `dmp-`
 * automatically get DMP context headers
 * (`X-User-Id` / `X-Agent-Id` / `X-Conversation-Id`) injected.
 */
function validateSkillName(name: string): string | null {
	if (!name) return "name is required";
	if (name.length > 64) return "name must be at most 64 characters";
	if (!SKILL_NAME_REGEX.test(name)) {
		return "name must contain only lowercase letters (a-z), digits (0-9), and hyphens";
	}
	if (name.startsWith("-")) return "name must not start with a hyphen";
	if (name.endsWith("-")) return "name must not end with a hyphen";
	if (name.includes("--")) return "name must not contain consecutive hyphens";
	return null;
}

function generateMcpSkillMd(
	name: string,
	description: string,
	category: string,
	serverUrl: string,
	tools: McpToolInfo[],
): string {
	const lines = [
		"---",
		`name: ${name}`,
		formatYamlDescription(description),
		"---",
		"",
		`# ${name}`,
		"",
		description,
		"",
		`**Source**: MCP Server \`${serverUrl}\``,
		`**Category**: ${category}`,
		`**Tools**: ${tools.length}`,
		"",
		"## Setup",
		"",
		"```bash",
		"cd $(dirname $0)/..",
		"pip install -r scripts/requirements.txt",
		"```",
		"",
		"## Usage",
		"",
		"```bash",
		`python scripts/main.py <tool-name> [arguments...]`,
		"```",
		"",
		"## CLI Argument Format",
		"",
		"All arguments are passed as `--param-name value` flags. The value format depends on the parameter type:",
		"",
		"| Type | CLI Format | Example |",
		"|------|-----------|---------|",
		'| `string` | Plain text | `--url "https://example.com"` |',
		"| `number` | Decimal number | `--limit 10` |",
		"| `boolean` | Flag (use `--name` or `--no-name`) | `--onlyMainContent` or `--no-onlyMainContent` |",
		'| `array` | JSON string | `--formats \'["markdown", "html"]\'` |',
		'| `object` | JSON string | `--jsonOptions \'{"prompt": "Extract prices"}\'` |',
		"",
		" camelCase param names are passed as-is (e.g. `--jsonOptions`, `--onlyMainContent`).",
		" Reserved Python keywords get a trailing underscore in `dest` but the flag name is unchanged (e.g. `--from`).",
		"",
		"## Available Tools",
		"",
	];

	if (name.startsWith("dmp-")) {
		lines.push("## IMPORTANT: DMP Context Headers");
		lines.push("");
		lines.push(
			"When calling any tool, you MUST include the DMP context header parameters from the [DMP Context] section in your system instructions.",
		);
		lines.push("These 3 parameters are REQUIRED for every tool call:");
		lines.push("```bash");
		lines.push(
			'python scripts/main.py <tool_name> --X-User-Id "<from DMP Context>" --X-Agent-Id "<from DMP Context>" --X-Conversation-Id "<from DMP Context>" [other args...]',
		);
		lines.push("```");
		lines.push("Never omit these 3 parameters.");
		lines.push("");
	}

	for (const tool of tools) {
		lines.push(`### ${tool.name}`);
		if (tool.description) lines.push("", tool.description);
		const schema = tool.inputSchema?.properties;
		let params: ApiParam[] = [];
		if (schema && Object.keys(schema).length > 0) {
			params = jsonSchemaToApiParams(schema, tool.inputSchema?.required);
			if (params.length > 0) {
				lines.push("", "**Parameters**:", "", paramTable(params));
			}
		}

		const example = generateToolCliExample(tool.name, params);
		if (example) {
			lines.push("", "**Example**:", "", "```bash", example, "```");
		}

		lines.push("", "---", "");
	}

	return lines.join("\n");
}

/**
 * Generates a concrete CLI invocation example for a single MCP tool.
 * Picks the first required param (or first param if none required) as the
 * primary argument, and shows the correct CLI value format based on the
 * parameter's JSON-Schema type.
 */
function generateToolCliExample(toolName: string, params: ApiParam[]): string | null {
	if (params.length === 0) return `python scripts/main.py ${toolName}`;

	const required = params.filter((p) => p.required);
	const primary = required.length > 0 ? required : params.slice(0, Math.min(3, params.length));

	const flags: string[] = [`python scripts/main.py ${toolName}`];
	for (const p of primary) {
		const val = cliExampleValue(p);
		flags.push(`--${p.name} ${val}`);
	}
	return flags.join(" \\\n    ");
}

function cliExampleValue(p: ApiParam): string {
	switch (p.type) {
		case "number":
			return p.default !== undefined ? String(p.default) : "1";
		case "boolean":
			return "";
		case "array":
			return p.children && p.children.length > 0 ? `'[{"${p.children[0].name}": "value"}]'` : '["example"]';
		case "object":
			return p.children && p.children.length > 0 ? `'{"${p.children[0].name}": "value"}'` : '\'{"key": "value"}\'';
		default:
			if (p.enum && p.enum.length > 0) return `"${p.enum[0]}"`;
			return `"${p.name}-value"`;
	}
}

/**
 * Escapes a string for embedding inside a Python double-quoted literal (`"..."`).
 * Backslashes are escaped first (order matters), then double quotes and control
 * characters. Newlines become `\n` so the literal stays on a single source line
 * — required for argparse `help="..."` where a raw newline is a SyntaxError.
 */
function pyStr(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

/**
 * Escapes a string for embedding inside a Python double-quoted literal used as
 * an argparse `help="..."` value. In addition to the literal escaping performed
 * by {@link pyStr}, `%` is doubled: argparse treats `help` strings as
 * `%`-formatting templates (so `%(default)s` works), and a lone `%` raises
 * `TypeError: must be real number, not dict` at help-rendering time. Doubling
 * every `%` to `%%` is the argparse-sanctioned escape for a literal percent.
 */
function pyHelp(value: string): string {
	return pyStr(value).replace(/%/g, "%%");
}

/**
 * Escapes a string for embedding inside a Python triple-quoted docstring
 * (`"""..."""`). Newlines are preserved (allowed in triple-quoted strings) but
 * backslashes are doubled and any literal `"""` is broken up so it cannot
 * terminate the docstring prematurely.
 */
function pyDocstring(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

// Python's reserved words. Accessing `args.from` / `args.class` is a SyntaxError,
// and argparse `dest=` must also avoid these. We sanitize identifiers by
// appending an underscore (Python's own convention: `from_`, `class_`).
const PY_KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"match",
	"case",
]);

/**
 * Converts a JSON-Schema parameter name into a valid Python attribute-access
 * identifier suitable for use as an argparse `dest=` and the matching
 * `args.<name>` access in generated code.
 *
 * - camelCase / PascalCase → snake_case (`jsonOptions` → `json_options`)
 * - kebab-case → snake_case (`--my-flag` → `my_flag`)
 * - reserved keywords get a trailing underscore (`from` → `from_`)
 * - leading digits get an `_` prefix
 * - any non-`[A-Za-z0-9_]` char becomes `_`
 */
function pyAttrName(name: string): string {
	let ident = name
		.replace(/([A-Z])/g, "_$1")
		.toLowerCase()
		.replace(/-/g, "_")
		.replace(/[^a-z0-9_]/g, "_");
	if (/^[0-9]/.test(ident)) ident = `_${ident}`;
	if (PY_KEYWORDS.has(ident)) ident = `${ident}_`;
	return ident;
}

function generateMcpPythonScript(
	name: string,
	serverUrl: string,
	serverHeaders: Record<string, string> | undefined,
	tools: McpToolInfo[],
): string {
	const headersDict = serverHeaders
		? `${Object.entries(serverHeaders)
				.map(([k, v]) => `        "${k}": "${v.replace(/"/g, '\\"')}"`)
				.join(",\n")},`
		: "";

	const toolCases = tools
		.map((tool) => {
			const schema = tool.inputSchema?.properties;
			const params = schema ? jsonSchemaToApiParams(schema, tool.inputSchema?.required) : [];

			return `def call_${tool.name.replace(/-/g, "_")}(client, args):
    """${pyDocstring(tool.description ?? tool.name)}"""
    arguments = {}${params
			.map((p) => {
				const argName = pyAttrName(p.name);
				const key = pyStr(p.name);
				if (p.type === "array" || p.type === "object") {
					return `\n    if args.${argName} is not None:\n        arguments["${key}"] = json.loads(args.${argName})`;
				}
				return `\n    if args.${argName} is not None:\n        arguments["${key}"] = args.${argName}`;
			})
			.join("")}
    return client.call_tool("${tool.name}", arguments)`;
		})
		.join("\n\n");

	const toolDispatch = tools
		.map((tool) => {
			const funcName = tool.name.replace(/-/g, "_");
			return `    "${tool.name}": call_${funcName},`;
		})
		.join("\n");

	const isDmpSkill = name.startsWith("dmp-");
	const dmpParentParser = isDmpSkill
		? `    _dmp_parent = argparse.ArgumentParser(add_help=False)
    _dmp_parent.add_argument("--X-User-Id", type=str, help="DMP User ID")
    _dmp_parent.add_argument("--X-Agent-Id", type=str, help="DMP Agent ID")
    _dmp_parent.add_argument("--X-Conversation-Id", type=str, help="DMP Conversation ID")
`
		: "";

	return `#!/usr/bin/env python3
"""
MCP Skill: ${name}

Auto-generated from MCP server: ${serverUrl}
Calls MCP tools via JSON-RPC over HTTP.
"""

import argparse
import json
import sys
from typing import Any

class MCPClient:
    """JSON-RPC client for MCP servers (Streamable HTTP transport aware)."""

    def __init__(self, server_url: str, headers: dict | None = None):
        self.server_url = server_url
        self.headers = headers or {}
        self._id = 0
        self.session_id = None

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _build_headers(self) -> dict:
        req_headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
${headersDict || "            # No custom headers"}
        }
        req_headers.update(self.headers)
        if self.session_id:
            req_headers["Mcp-Session-Id"] = self.session_id
        return req_headers

    def _request(self, method: str, params: dict | None = None, capture_session: bool = False) -> dict:
        import urllib.request

        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": method,
            "params": params or {},
        }
        data = json.dumps(payload).encode("utf-8")
        req_headers = self._build_headers()
        req = urllib.request.Request(
            self.server_url,
            data=data,
            headers=req_headers,
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            if capture_session:
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
            body = resp.read().decode("utf-8")
            content_type = resp.headers.get("Content-Type", "")
            if "text/event-stream" in content_type:
                for line in body.split("\\n"):
                    line = line.strip()
                    if line.startswith("data:"):
                        data_str = line[5:].strip()
                        if data_str and data_str != "[DONE]":
                            result = json.loads(data_str)
                            break
                else:
                    raise RuntimeError("SSE response contained no valid JSON data")
            else:
                result = json.loads(body)
        if "error" in result:
            raise RuntimeError(f"MCP error: {result['error'].get('message', result['error'])}")
        return result.get("result", {})

    def _notify(self, method: str, params: dict | None = None) -> None:
        import urllib.request

        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }
        data = json.dumps(payload).encode("utf-8")
        req_headers = self._build_headers()
        req = urllib.request.Request(
            self.server_url,
            data=data,
            headers=req_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                resp.read()
        except Exception:
            pass

    def initialize(self) -> dict:
        result = self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "${name}", "version": "1.0.0"},
        }, capture_session=True)
        # Per MCP spec, send the initialized notification. Session-enforcing
        # servers reject tools/list until this is delivered.
        self._notify("notifications/initialized")
        return result

    def list_tools(self) -> list:
        result = self._request("tools/list", {})
        return result.get("tools", [])

    def call_tool(self, tool_name: str, arguments: dict | None = None) -> Any:
        return self._request("tools/call", {
            "name": tool_name,
            "arguments": arguments or {},
        })


${toolCases}


TOOL_MAP = {
${toolDispatch}
}


def main():
    parser = argparse.ArgumentParser(description="${name} - MCP Skill")
    parser.add_argument("--server-url", default="${serverUrl}", help="MCP server URL")
    parser.add_argument("--list-tools", action="store_true", help="List available tools and exit")

    subparsers = parser.add_subparsers(dest="tool"${tools.length > 0 ? ', help="Tool to execute"' : ""})
${dmpParentParser}${tools
	.map((tool) => {
		const funcName = tool.name.replace(/-/g, "_");
		const schema = tool.inputSchema?.properties;
		const params = schema ? jsonSchemaToApiParams(schema, tool.inputSchema?.required) : [];
		const addArgs = params
			.map((p) => {
				const dest = pyAttrName(p.name);
				const typeHint =
					p.type === "array" || p.type === "object" ? " (JSON string)" : p.type === "boolean" ? " (flag)" : "";
				const helpText = pyHelp(`${p.description ?? p.name}${typeHint}`);
				if (p.type === "number")
					return `    sub_${funcName}.add_argument("--${p.name}", dest="${dest}", type=float, help="${helpText}")`;
				if (p.type === "boolean")
					return `    sub_${funcName}.add_argument("--${p.name}", dest="${dest}", action=argparse.BooleanOptionalAction, default=None, help="${helpText}")`;
				return `    sub_${funcName}.add_argument("--${p.name}", dest="${dest}", type=str, default=None, help="${helpText}")`;
			})
			.join("\n");
		const parentArg = isDmpSkill ? ", parents=[_dmp_parent]" : "";
		return `    sub_${funcName} = subparsers.add_parser("${tool.name}"${parentArg}${tool.description ? `, help="${pyHelp(tool.description)}"` : ""})
${addArgs}`;
	})
	.join("\n")}

    args = parser.parse_args()

    if not args.tool and not args.list_tools:
        parser.error("the following arguments are required: tool")

    base_headers = {
${headersDict ? `${headersDict}\n` : ""}        "Content-Type": "application/json",
    }
${
	isDmpSkill
		? `    for key in ("X-User-Id", "X-Agent-Id", "X-Conversation-Id"):
        val = getattr(args, key.replace("-", "_"), None)
        if val:
            base_headers[key] = val
`
		: ""
}    client = MCPClient(args.server_url, base_headers)
    client.initialize()

    if args.list_tools:
        tools = client.list_tools()
        print(json.dumps(tools, indent=2, default=str))
        return

    handler = TOOL_MAP.get(args.tool)
    if not handler:
        print(f"Unknown tool: {args.tool}", file=sys.stderr)
        sys.exit(1)

    result = handler(client, args)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
`;
}

function generateMcpRequirements(): string {
	return `# MCP Skill dependencies
# No external dependencies required - uses only Python stdlib (urllib, json)
`;
}

export async function createSkillFromMcp(
	request: CreateSkillFromMcpRequest,
	skillRepoDir: string,
): Promise<CreateSkillFromMcpResponse> {
	if (!request.name || !request.description) {
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name ?? "" },
			error: "name, description, and serverUrl are required",
		};
	}

	if (!request.serverUrl) {
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name },
			error: "serverUrl is required",
		};
	}

	const nameError = validateSkillName(request.name);
	if (nameError) {
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name },
			error: nameError,
		};
	}

	let allTools: McpToolInfo[];
	try {
		allTools = await fetchMcpTools(request.serverUrl, request.serverHeaders);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] createSkillFromMcp failed for ${request.serverUrl}:`, msg, error);
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name },
			error: `MCP connection failed: ${msg}`,
		};
	}

	if (allTools.length === 0) {
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name },
			error: "MCP server returned no tools",
		};
	}

	const warnings: string[] = [];
	let tools = allTools;

	if (request.tools && request.tools.length > 0) {
		const availableNames = new Set(allTools.map((t) => t.name));
		const notFound = request.tools.filter((t) => !availableNames.has(t));
		if (notFound.length > 0) {
			return {
				success: false,
				skill: { ...EMPTY_MCP_SKILL, name: request.name },
				error: `Tools not found on MCP server: ${notFound.join(", ")}. Available: ${allTools.map((t) => t.name).join(", ")}`,
			};
		}
		tools = allTools.filter((t) => request.tools!.includes(t.name));
	}

	const category = request.category || "default";
	const skillDir = join(skillRepoDir, category, request.name);

	if (existsSync(skillDir) && !request.overwrite) {
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name },
			error: `Skill already exists at ${skillDir}`,
		};
	}

	const mcpApis: HttpApiDefinition[] = tools.map((tool) => {
		const schema = tool.inputSchema?.properties;
		const params = schema ? jsonSchemaToApiParams(schema, tool.inputSchema?.required) : [];
		return {
			name: tool.name,
			description: tool.description,
			method: "POST",
			url: request.serverUrl,
			mcpToolName: tool.name,
			body: params.length > 0 ? { contentType: "json" as const, schema: params } : undefined,
			responseType: "json" as const,
		};
	});
	ensureDmpHeaderParams(request.name, mcpApis);
	const apisJson = {
		name: request.name,
		description: request.description,
		category,
		source: "mcp",
		mcp: {
			serverUrl: request.serverUrl,
			serverHeaders: request.serverHeaders,
		},
		apis: mcpApis,
		createdAt: new Date().toISOString(),
	};

	try {
		mkdirSync(skillDir, { recursive: true });

		const scriptsDir = join(skillDir, "scripts");
		mkdirSync(scriptsDir, { recursive: true });

		const skillMd = generateMcpSkillMd(request.name, request.description, category, request.serverUrl, tools);
		writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf-8");
		writeFileSync(join(skillDir, "apis.json"), JSON.stringify(apisJson, null, 2), "utf-8");

		const pythonScript = generateMcpPythonScript(request.name, request.serverUrl, request.serverHeaders, tools);
		writeFileSync(join(scriptsDir, "main.py"), pythonScript, "utf-8");

		const requirements = generateMcpRequirements();
		writeFileSync(join(scriptsDir, "requirements.txt"), requirements, "utf-8");

		console.log(`[MCP Skill] Created skill "${request.name}" with ${tools.length} tools from ${request.serverUrl}`);

		return {
			success: true,
			skill: {
				name: request.name,
				path: join(skillDir, "SKILL.md"),
				dir: skillDir,
				scriptPath: join(scriptsDir, "main.py"),
				requirementsPath: join(scriptsDir, "requirements.txt"),
				toolCount: tools.length,
				tools: tools.map((t) => ({ name: t.name, description: t.description })),
			},
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	} catch (error) {
		return {
			success: false,
			skill: { ...EMPTY_MCP_SKILL, name: request.name },
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

// ============================================================
// SKILL.md Generator
// ============================================================

function escapeMarkdownTable(str: string): string {
	return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function paramTable(params: ApiParam[]): string {
	if (params.length === 0) return "None";
	const rows = params.map((p) => {
		const type = p.enum ? `${p.type} (${p.enum.join("\\|")})` : p.type;
		const desc = p.description ? escapeMarkdownTable(p.description) : "-";
		const req = p.required ? "yes" : "no";
		const def = p.default !== undefined ? String(p.default) : "-";
		return `| \`${p.name}\` | ${type} | ${req} | ${def} | ${desc} |`;
	});
	return `| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
${rows.join("\n")}`;
}

function formDataTable(fields: FormDataField[]): string {
	if (fields.length === 0) return "None";
	const rows = fields.map((f) => {
		const desc = f.description ? escapeMarkdownTable(f.description) : "-";
		const req = f.required ? "yes" : "no";
		return `| \`${f.name}\` | ${f.type} | ${req} | ${desc} |`;
	});
	return `| Name | Type | Required | Description |
|------|------|----------|-------------|
${rows.join("\n")}`;
}

function nestedParamDocs(params: ApiParam[], indent: string): string {
	const lines: string[] = [];
	for (const p of params) {
		const req = p.required ? " (required)" : " (optional)";
		const enumStr = p.enum ? `, enum: [${p.enum.join(", ")}]` : "";
		const defStr = p.default !== undefined ? `, default: ${String(p.default)}` : "";
		lines.push(
			`${indent}- \`${p.name}\` (${p.type}${enumStr}${defStr})${req}${p.description ? ` - ${p.description}` : ""}`,
		);
		if (p.children && p.children.length > 0) {
			lines.push(nestedParamDocs(p.children, `${indent}  `));
		}
	}
	return lines.join("\n");
}

function pyEscape(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

function generatePythonScript(skillName: string): string {
	const lines: string[] = [];

	lines.push("#!/usr/bin/env python3");
	lines.push('"""');
	lines.push(`Skill: ${skillName}`);
	lines.push("");
	lines.push("Auto-generated HTTP API skill script.");
	lines.push("Reads configuration from apis.json in the same directory.");
	lines.push("Usage: python main.py <api_name> [--param value ...]");
	lines.push('"""');
	lines.push("");
	lines.push("import argparse");
	lines.push("import base64");
	lines.push("import json");
	lines.push("import os");
	lines.push("import sys");
	lines.push("import urllib.parse");
	lines.push("from pathlib import Path");
	lines.push("from urllib.error import HTTPError, URLError");
	lines.push("from urllib.request import Request, urlopen");
	lines.push("");
	lines.push("");
	lines.push("SKILL_DIR = Path(__file__).resolve().parent");
	lines.push("");

	lines.push("def load_config() -> dict:");
	lines.push('    """Load apis.json configuration."""');
	lines.push('    config_path = SKILL_DIR / "apis.json"');
	lines.push('    with open(config_path, "r", encoding="utf-8") as f:');
	lines.push("        return json.load(f)");
	lines.push("");
	lines.push("");

	lines.push("def build_headers(config: dict, api: dict) -> dict[str, str]:");
	lines.push('    """Build request headers including auth."""');
	lines.push("    headers: dict[str, str] = {}");
	lines.push("");
	lines.push("    # Content-Type");
	lines.push('    body = api.get("body") or {}');
	lines.push('    ct = body.get("contentType", "json")');
	lines.push('    if ct == "json":');
	lines.push('        headers["Content-Type"] = "application/json"');
	lines.push('    elif ct == "x-www-form-urlencoded":');
	lines.push('        headers["Content-Type"] = "application/x-www-form-urlencoded"');
	lines.push("");
	lines.push("    # Default headers from config");
	lines.push('    for k, v in config.get("defaultHeaders", {}).items():');
	lines.push("        headers[k] = v");
	lines.push("");
	lines.push("    # API-specific headers");
	lines.push('    for k, v in api.get("headers", {}).items():');
	lines.push("        headers[k] = v");
	lines.push("");
	lines.push("    # Auth");
	lines.push('    auth_cfg = config.get("auth")');
	lines.push("    if auth_cfg:");
	lines.push('        atype = auth_cfg.get("type")');
	lines.push('        if atype == "bearer":');
	lines.push('            token = auth_cfg.get("token", os.environ.get("SKILL_AUTH_TOKEN", ""))');
	lines.push('            headers["Authorization"] = f"Bearer {token}"');
	lines.push('        elif atype == "basic":');
	lines.push('            u = auth_cfg.get("username", os.environ.get("SKILL_AUTH_USER", ""))');
	lines.push('            p = auth_cfg.get("password", os.environ.get("SKILL_AUTH_PASS", ""))');
	lines.push('            cred = base64.b64encode(f"{u}:{p}".encode()).decode()');
	lines.push('            headers["Authorization"] = f"Basic {cred}"');
	lines.push('        elif atype == "api-key":');
	lines.push('            hname = auth_cfg.get("headerName", "X-API-Key")');
	lines.push('            key = auth_cfg.get("apiKey", os.environ.get("SKILL_API_KEY", ""))');
	lines.push("            headers[hname] = key");
	lines.push("");
	lines.push("    return headers");
	lines.push("");
	lines.push("");

	lines.push("def build_url(config: dict, api: dict, args: argparse.Namespace) -> str:");
	lines.push('    """Build full URL with path and query params."""');
	lines.push('    base = config.get("baseUrl", "")');
	lines.push('    path = api.get("url", "")');
	lines.push('    url = path if path.startswith("http") else f"{base}{path}"');
	lines.push("");
	lines.push("    # Replace path parameters");
	lines.push('    for pp in api.get("pathParams", []):');
	lines.push('        pname = pp["name"]');
	lines.push("        value = getattr(args, pname, None)");
	lines.push("        if value is not None:");
	lines.push('            url = url.replace(f"{{{pname}}}", str(value))');
	lines.push("");
	lines.push("    # Append query parameters");
	lines.push("    qparams = []");
	lines.push('    for qp in api.get("queryParams", []):');
	lines.push('        qname = qp["name"]');
	lines.push("        value = getattr(args, qname, None)");
	lines.push("        if value is not None:");
	lines.push("            qparams.append((qname, str(value)))");
	lines.push("    if qparams:");
	lines.push('        sep = "&" if "?" in url else "?"');
	lines.push("        url += sep + urllib.parse.urlencode(qparams)");
	lines.push("");
	lines.push("    return url");
	lines.push("");
	lines.push("");

	lines.push("def build_body(api: dict, args: argparse.Namespace) -> bytes | None:");
	lines.push('    """Build request body."""');
	lines.push('    method = api.get("method", "GET").upper()');
	lines.push('    if method in ("GET", "DELETE"):');
	lines.push("        return None");
	lines.push('    body_cfg = api.get("body")');
	lines.push("    if not body_cfg:");
	lines.push("        return None");
	lines.push('    ctype = body_cfg.get("contentType", "json")');
	lines.push("    bdata = {}");
	lines.push('    for p in body_cfg.get("schema", []):');
	lines.push('        pname = p["name"]');
	lines.push("        val = getattr(args, pname, None)");
	lines.push("        if val is not None:");
	lines.push('            if p.get("type") == "number":');
	lines.push("                val = float(val)");
	lines.push('            elif p.get("type") == "boolean":');
	lines.push('                val = val.lower() in ("true", "1", "yes")');
	lines.push("            bdata[pname] = val");
	lines.push('    if ctype == "json":');
	lines.push('        return json.dumps(bdata).encode("utf-8")');
	lines.push('    elif ctype == "x-www-form-urlencoded":');
	lines.push('        return urllib.parse.urlencode(bdata).encode("utf-8")');
	lines.push('    elif ctype == "binary":');
	lines.push('        raw = getattr(args, "body", None)');
	lines.push("        if raw:");
	lines.push('            return raw.encode("utf-8")');
	lines.push("        return None");
	lines.push('    return json.dumps(bdata).encode("utf-8")');
	lines.push("");
	lines.push("");

	lines.push("def execute_api(config: dict, api_name: str, args: argparse.Namespace) -> dict:");
	lines.push('    """Execute a single API call."""');
	lines.push('    apis = config.get("apis", [])');
	lines.push('    api = next((a for a in apis if a["name"] == api_name), None)');
	lines.push("    if not api:");
	lines.push('        return {"error": f"API not found: {api_name}", "available": [a["name"] for a in apis]}');
	lines.push('    method = api.get("method", "GET").upper()');
	lines.push("    url = build_url(config, api, args)");
	lines.push("    headers = build_headers(config, api)");
	lines.push("");
	lines.push("    # Header params from args");
	lines.push('    for hp in api.get("headerParams", []):');
	lines.push('        pname = hp["name"]');
	lines.push('        val = getattr(args, pname.replace("-", "_"), None)');
	lines.push("        if val is not None:");
	lines.push("            headers[pname] = str(val)");
	lines.push("    body = build_body(api, args)");
	lines.push('    print(f"[{method}] {url}", file=sys.stderr)');
	lines.push("    try:");
	lines.push("        req = Request(url, data=body, headers=headers, method=method)");
	lines.push("        with urlopen(req) as resp:");
	lines.push("            status = resp.status");
	lines.push('            ct = resp.headers.get("Content-Type", "")');
	lines.push("            raw = resp.read()");
	lines.push('            if "application/json" in ct:');
	lines.push("                try:");
	lines.push('                    data = json.loads(raw.decode("utf-8"))');
	lines.push("                except json.JSONDecodeError:");
	lines.push('                    data = raw.decode("utf-8", errors="replace")');
	lines.push("            else:");
	lines.push('                data = raw.decode("utf-8", errors="replace")');
	lines.push('            return {"status": status, "data": data}');
	lines.push("    except HTTPError as e:");
	lines.push('        body_text = ""');
	lines.push("        try:");
	lines.push('            body_text = e.read().decode("utf-8", errors="replace")');
	lines.push("        except Exception:");
	lines.push("            pass");
	lines.push("        try:");
	lines.push("            err_data = json.loads(body_text)");
	lines.push('            return {"status": e.code, "error": err_data}');
	lines.push("        except json.JSONDecodeError:");
	lines.push('            return {"status": e.code, "error": body_text}');
	lines.push("    except URLError as e:");
	lines.push('        return {"error": f"Connection failed: {e.reason}"}');
	lines.push("");
	lines.push("");

	lines.push("def add_params(sub: argparse.ArgumentParser, params: list, key: str) -> None:");
	lines.push('    """Add parameters to a subparser from api config."""');
	lines.push("    for p in params:");
	lines.push('        pname = p["name"]');
	lines.push('        flags = [f"--{pname}"]');
	lines.push("        kwargs: dict = {}");
	lines.push('        kwargs["help"] = p.get("description", pname)');
	lines.push('        kwargs["required"] = p.get("required", False)');
	lines.push('        if p.get("enum"):');
	lines.push('            kwargs["choices"] = p["enum"]');
	lines.push("        sub.add_argument(*flags, **kwargs)");
	lines.push("");
	lines.push("");

	lines.push("def main():");
	lines.push("    config = load_config()");
	lines.push('    apis = config.get("apis", [])');
	lines.push("");
	lines.push("    parser = argparse.ArgumentParser(");
	lines.push(`        description="${pyEscape(skillName)} - HTTP API Skill",`);
	lines.push("    )");
	lines.push('    sub = parser.add_subparsers(dest="api_name", help="API to call")');
	lines.push("");
	lines.push("    for api in apis:");
	lines.push('        name = api["name"]');
	lines.push('        desc = api.get("description", name)');
	lines.push("        p = sub.add_parser(name, help=desc)");
	lines.push('        add_params(p, api.get("pathParams", []), "pathParams")');
	lines.push('        add_params(p, api.get("queryParams", []), "queryParams")');
	lines.push('        body_cfg = api.get("body")');
	lines.push("        if body_cfg:");
	lines.push('            add_params(p, body_cfg.get("schema", []), "body.schema")');
	lines.push('        add_params(p, api.get("formData", []), "formData")');
	lines.push('        add_params(p, api.get("headerParams", []), "headerParams")');
	lines.push("");
	lines.push("    args = parser.parse_args()");
	lines.push("    if not args.api_name:");
	lines.push("        parser.print_help()");
	lines.push("        sys.exit(1)");
	lines.push("    result = execute_api(config, args.api_name, args)");
	lines.push("    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))");
	lines.push("");
	lines.push("");
	lines.push('if __name__ == "__main__":');
	lines.push("    main()");
	lines.push("");

	return lines.join("\n");
}

function generateRequirements(): string {
	return `requests>=2.28.0
`;
}

function generateSkillMd(
	name: string,
	description: string,
	category: string | undefined,
	baseUrl: string | undefined,
	auth: AuthConfig | undefined,
	apis: HttpApiDefinition[],
): string {
	const lines: string[] = [];

	lines.push("---");
	lines.push(`name: ${name}`);
	lines.push(formatYamlDescription(description));
	lines.push("---");
	lines.push("");
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(description);
	lines.push("");

	if (category) {
		lines.push(`**Category**: ${category}`);
		lines.push("");
	}

	if (baseUrl) {
		lines.push("## Base URL");
		lines.push("");
		lines.push(`\`${baseUrl}\``);
		lines.push("");
	}

	if (auth) {
		lines.push("## Authentication");
		lines.push("");
		switch (auth.type) {
			case "bearer":
				lines.push("Bearer token via `Authorization` header");
				break;
			case "basic":
				lines.push("HTTP Basic Authentication");
				break;
			case "api-key":
				lines.push(`API key via \`${auth.headerName ?? "X-API-Key"}\` header`);
				break;
		}
		lines.push("");
	}

	lines.push("## APIs");
	lines.push("");

	if (name.startsWith("dmp-")) {
		lines.push("## IMPORTANT: DMP Context Headers");
		lines.push("");
		lines.push(
			"When calling any API, you MUST include the DMP context header parameters from the [DMP Context] section in your system instructions.",
		);
		lines.push("These 3 parameters are REQUIRED for every API call:");
		lines.push("```bash");
		lines.push(
			'python scripts/main.py <api_name> --X-User-Id "<from DMP Context>" --X-Agent-Id "<from DMP Context>" --X-Conversation-Id "<from DMP Context>" [other args...]',
		);
		lines.push("```");
		lines.push("Never omit these 3 parameters.");
		lines.push("");
	}

	for (const api of apis) {
		lines.push(`### ${api.name}`);
		lines.push("");
		if (api.description) {
			lines.push(api.description);
			lines.push("");
		}
		lines.push(`- **Method**: \`${api.method}\``);
		lines.push(`- **URL**: \`${api.url}\``);
		lines.push("");

		if (api.pathParams && api.pathParams.length > 0) {
			lines.push("**Path Parameters**:");
			lines.push("");
			lines.push(paramTable(api.pathParams));
			lines.push("");
		}

		if (api.queryParams && api.queryParams.length > 0) {
			lines.push("**Query Parameters**:");
			lines.push("");
			lines.push(paramTable(api.queryParams));
			lines.push("");
		}

		if (api.headerParams && api.headerParams.length > 0) {
			lines.push("**Header Parameters**:");
			lines.push("");
			lines.push(paramTable(api.headerParams));
			lines.push("");
		}

		if (api.body) {
			lines.push(`**Request Body** (\`${api.body.contentType}\`):`);
			lines.push("");
			if (api.body.schema && api.body.schema.length > 0) {
				lines.push(paramTable(api.body.schema));
				lines.push("");

				const nested = api.body.schema.filter((p) => p.children && p.children.length > 0);
				if (nested.length > 0) {
					lines.push("**Nested fields**:");
					lines.push(nestedParamDocs(nested, "-"));
					lines.push("");
				}
			} else {
				lines.push("See `apis.json` for full schema.");
				lines.push("");
			}
		}

		if (api.formData && api.formData.length > 0) {
			lines.push("**Form Data**:");
			lines.push("");
			lines.push(formDataTable(api.formData));
			lines.push("");
		}

		if (api.headers && Object.keys(api.headers).length > 0) {
			lines.push("**Custom Headers**:");
			lines.push("");
			for (const [key, value] of Object.entries(api.headers)) {
				lines.push(`- \`${key}\`: ${value}`);
			}
			lines.push("");
		}

		if (api.responseDescription || api.responseType) {
			lines.push("**Response**:");
			lines.push("");
			if (api.responseDescription) {
				lines.push(api.responseDescription);
			}
			if (api.responseType) {
				lines.push(`Content-Type: ${api.responseType}`);
			}
			lines.push("");
		}

		lines.push("---");
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================
// Persistence
// ============================================================

const EMPTY_SKILL = { name: "", path: "", dir: "", scriptPath: "", requirementsPath: "", apiCount: 0 };

export function createSkillFromHttpApis(
	request: CreateSkillFromHttpApisRequest,
	skillRepoDir: string,
): CreateSkillFromHttpApisResponse {
	const warnings: string[] = [];

	let apis: HttpApiDefinition[];
	let resolvedBaseUrl = request.baseUrl;
	let resolvedAuth = request.auth;

	if (request.spec) {
		const specResult = parseOpenApiSpec(request.spec);
		apis = specResult.apis;
		if (!resolvedBaseUrl && specResult.baseUrl) {
			resolvedBaseUrl = specResult.baseUrl;
		}
		if (!resolvedAuth && specResult.auth) {
			resolvedAuth = specResult.auth;
		}
		warnings.push(...specResult.warnings);
	} else if (request.apis && request.apis.length > 0) {
		apis = request.apis;
	} else {
		return {
			success: false,
			skill: { ...EMPTY_SKILL, name: request.name ?? "" },
			error: "Either 'spec' or 'apis' must be provided, and apis must not be empty",
		};
	}

	if (!request.name || !request.description) {
		return {
			success: false,
			skill: { ...EMPTY_SKILL, name: request.name ?? "" },
			error: "name and description are required",
		};
	}

	const nameError = validateSkillName(request.name);
	if (nameError) {
		return {
			success: false,
			skill: { ...EMPTY_SKILL, name: request.name },
			error: nameError,
		};
	}

	const category = request.category || "default";
	const skillDir = join(skillRepoDir, category, request.name);

	if (existsSync(skillDir) && !request.overwrite) {
		return {
			success: false,
			skill: { ...EMPTY_SKILL, name: request.name },
			error: `Skill already exists at ${skillDir}`,
		};
	}

	ensureDmpHeaderParams(request.name, apis);

	const apisJson: Record<string, unknown> = {
		name: request.name,
		description: request.description,
		category,
		baseUrl: resolvedBaseUrl,
		defaultHeaders: request.defaultHeaders,
		auth: resolvedAuth,
		apis,
		createdAt: new Date().toISOString(),
	};

	try {
		mkdirSync(skillDir, { recursive: true });

		const scriptsDir = join(skillDir, "scripts");
		mkdirSync(scriptsDir, { recursive: true });

		const skillMd = generateSkillMd(request.name, request.description, category, resolvedBaseUrl, resolvedAuth, apis);
		writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf-8");
		writeFileSync(join(skillDir, "apis.json"), JSON.stringify(apisJson, null, 2), "utf-8");

		const pythonScript = generatePythonScript(request.name);
		writeFileSync(join(scriptsDir, "main.py"), pythonScript, "utf-8");

		const requirements = generateRequirements();
		writeFileSync(join(scriptsDir, "requirements.txt"), requirements, "utf-8");

		console.log(`[HTTP API Skill] Created skill "${request.name}" with ${apis.length} APIs at ${skillDir}`);

		return {
			success: true,
			skill: {
				name: request.name,
				path: join(skillDir, "SKILL.md"),
				dir: skillDir,
				scriptPath: join(scriptsDir, "main.py"),
				requirementsPath: join(scriptsDir, "requirements.txt"),
				apiCount: apis.length,
			},
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	} catch (error) {
		return {
			success: false,
			skill: { ...EMPTY_SKILL, name: request.name },
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

// ============================================================
// Skill HTTP Handlers
// ============================================================

const MCP_SERVERS_FILE = "mcp-servers.json";
const MCPSKILLS_DIR = "mcp-skills";

interface MCPServerConfig {
	url: string;
	name?: string;
	headers?: Record<string, string>;
}

interface MCPServerInfo {
	url: string;
	name: string;
	tools: string[];
	headers?: Record<string, string>;
}

interface ExecuteSkillRequest {
	skillName?: string;
	name?: string;
	method?: string;
	headers?: Record<string, string>;
	arguments?: Record<string, unknown>;
	parameters?: Record<string, unknown>;
}

interface RepoSkillInfo {
	name: string;
	description: string;
	category: string;
	path: string;
}

interface RepoSkillDetail extends RepoSkillInfo {
	baseUrl?: string;
	source?: string;
	defaultHeaders?: Record<string, string>;
	auth?: {
		type: "bearer" | "basic" | "api-key";
		token?: string;
		username?: string;
		password?: string;
		headerName?: string;
		apiKey?: string;
	};
	mcp?: {
		serverUrl: string;
		serverHeaders?: Record<string, string>;
	};
	methods: RepoSkillMethod[];
	hasScript: boolean;
	scriptPath?: string;
}

interface RepoSkillMethod {
	name: string;
	description?: string;
	method: string;
	url: string;
	mcpToolName?: string;
	headers?: Record<string, string>;
	parameters: {
		pathParams?: RepoSkillParam[];
		queryParams?: RepoSkillParam[];
		headerParams?: RepoSkillParam[];
		body?: { contentType: string; schema?: RepoSkillParam[] };
		formData?: { name: string; type: string; description?: string; required?: boolean }[];
	};
	responseType?: string;
}

interface RepoSkillParam {
	name: string;
	type: string;
	description?: string;
	required?: boolean;
	default?: string | number | boolean;
	enum?: string[];
	children?: RepoSkillParam[];
}

function getMCPServersPath(): string {
	return join(getAgentDir(), MCP_SERVERS_FILE);
}

function getMCPSkillsDir(): string {
	return join(getAgentDir(), MCPSKILLS_DIR);
}

function loadMCPServers(): MCPServerInfo[] {
	const path = getMCPServersPath();
	if (existsSync(path)) {
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return [];
		}
	}
	return [];
}

function saveMCPServers(servers: MCPServerInfo[]): void {
	const dir = getAgentDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(getMCPServersPath(), JSON.stringify(servers, null, 2));
}

async function connectToMCP(url: string, headers?: Record<string, string>): Promise<string[]> {
	const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers };

	let sessionHeaders: Record<string, string>;
	try {
		sessionHeaders = await mcpInitializeSession(url, mcpHeaders, `connectToMCP ${url}`);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] connectToMCP fetch failed for ${url} (initialize):`, msg, error);
		throw new Error(`MCP connection failed: ${msg}`);
	}

	let listResponse: Response;
	try {
		listResponse = await mcpFetch(
			url,
			{
				method: "POST",
				headers: sessionHeaders,
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			},
			`connectToMCP ${url} (tools/list)`,
		);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] connectToMCP fetch failed for ${url} (tools/list):`, msg, error);
		throw new Error(`MCP tools/list failed: ${msg}`);
	}

	if (!listResponse.ok) throw new Error(`MCP list tools failed: ${listResponse.status} ${listResponse.statusText}`);

	const listData = await parseMcpResponse<{
		error?: { message: string };
		result?: { tools: Array<{ name: string }> };
	}>(listResponse);
	if (listData.error) throw new Error(`MCP list tools error: ${listData.error.message}`);

	return listData.result?.tools.map((t) => t.name) ?? [];
}

function createMCPSkill(serverUrl: string, toolName: string, toolDescription: string): string {
	const skillDir = getMCPSkillsDir();
	if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });

	const skillName = `mcp-${serverUrl.replace(/[^a-z0-9]/gi, "-")}-${toolName}`;
	const skillPath = join(skillDir, skillName);
	mkdirSync(skillPath, { recursive: true });

	const skillContent = `---
name: ${skillName}
description: MCP tool: ${toolName} - ${toolDescription}
---
# MCP Tool: ${toolName}

This skill executes the MCP tool "${toolName}" from server: ${serverUrl}

Parameters: none (the tool will be called with the skill name)
`;

	writeFileSync(join(skillPath, "SKILL.md"), skillContent);
	return skillName;
}

function deleteMCPSkill(serverUrl: string): void {
	const skillDir = getMCPSkillsDir();
	if (!existsSync(skillDir)) return;

	const prefix = `mcp-${serverUrl.replace(/[^a-z0-9]/gi, "-")}-`;
	const entries = readdirSync(skillDir, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.isDirectory() && entry.name.startsWith(prefix)) {
			rmSync(join(skillDir, entry.name), { recursive: true, force: true });
		}
	}
}

async function executeMCPTool(
	serverUrl: string,
	toolName: string,
	headers?: Record<string, string>,
	parameters?: Record<string, unknown>,
): Promise<unknown> {
	const mcpHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...headers,
	};

	let sessionHeaders: Record<string, string>;
	try {
		sessionHeaders = await mcpInitializeSession(serverUrl, mcpHeaders, `executeMCPTool ${serverUrl}`);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] executeMCPTool handshake failed for ${serverUrl}:`, msg, error);
		throw new Error(`MCP connection failed: ${msg}`);
	}

	const response = await mcpFetch(
		serverUrl,
		{
			method: "POST",
			headers: sessionHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: Date.now(),
				method: "tools/call",
				params: { name: toolName, arguments: parameters ?? {} },
			}),
		},
		`executeMCPTool ${serverUrl} (tools/call ${toolName})`,
	);

	if (!response.ok) throw new Error(`MCP call tool failed: ${response.status} ${response.statusText}`);

	const data = await parseMcpResponse<{ error?: { message: string }; result?: unknown }>(response);
	if (data.error) throw new Error(`MCP call tool error: ${data.error.message}`);

	return data.result;
}

async function executeRepoSkill(
	skill: RepoSkillDetail,
	methodName: string,
	parameters?: Record<string, unknown>,
	requestHeaders?: Record<string, string>,
): Promise<unknown> {
	const method = skill.methods.find((m) => m.name === methodName);
	if (!method)
		throw new Error(`Method "${methodName}" not found. Available: ${skill.methods.map((m) => m.name).join(", ")}`);

	if (skill.source === "mcp" && skill.mcp) {
		const mcpHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...skill.mcp.serverHeaders,
			...requestHeaders,
		};

		if (skill.name.startsWith("dmp-")) {
			const dmpContextPath = join(process.cwd(), ".pi", "dmp-context.json");
			if (existsSync(dmpContextPath)) {
				try {
					const dmpContext = JSON.parse(readFileSync(dmpContextPath, "utf-8")) as Record<string, string>;
					if (dmpContext["X-Agent-Id"]) mcpHeaders["X-Agent-Id"] = dmpContext["X-Agent-Id"];
					if (dmpContext["X-User-Id"]) mcpHeaders["X-User-Id"] = dmpContext["X-User-Id"];
					if (dmpContext["X-Conversation-Id"]) mcpHeaders["X-Conversation-Id"] = dmpContext["X-Conversation-Id"];
				} catch {}
			}
		}

		const toolName = method.mcpToolName ?? method.name;

		let sessionHeaders: Record<string, string>;
		try {
			sessionHeaders = await mcpInitializeSession(
				skill.mcp.serverUrl,
				mcpHeaders,
				`executeRepoSkill ${skill.mcp.serverUrl}`,
			);
		} catch (error) {
			const msg = formatMcpError(error);
			console.error(`[MCP] executeRepoSkill handshake failed for ${skill.mcp.serverUrl}:`, msg, error);
			throw new Error(`MCP connection failed: ${msg}`);
		}

		let callResponse: Response;
		try {
			callResponse = await mcpFetch(
				skill.mcp.serverUrl,
				{
					method: "POST",
					headers: sessionHeaders,
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: toolName, arguments: parameters ?? {} },
					}),
				},
				`executeRepoSkill ${skill.mcp.serverUrl} (tools/call ${toolName})`,
			);
		} catch (error) {
			const msg = formatMcpError(error);
			console.error(
				`[MCP] executeRepoSkill fetch failed for ${skill.mcp.serverUrl} (tools/call ${toolName}):`,
				msg,
				error,
			);
			throw new Error(`MCP tool call failed: ${msg}`);
		}

		if (!callResponse.ok) {
			throw new Error(`MCP tool call failed: ${callResponse.status} ${callResponse.statusText}`);
		}

		const data = await parseMcpResponse<Record<string, unknown>>(callResponse);
		if (data.error)
			return { status: callResponse.status, statusText: callResponse.statusText, body: { error: data.error } };

		return {
			status: callResponse.status,
			statusText: callResponse.statusText,
			headers: Object.fromEntries(callResponse.headers.entries()),
			body: data.result,
		};
	}

	let urlString = method.url;
	if (skill.baseUrl) urlString = skill.baseUrl + urlString;

	const usedPathParams = new Set<string>();
	if (parameters) {
		for (const [key, value] of Object.entries(parameters)) {
			const placeholder = `{${key}}`;
			if (urlString.includes(placeholder)) {
				urlString = urlString.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
				usedPathParams.add(key);
			}
		}
	}

	const url = new URL(urlString);
	if ((method.method === "GET" || method.method === "DELETE") && parameters) {
		for (const [key, value] of Object.entries(parameters)) {
			if (!usedPathParams.has(key)) url.searchParams.append(key, String(value));
		}
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...skill.defaultHeaders,
		...method.headers,
	};
	if (skill.auth) {
		switch (skill.auth.type) {
			case "bearer":
				if (skill.auth.token) headers.Authorization = `Bearer ${skill.auth.token}`;
				break;
			case "basic":
				if (skill.auth.username && skill.auth.password)
					headers.Authorization = `Basic ${Buffer.from(`${skill.auth.username}:${skill.auth.password}`).toString("base64")}`;
				break;
			case "api-key":
				if (skill.auth.headerName && skill.auth.apiKey) headers[skill.auth.headerName] = skill.auth.apiKey;
				break;
		}
	}
	if (requestHeaders) Object.assign(headers, requestHeaders);

	if (skill.name.startsWith("dmp-")) {
		const dmpContextPath = join(process.cwd(), ".pi", "dmp-context.json");
		if (existsSync(dmpContextPath)) {
			try {
				const dmpContext = JSON.parse(readFileSync(dmpContextPath, "utf-8")) as Record<string, string>;
				if (!headers["X-Agent-Id"] && dmpContext["X-Agent-Id"]) headers["X-Agent-Id"] = dmpContext["X-Agent-Id"];
				if (!headers["X-User-Id"] && dmpContext["X-User-Id"]) headers["X-User-Id"] = dmpContext["X-User-Id"];
				if (!headers["X-Conversation-Id"] && dmpContext["X-Conversation-Id"])
					headers["X-Conversation-Id"] = dmpContext["X-Conversation-Id"];
			} catch {}
		}
	}

	const fetchOptions: RequestInit = { method: method.method, headers };
	if (method.method !== "GET" && method.method !== "DELETE" && parameters) {
		const bodyParams: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(parameters)) {
			if (!usedPathParams.has(key)) bodyParams[key] = value;
		}
		if (Object.keys(bodyParams).length > 0) fetchOptions.body = JSON.stringify(bodyParams);
	}

	const response = await fetch(url.toString(), fetchOptions);
	const contentType = response.headers.get("content-type") ?? "";
	const body = contentType.includes("application/json") ? await response.json() : await response.text();

	return {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
		body,
	};
}

function loadSkillPathsFromSettings(): string[] {
	const settingsPath = join(getAgentDir(), "settings.json");
	if (!existsSync(settingsPath)) {
		return [];
	}
	try {
		const content = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content) as { skills?: string[] };
		return settings.skills ?? [];
	} catch {
		return [];
	}
}

function loadRepoSkills(): RepoSkillInfo[] {
	const skills: RepoSkillInfo[] = [];
	if (!existsSync(SKILL_REPO_BASE_DIR)) {
		return skills;
	}

	try {
		const categories = readdirSync(SKILL_REPO_BASE_DIR, { withFileTypes: true });
		for (const category of categories) {
			if (!category.isDirectory()) continue;
			const categoryPath = join(SKILL_REPO_BASE_DIR, category.name);
			const skillDirs = readdirSync(categoryPath, { withFileTypes: true });
			for (const skillDir of skillDirs) {
				if (!skillDir.isDirectory()) continue;
				const skillPath = join(categoryPath, skillDir.name);
				const skillMdPath = join(skillPath, "SKILL.md");
				if (!existsSync(skillMdPath)) continue;
				try {
					const content = readFileSync(skillMdPath, "utf-8");
					const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
					skills.push({
						name: frontmatter.name || skillDir.name,
						description: frontmatter.description || "",
						category: category.name,
						path: skillPath,
					});
				} catch {
					skills.push({
						name: skillDir.name,
						description: "",
						category: category.name,
						path: skillPath,
					});
				}
			}
		}
	} catch {}
	return skills;
}

function loadRepoSkillDetail(skillName: string): RepoSkillDetail | null {
	if (!existsSync(SKILL_REPO_BASE_DIR)) return null;

	try {
		const categories = readdirSync(SKILL_REPO_BASE_DIR, { withFileTypes: true });
		for (const category of categories) {
			if (!category.isDirectory()) continue;
			const skillDirs = readdirSync(join(SKILL_REPO_BASE_DIR, category.name), { withFileTypes: true });
			for (const skillDir of skillDirs) {
				if (!skillDir.isDirectory()) continue;
				const skillPath = join(SKILL_REPO_BASE_DIR, category.name, skillDir.name);
				const skillMdPath = join(skillPath, "SKILL.md");
				if (!existsSync(skillMdPath)) continue;

				let name = skillDir.name;
				let description = "";
				try {
					const content = readFileSync(skillMdPath, "utf-8");
					const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
					name = frontmatter.name || skillDir.name;
					description = frontmatter.description || "";
				} catch {}

				if (name !== skillName) continue;

				const apisJsonPath = join(skillPath, "apis.json");
				const scriptPath = join(skillPath, "scripts", "main.py");
				const detail: RepoSkillDetail = {
					name,
					description,
					category: category.name,
					path: skillPath,
					methods: [],
					hasScript: existsSync(scriptPath),
					scriptPath: existsSync(scriptPath) ? scriptPath : undefined,
				};

				if (existsSync(apisJsonPath)) {
					try {
						const apisJson = JSON.parse(readFileSync(apisJsonPath, "utf-8")) as {
							source?: string;
							baseUrl?: string;
							defaultHeaders?: Record<string, string>;
							auth?: RepoSkillDetail["auth"];
							mcp?: RepoSkillDetail["mcp"];
							apis?: Array<{
								name: string;
								description?: string;
								method: string;
								url: string;
								headers?: Record<string, string>;
								pathParams?: RepoSkillParam[];
								queryParams?: RepoSkillParam[];
								headerParams?: RepoSkillParam[];
								body?: { contentType: string; schema?: RepoSkillParam[] };
								formData?: { name: string; type: string; description?: string; required?: boolean }[];
								responseType?: string;
							}>;
						};
						detail.source = apisJson.source;
						detail.baseUrl = apisJson.baseUrl;
						detail.defaultHeaders = apisJson.defaultHeaders;
						if (apisJson.mcp) {
							const rawMcp = apisJson.mcp as Record<string, unknown>;
							detail.mcp = {
								serverUrl: rawMcp.serverUrl as string,
								serverHeaders: rawMcp.serverHeaders as Record<string, string> | undefined,
							};
						}
						if (apisJson.auth) {
							const rawAuth = apisJson.auth as Record<string, unknown>;
							detail.auth = {
								type: (rawAuth.type as "bearer" | "basic" | "api-key") ?? "api-key",
								token: (rawAuth.token ?? rawAuth["bearer-token"]) as string | undefined,
								username: rawAuth.username as string | undefined,
								password: rawAuth.password as string | undefined,
								headerName: (rawAuth.headerName ?? rawAuth["header-name"] ?? "api-key") as string | undefined,
								apiKey: (rawAuth.apiKey ?? rawAuth["api-key"]) as string | undefined,
							};
						}
						if (apisJson.apis) {
							detail.methods = apisJson.apis.map((api) => ({
								name: api.name,
								description: api.description,
								method: api.method,
								url: api.url,
								mcpToolName: (api as Record<string, unknown>).mcpToolName as string | undefined,
								headers: api.headers,
								parameters: {
									pathParams: api.pathParams,
									queryParams: api.queryParams,
									headerParams: api.headerParams,
									body: api.body,
									formData: api.formData,
								},
								responseType: api.responseType,
							}));
						}
					} catch {}
				}

				return detail;
			}
		}
	} catch {}
	return null;
}

export async function handleMCPServers(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "POST") {
		const body = await parseJsonBody<MCPServerConfig>(req);
		if (!body || !body.url) {
			sendError(res, 400, "Missing url in request body");
			return;
		}

		try {
			console.log(`[MCP] Connecting to ${body.url}...`);
			const tools = await connectToMCP(body.url, body.headers);

			const serverName = body.name || body.url;
			const servers = loadMCPServers();
			const existing = servers.findIndex((s) => s.url === body.url);

			if (existing >= 0) {
				servers[existing].name = serverName;
				servers[existing].tools = tools;
				servers[existing].headers = body.headers;
			} else {
				servers.push({ url: body.url, name: serverName, tools, headers: body.headers });
			}
			saveMCPServers(servers);

			for (const tool of tools) createMCPSkill(body.url, tool, `MCP tool from ${serverName}`);

			sendJson(res, 200, { success: true, server: { url: body.url, name: serverName, tools } });
		} catch (error) {
			const msg = formatMcpError(error);
			console.error(`[MCP] handleMCPServers failed for ${body.url}:`, msg, error);
			sendError(res, 500, `Failed to add MCP server: ${msg}`);
		}
		return;
	}

	if (req.method === "DELETE") {
		const body = await parseJsonBody<{ url: string }>(req);
		if (!body || !body.url) {
			sendError(res, 400, "Missing url in request body");
			return;
		}

		try {
			const servers = loadMCPServers();
			const index = servers.findIndex((s) => s.url === body.url);
			if (index < 0) {
				sendError(res, 404, `MCP server not found: ${body.url}`);
				return;
			}

			deleteMCPSkill(body.url);
			servers.splice(index, 1);
			saveMCPServers(servers);
			sendJson(res, 200, { success: true });
		} catch (error) {
			sendError(
				res,
				500,
				`Failed to remove MCP server: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		return;
	}

	if (req.method === "GET") {
		sendJson(res, 200, { servers: loadMCPServers() });
		return;
	}
}

export async function handleMCPTools(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	const servers = loadMCPServers();
	const tools: Array<{ name: string; server: string; source: string }> = [];
	for (const server of servers) {
		for (const tool of server.tools) {
			tools.push({
				name: `mcp-${server.url.replace(/[^a-z0-9]/gi, "-")}-${tool}`,
				server: server.url,
				source: server.name,
			});
		}
	}
	sendJson(res, 200, { tools });
}

export async function handleHttpSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "POST") {
		const body = await parseJsonBody<{
			name: string;
			group?: string;
			description?: string;
			method: "GET" | "POST" | "PUT" | "DELETE";
			url: string;
			headers?: Record<string, string>;
			schema?: object;
		}>(req);
		if (!body || !body.name || !body.method || !body.url) {
			sendError(res, 400, "Missing required fields: name, method, url");
			return;
		}

		const skills = loadHttpSkills();
		if (skills.find((s) => s.name === body.name)) {
			sendError(res, 409, `HTTP skill already exists: ${body.name}`);
			return;
		}

		const skill: HttpSkill = {
			id: randomUUID(),
			name: body.name,
			group: body.group ?? "default",
			description: body.description,
			method: body.method,
			url: body.url,
			headers: body.headers,
			schema: body.schema,
			createdAt: new Date().toISOString(),
		};
		skills.push(skill);
		saveHttpSkills(skills);
		sendJson(res, 200, { success: true, skill });
		return;
	}

	if (req.method === "GET") {
		const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const groupBy = urlObj.searchParams.get("groupBy");
		const skills = loadHttpSkills();

		if (groupBy === "group") {
			const groups: Record<string, HttpSkill[]> = {};
			for (const skill of skills) {
				const groupName = skill.group ?? "default";
				if (!groups[groupName]) groups[groupName] = [];
				groups[groupName].push(skill);
			}
			sendJson(res, 200, {
				groups: Object.entries(groups).map(([name, items]) => ({
					name,
					source: "http",
					items: items.map((s) => ({
						name: `http:${s.name}`,
						description: s.description,
						group: s.group,
						method: s.method,
						url: s.url,
					})),
				})),
			});
		} else {
			sendJson(res, 200, {
				skills: skills.map((s) => ({
					name: `http:${s.name}`,
					description: s.description,
					group: s.group,
					method: s.method,
					url: s.url,
					source: "http",
				})),
			});
		}
		return;
	}

	if (req.method === "DELETE") {
		const body = await parseJsonBody<{ name: string }>(req);
		if (!body || !body.name) {
			sendError(res, 400, "Missing name in request body");
			return;
		}

		const skills = loadHttpSkills();
		const index = skills.findIndex((s) => s.name === body.name);
		if (index < 0) {
			sendError(res, 404, `HTTP skill not found: ${body.name}`);
			return;
		}

		skills.splice(index, 1);
		saveHttpSkills(skills);
		sendJson(res, 200, { success: true });
		return;
	}
}

export async function handleSkillsRegisterMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "POST") {
		const body = await parseJsonBody<{ serverUrl: string; serverName?: string; headers?: Record<string, string> }>(
			req,
		);
		if (!body?.serverUrl) {
			sendError(res, 400, "Missing serverUrl in request body");
			return;
		}

		try {
			console.log(`[MCP Registry] Registering MCP server: ${body.serverUrl}`);
			const result = await discoverAndRegisterMCPTools(
				body.serverUrl,
				body.serverName || body.serverUrl,
				body.headers,
			);

			if (result.error) {
				sendError(res, 500, `MCP registration failed: ${result.error}`);
				return;
			}

			console.log(`[MCP Registry] Registered ${result.tools.length} tools from ${body.serverUrl}`);
			sendJson(res, 200, {
				success: true,
				serverUrl: body.serverUrl,
				toolCount: result.tools.length,
				tools: result.tools.map((t) => ({
					name: `mcp_${t.toolName}`,
					description: t.toolDescription,
					parameters: Object.keys(t.parameters),
				})),
			});
		} catch (error) {
			const msg = formatMcpError(error);
			console.error(`[MCP] handleSkillsRegisterMcp failed for ${body.serverUrl}:`, msg, error);
			sendError(res, 500, `MCP registration failed: ${msg}`);
		}
		return;
	}

	if (req.method === "DELETE") {
		const body = await parseJsonBody<{ serverUrl: string }>(req);
		if (!body?.serverUrl) {
			sendError(res, 400, "Missing serverUrl in request body");
			return;
		}

		const removed = unregisterMCPTools(body.serverUrl);
		if (!removed) {
			sendError(res, 404, `MCP server not found: ${body.serverUrl}`);
			return;
		}

		console.log(`[MCP Registry] Unregistered MCP server: ${body.serverUrl}`);
		sendJson(res, 200, { success: true });
		return;
	}

	if (req.method === "GET") {
		const registry = loadMCPRegistry();
		sendJson(res, 200, {
			servers: registry.map((entry) => ({
				serverUrl: entry.serverUrl,
				serverName: entry.serverName,
				toolCount: entry.tools.length,
				tools: entry.tools.map((t) => ({ name: `mcp_${t.toolName}`, description: t.toolDescription })),
			})),
		});
		return;
	}
}

export async function handleSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const groupBy = urlObj.searchParams.get("groupBy");
	const categoryFilter = urlObj.searchParams.get("category");
	const sourceFilter = urlObj.searchParams.get("source");

	const skillPaths = loadSkillPathsFromSettings();
	const { skills: loadedSkills } = loadSkills({ skillPaths, includeDefaults: true });
	const skillInfos: Array<{ name: string; description: string; source: string; scope: string; group?: string }> =
		loadedSkills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			source: skill.sourceInfo.source === "local" ? "local" : skill.sourceInfo.source,
			scope: skill.sourceInfo.scope ?? "user",
		}));

	const httpSkills = loadHttpSkills();
	for (const skill of httpSkills)
		skillInfos.push({
			name: `http:${skill.name}`,
			description: skill.description ?? skill.name,
			source: "http",
			scope: "global",
			group: skill.group,
		});

	const repoSkills = loadRepoSkills();
	for (const skill of repoSkills) {
		if (categoryFilter && skill.category !== categoryFilter) continue;
		skillInfos.push({
			name: skill.name,
			description: skill.description,
			source: "repo",
			scope: "global",
			group: skill.category,
		});
	}

	const filtered = sourceFilter ? skillInfos.filter((s) => s.source === sourceFilter) : skillInfos;

	if (groupBy === "source") {
		const groups: Record<string, typeof skillInfos> = {};
		for (const skill of filtered) {
			if (!groups[skill.source]) groups[skill.source] = [];
			groups[skill.source].push(skill);
		}
		sendJson(res, 200, {
			groups: Object.entries(groups)
				.filter(([, items]) => items.length > 0)
				.map(([source, items]) => ({ name: source, source, items })),
		});
	} else if (groupBy === "category") {
		const categories: Record<string, typeof skillInfos> = {};
		for (const skill of filtered) {
			const cat = skill.group ?? "default";
			if (!categories[cat]) categories[cat] = [];
			categories[cat].push(skill);
		}
		sendJson(res, 200, {
			categories: Object.entries(categories)
				.filter(([, items]) => items.length > 0)
				.map(([name, items]) => ({ name, items })),
		});
	} else {
		sendJson(res, 200, { skills: filtered });
	}
}

export async function handleMySkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const userId = urlObj.searchParams.get("userId") ?? getUserId(req);
	if (!userId) {
		sendError(res, 400, "userId parameter is required");
		return;
	}

	const skillsDir = join(getSessionsDir(), sanitizeId(userId), "skills");
	if (!existsSync(skillsDir)) {
		sendJson(res, 200, { skills: [] });
		return;
	}

	const results: Array<{
		name: string;
		description: string;
		parameters: string;
		lastModified: string;
	}> = [];

	const skillDirs = readdirSync(skillsDir, { withFileTypes: true });
	for (const skillDir of skillDirs) {
		if (!skillDir.isDirectory()) continue;
		const skillMdPath = join(skillsDir, skillDir.name, "SKILL.md");
		if (!existsSync(skillMdPath)) continue;

		try {
			const content = readFileSync(skillMdPath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
			const name = (frontmatter.name as string) || skillDir.name;
			const description = (frontmatter.description as string) || "";

			let parameters = "";
			if (frontmatter.parameters) {
				parameters = String(frontmatter.parameters);
			} else {
				const paramMatch = body.match(/^##\s+Parameters\s*\n([\s\S]*?)(?=\n##\s|$)/m);
				if (paramMatch) {
					parameters = paramMatch[1].trim();
				}
			}

			const mtime = statSync(skillMdPath).mtime;
			results.push({ name, description, parameters, lastModified: mtime.toISOString() });
		} catch {
			const mtime = statSync(skillMdPath).mtime;
			results.push({
				name: skillDir.name,
				description: "",
				parameters: "",
				lastModified: mtime.toISOString(),
			});
		}
	}

	results.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
	sendJson(res, 200, { skills: results });
}

/**
 * Extracts a skill zip into `destDir` and returns the final skill folder path.
 *
 * Handles both packaging conventions:
 * - Zip contains a single top-level folder (the skill folder): that folder is used as the source.
 * - Zip contains loose files at the root (no skill folder wrapper): the loose files become the source.
 *
 * The final folder name is resolved in this order:
 * 1. The `name` field from the source's `SKILL.md` frontmatter (if present and non-empty).
 * 2. The single inner folder name (when the zip wraps content in one folder).
 * 3. `fallbackSkillName` (typically derived from the zip filename).
 *
 * If the destination skill folder already exists, it is replaced.
 */
async function extractSkillZip(zipPath: string, destDir: string, fallbackSkillName: string): Promise<string> {
	const tempExtractDir = join(destDir, `.temp-extract-${randomUUID()}`);
	mkdirSync(tempExtractDir, { recursive: true });

	try {
		await extract(zipPath, { dir: tempExtractDir });

		const entries = readdirSync(tempExtractDir, { withFileTypes: true });
		const subdirs = entries.filter((e) => e.isDirectory());
		const looseFiles = entries.filter((e) => e.isFile());

		let sourceDir: string;
		let innerFolderName: string | undefined;

		if (subdirs.length === 1 && looseFiles.length === 0) {
			// Zip already wraps content in a skill folder.
			innerFolderName = subdirs[0].name;
			sourceDir = join(tempExtractDir, subdirs[0].name);
		} else {
			// No (single) wrapper folder inside the zip — the loose content is the skill folder.
			sourceDir = tempExtractDir;
		}

		// Prefer the SKILL.md name field for the final folder name; fall back to the
		// inner folder name (if any), then to the zip filename.
		let skillFolderName: string | undefined;
		const skillMdPath = join(sourceDir, "SKILL.md");
		if (existsSync(skillMdPath)) {
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
				if (frontmatter.name?.trim()) {
					skillFolderName = frontmatter.name.trim();
				}
			} catch {}
		}
		if (!skillFolderName) skillFolderName = innerFolderName;
		if (!skillFolderName) skillFolderName = fallbackSkillName;

		const finalSkillDir = join(destDir, skillFolderName);
		if (existsSync(finalSkillDir)) {
			rmSync(finalSkillDir, { recursive: true, force: true });
		}
		renameSync(sourceDir, finalSkillDir);

		return finalSkillDir;
	} finally {
		if (existsSync(tempExtractDir)) {
			rmSync(tempExtractDir, { recursive: true, force: true });
		}
	}
}

export async function handleMySkillUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const contentType = req.headers["content-type"] ?? "";
	const boundaryMatch = contentType.match(/multipart\/form-data; boundary=(.+)/);
	if (!boundaryMatch) {
		sendError(res, 400, "Expected multipart/form-data");
		return;
	}

	const boundary = boundaryMatch[1];
	const chunks: Buffer[] = [];

	await new Promise<void>((resolve, reject) => {
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", resolve);
		req.on("error", reject);
	});

	const data = Buffer.concat(chunks);
	const boundaryBuffer = Buffer.from(`--${boundary}`);
	let userId: string | undefined;
	let fileFilename: string | undefined;
	let fileBuffer: Buffer | undefined;

	let offset = 0;
	while (offset < data.length) {
		const boundaryIndex = data.indexOf(boundaryBuffer, offset);
		if (boundaryIndex === -1) break;

		const afterBoundary = boundaryIndex + boundaryBuffer.length;
		if (afterBoundary >= data.length) break;
		if (data[afterBoundary] === 0x2d && data[afterBoundary + 1] === 0x2d) break;

		let pos = afterBoundary;
		if (data[pos] === 0x0d && data[pos + 1] === 0x0a) pos += 2;

		const headerEnd = data.indexOf(Buffer.from("\r\n\r\n"), pos);
		if (headerEnd === -1) break;

		const headerStr = data.slice(pos, headerEnd).toString("utf-8");
		const bodyStart = headerEnd + 4;

		const nextBoundary = data.indexOf(boundaryBuffer, bodyStart);
		if (nextBoundary === -1) break;

		let bodyEnd = nextBoundary;
		if (bodyEnd >= 2 && data[bodyEnd - 2] === 0x0d && data[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

		const nameMatch = headerStr.match(/name="([^"]+)"/);
		const filenameMatch = headerStr.match(/filename="([^"]+)"/);
		const fieldName = nameMatch ? nameMatch[1] : undefined;
		const filename = filenameMatch ? filenameMatch[1] : undefined;

		if (filename && fieldName) {
			fileFilename = filename;
			fileBuffer = data.slice(bodyStart, bodyEnd);
		} else if (fieldName === "userId") {
			userId = data.slice(bodyStart, bodyEnd).toString("utf-8").trim();
		}

		offset = nextBoundary;
	}

	if (!userId) {
		sendError(res, 400, "userId is required");
		return;
	}
	if (!fileBuffer || !fileFilename) {
		sendError(res, 400, "No zip file uploaded");
		return;
	}
	if (!fileFilename.toLowerCase().endsWith(".zip")) {
		sendError(res, 400, "Only zip files are accepted");
		return;
	}

	const skillsDir = join(getSessionsDir(), sanitizeId(userId), "skills");
	if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

	const extractedName = fileFilename.replace(/\.zip$/i, "");

	const tempZipPath = join(skillsDir, `.temp-${randomUUID()}.zip`);
	try {
		writeFileSync(tempZipPath, fileBuffer);
		const targetSkillDir = await extractSkillZip(tempZipPath, skillsDir, extractedName);
		unlinkSync(tempZipPath);

		const skillMdPath = join(targetSkillDir, "SKILL.md");
		let skillName = basename(targetSkillDir);
		let skillDescription = "";

		if (existsSync(skillMdPath)) {
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
				if (frontmatter.name) skillName = frontmatter.name;
				if (frontmatter.description) skillDescription = frontmatter.description;
			} catch {}
		}

		sendJson(res, 200, {
			success: true,
			skill: { name: skillName, description: skillDescription, path: targetSkillDir },
		});
	} catch (error) {
		if (existsSync(tempZipPath)) unlinkSync(tempZipPath);
		sendError(res, 500, `Failed to extract skill: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

export async function handleMySkillDownload(
	req: IncomingMessage,
	res: ServerResponse,
	skillName: string,
): Promise<void> {
	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const userId = urlObj.searchParams.get("userId") ?? getUserId(req);
	if (!userId) {
		sendError(res, 400, "userId is required");
		return;
	}

	const skillDir = join(getSessionsDir(), sanitizeId(userId), "skills", sanitizeId(skillName));
	if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
		sendError(res, 404, `Skill "${skillName}" not found`);
		return;
	}

	const zipFilename = encodeURIComponent(`${skillName}.zip`);
	res.writeHead(200, {
		"Content-Disposition": `attachment; filename="${zipFilename}"`,
		"Content-Type": "application/zip",
	});

	const archive = archiver("zip", { zlib: { level: 9 } });
	archive.on("error", (err: Error) => {
		console.error("Archive error:", err);
		if (!res.writableEnded) {
			res.end();
		}
	});

	archive.pipe(res);
	archive.directory(skillDir, skillName);
	archive.finalize();
}

export async function handleSkillDownload(
	_req: IncomingMessage,
	res: ServerResponse,
	category: string,
	skillName: string,
): Promise<void> {
	const skillDir = join(getSkillRepoDir(category), sanitizeId(skillName));
	if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
		sendError(res, 404, `Skill "${skillName}" not found in category "${category}"`);
		return;
	}

	const zipFilename = encodeURIComponent(`${skillName}.zip`);
	res.writeHead(200, {
		"Content-Disposition": `attachment; filename="${zipFilename}"`,
		"Content-Type": "application/zip",
	});

	const archive = archiver("zip", { zlib: { level: 9 } });
	archive.on("error", (err: Error) => {
		console.error("Archive error:", err);
		if (!res.writableEnded) {
			res.end();
		}
	});

	archive.pipe(res);
	archive.directory(skillDir, skillName);
	archive.finalize();
}

export async function handleMySkillDelete(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const userId = urlObj.searchParams.get("userId") ?? getUserId(req);
	if (!userId) {
		sendError(res, 400, "userId is required");
		return;
	}

	const skillDir = join(getSessionsDir(), sanitizeId(userId), "skills", sanitizeId(skillName));
	if (!existsSync(skillDir)) {
		sendError(res, 404, `Skill "${skillName}" not found`);
		return;
	}

	try {
		rmSync(skillDir, { recursive: true, force: true });
		sendJson(res, 200, { success: true, deletedSkill: skillName });
	} catch (error) {
		sendError(res, 500, `Failed to delete skill: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

export async function handleSkillDetail(_req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
	const repoDetail = loadRepoSkillDetail(skillName);
	if (repoDetail) {
		sendJson(res, 200, repoDetail);
		return;
	}

	const httpSkills = loadHttpSkills();
	const httpSkill = httpSkills.find((s) => s.name === skillName);
	if (httpSkill) {
		sendJson(res, 200, {
			name: httpSkill.name,
			description: httpSkill.description,
			source: "http",
			method: httpSkill.method,
			url: httpSkill.url,
			headers: httpSkill.headers,
			schema: httpSkill.schema,
		});
		return;
	}

	const skillPaths = loadSkillPathsFromSettings();
	const { skills: loadedSkills } = loadSkills({ skillPaths, includeDefaults: true });
	const localSkill = loadedSkills.find((s) => s.name === skillName);
	if (localSkill) {
		sendJson(res, 200, {
			name: localSkill.name,
			description: localSkill.description,
			source: localSkill.sourceInfo.source,
			scope: localSkill.sourceInfo.scope,
			path: localSkill.filePath,
			disableModelInvocation: localSkill.disableModelInvocation,
		});
		return;
	}

	sendError(res, 404, `Skill "${skillName}" not found`);
}

export async function handleSkillsExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await parseJsonBody<ExecuteSkillRequest>(req);
	const skillName = body?.skillName ?? body?.name;
	const parameters = body?.parameters ?? body?.arguments;
	const requestHeaders = body?.headers;

	if (!skillName) {
		sendError(res, 400, "Missing skillName or name in request body");
		return;
	}

	if (skillName.startsWith("mcp-")) {
		const servers = loadMCPServers();
		const toolName = skillName.replace(/^mcp-[^-]+-[^-]+-/, "");

		for (const server of servers) {
			const prefix = `mcp-${server.url.replace(/[^a-z0-9]/gi, "-")}-`;
			if (skillName.startsWith(prefix)) {
				try {
					const result = await executeMCPTool(server.url, toolName, server.headers, parameters);
					sendJson(res, 200, { success: true, result });
				} catch (error) {
					sendError(
						res,
						500,
						`MCP tool execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
				return;
			}
		}
		sendError(res, 404, `MCP server not found for skill: ${skillName}`);
		return;
	}

	if (skillName.startsWith("http:")) {
		const httpSkillName = skillName.replace(/^http:/, "");
		const skills = loadHttpSkills();
		const skill = skills.find((s) => s.name === httpSkillName);
		if (!skill) {
			sendError(res, 404, `HTTP skill not found: ${httpSkillName}`);
			return;
		}

		try {
			const result = await executeHttpSkill(skill, parameters);
			sendJson(res, 200, { success: true, result });
		} catch (error) {
			sendError(
				res,
				500,
				`HTTP skill execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		return;
	}

	const repoSkill = loadRepoSkillDetail(skillName);
	if (repoSkill) {
		const methodName = body?.method as string | undefined;
		if (repoSkill.methods.length > 0 && !methodName) {
			sendError(
				res,
				400,
				`Missing "method" field. Available methods: ${repoSkill.methods.map((m) => m.name).join(", ")}`,
			);
			return;
		}
		try {
			const result = await executeRepoSkill(repoSkill, methodName ?? "", parameters, requestHeaders);
			sendJson(res, 200, { success: true, skill: skillName, method: methodName, result });
		} catch (error) {
			sendJson(res, 500, {
				success: false,
				skill: skillName,
				method: methodName,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
		return;
	}

	sendError(res, 400, "Non-MCP/Non-HTTP/Non-repo skills require agent session");
}

export async function handleSkillExecute(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
	let body: Record<string, unknown>;
	try {
		const raw = await parseJsonBody(req);
		body = (raw ?? {}) as Record<string, unknown>;
	} catch {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const methodName = body.method as string | undefined;
	const parameters = (body.parameters ?? body.arguments ?? {}) as Record<string, unknown>;
	const requestHeaders = body.headers as Record<string, string> | undefined;

	if (skillName.startsWith("http:")) {
		const httpSkillName = skillName.replace(/^http:/, "");
		const skills = loadHttpSkills();
		const skill = skills.find((s) => s.name === httpSkillName);
		if (!skill) {
			sendError(res, 404, `HTTP skill not found: ${httpSkillName}`);
			return;
		}
		try {
			const result = await executeHttpSkill(skill, parameters);
			sendJson(res, 200, { success: true, skill: skillName, method: methodName, result });
		} catch (error) {
			sendJson(res, 500, {
				success: false,
				skill: skillName,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
		return;
	}

	const repoSkill = loadRepoSkillDetail(skillName);
	if (repoSkill) {
		if (repoSkill.methods.length > 0 && !methodName) {
			sendError(
				res,
				400,
				`Missing "method" field. Available methods: ${repoSkill.methods.map((m) => m.name).join(", ")}`,
			);
			return;
		}
		try {
			const result = await executeRepoSkill(repoSkill, methodName ?? "", parameters, requestHeaders);
			sendJson(res, 200, { success: true, skill: skillName, method: methodName, result });
		} catch (error) {
			sendJson(res, 500, {
				success: false,
				skill: skillName,
				method: methodName,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
		return;
	}

	sendError(res, 404, `Skill "${skillName}" not found`);
}

export async function handleSkillsDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await parseJsonBody<{ skillName: string; category: string }>(req);
	if (!body || !body.skillName || !body.category) {
		sendError(res, 400, "skillName and category are required");
		return;
	}

	const { skillName, category } = body;
	const skillPath = join(getSkillRepoDir(category), skillName);

	if (!existsSync(skillPath)) {
		sendError(res, 404, `Skill not found: ${category}/${skillName}`);
		return;
	}

	const removedLinks: string[] = [];

	try {
		const globalSkillsDir = join(getAgentDir(), "skills");
		const globalLink = join(globalSkillsDir, skillName);
		if (existsSync(globalLink)) {
			removeLinkOrDir(globalLink);
			removedLinks.push(globalLink);
		}

		const httpSessionsDir = join(getAgentDir(), "..", "http-sessions");
		if (existsSync(httpSessionsDir)) {
			const userDirs = readdirSync(httpSessionsDir, { withFileTypes: true });
			for (const userDir of userDirs) {
				if (!userDir.isDirectory()) continue;
				const userLink = join(httpSessionsDir, userDir.name, "skills", skillName);
				if (existsSync(userLink)) {
					removeLinkOrDir(userLink);
					removedLinks.push(userLink);
				}
			}
		}

		rmSync(skillPath, { recursive: true, force: true });
		sendJson(res, 200, { success: true, removedSkill: skillPath, removedLinks });
	} catch (error) {
		sendError(res, 500, `Failed to delete skill: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

export async function handleSkillsUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const contentType = req.headers["content-type"] ?? "";
	const boundaryMatch = contentType.match(/multipart\/form-data; boundary=(.+)/);
	if (!boundaryMatch) {
		sendError(res, 400, "Expected multipart/form-data");
		return;
	}

	const boundary = boundaryMatch[1];
	const chunks: Buffer[] = [];

	await new Promise<void>((resolve, reject) => {
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", resolve);
		req.on("error", reject);
	});

	const data = Buffer.concat(chunks);
	const boundaryBuffer = Buffer.from(`--${boundary}`);
	let category: string | undefined;
	let fileFilename: string | undefined;
	let fileBuffer: Buffer | undefined;

	let offset = 0;
	while (offset < data.length) {
		const boundaryIndex = data.indexOf(boundaryBuffer, offset);
		if (boundaryIndex === -1) break;

		const afterBoundary = boundaryIndex + boundaryBuffer.length;
		if (afterBoundary >= data.length) break;
		if (data[afterBoundary] === 0x2d && data[afterBoundary + 1] === 0x2d) break;

		let pos = afterBoundary;
		if (data[pos] === 0x0d && data[pos + 1] === 0x0a) pos += 2;

		const headerEnd = data.indexOf(Buffer.from("\r\n\r\n"), pos);
		if (headerEnd === -1) break;

		const headerStr = data.slice(pos, headerEnd).toString("utf-8");
		const bodyStart = headerEnd + 4;

		const nextBoundary = data.indexOf(boundaryBuffer, bodyStart);
		if (nextBoundary === -1) break;

		let bodyEnd = nextBoundary;
		if (bodyEnd >= 2 && data[bodyEnd - 2] === 0x0d && data[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

		const nameMatch = headerStr.match(/name="([^"]+)"/);
		const filenameMatch = headerStr.match(/filename="([^"]+)"/);
		const fieldName = nameMatch ? nameMatch[1] : undefined;
		const filename = filenameMatch ? filenameMatch[1] : undefined;

		if (filename && fieldName) {
			fileFilename = filename;
			fileBuffer = data.slice(bodyStart, bodyEnd);
		} else if (fieldName === "category") category = data.slice(bodyStart, bodyEnd).toString("utf-8").trim();

		offset = nextBoundary;
	}

	if (!category) {
		sendError(res, 400, "category is required");
		return;
	}
	if (!fileBuffer || !fileFilename) {
		sendError(res, 400, "No zip file uploaded");
		return;
	}
	if (!fileFilename.toLowerCase().endsWith(".zip")) {
		sendError(res, 400, "Only zip files are accepted");
		return;
	}

	const skillRepoDir = getSkillRepoDir(category);
	if (!existsSync(skillRepoDir)) mkdirSync(skillRepoDir, { recursive: true });

	const extractedName = fileFilename.replace(/\.zip$/i, "");

	const tempZipPath = join(skillRepoDir, `.temp-${randomUUID()}.zip`);
	try {
		writeFileSync(tempZipPath, fileBuffer);
		const extractedPath = await extractSkillZip(tempZipPath, skillRepoDir, extractedName);
		unlinkSync(tempZipPath);

		const skillMdPath = join(extractedPath, "SKILL.md");

		let skillName = basename(extractedPath);
		let skillDescription = "";

		if (existsSync(skillMdPath)) {
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
				if (frontmatter.name) skillName = frontmatter.name;
				if (frontmatter.description) skillDescription = frontmatter.description;
			} catch {}
		}

		sendJson(res, 200, {
			success: true,
			skill: { name: skillName, description: skillDescription, category, path: extractedPath },
		});
	} catch (error) {
		if (existsSync(tempZipPath)) unlinkSync(tempZipPath);
		sendError(res, 500, `Failed to extract skill: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

export async function handleSkillsAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "POST") {
		const body = await parseJsonBody<{ skillName: string; category: string; target?: string }>(req);
		if (!body || !body.skillName || !body.category) {
			sendError(res, 400, "skillName and category are required");
			return;
		}

		const { skillName, category, target } = body;
		const skillRepoDir = getSkillRepoDir(category);
		const skillPath = join(skillRepoDir, skillName);

		if (!existsSync(skillPath)) {
			sendError(res, 404, `Skill not found: ${category}/${skillName}`);
			return;
		}
		if (!statSync(skillPath).isDirectory()) {
			sendError(res, 400, "Skill path is not a directory");
			return;
		}

		try {
			if (target) {
				const userSkillsDir = join(getAgentDir(), "..", "http-sessions", target, "skills");
				if (!existsSync(userSkillsDir)) mkdirSync(userSkillsDir, { recursive: true });
				const linkPath = join(userSkillsDir, skillName);
				if (existsSync(linkPath)) unlinkSync(linkPath);
				symlinkSync(skillPath, linkPath);
				sendJson(res, 200, { success: true, scope: "user", target, linkPath });
			} else {
				const globalSkillsDir = join(getAgentDir(), "skills");
				if (!existsSync(globalSkillsDir)) mkdirSync(globalSkillsDir, { recursive: true });
				const linkPath = join(globalSkillsDir, skillName);
				if (existsSync(linkPath)) unlinkSync(linkPath);
				symlinkSync(skillPath, linkPath);
				sendJson(res, 200, { success: true, scope: "global", linkPath });
			}
		} catch (error) {
			sendError(res, 500, `Failed to authorize skill: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
		return;
	}

	if (req.method === "DELETE") {
		const body = await parseJsonBody<{ skillName: string; category: string; target?: string }>(req);
		if (!body || !body.skillName) {
			sendError(res, 400, "skillName is required");
			return;
		}

		const { skillName, target } = body;

		try {
			if (target) {
				const userSkillsDir = join(getAgentDir(), "..", "http-sessions", target, "skills");
				const linkPath = join(userSkillsDir, skillName);
				removeLinkOrDir(linkPath);
				sendJson(res, 200, { success: true, scope: "user", target, removed: linkPath });
			} else {
				const globalSkillsDir = join(getAgentDir(), "skills");
				const linkPath = join(globalSkillsDir, skillName);
				removeLinkOrDir(linkPath);
				sendJson(res, 200, { success: true, scope: "global", removed: linkPath });
			}
		} catch (error) {
			sendError(
				res,
				500,
				`Failed to deauthorize skill: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		return;
	}
}

export async function handleSkillsFromHttpApis(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await parseJsonBody<CreateSkillFromHttpApisRequest>(req);
	if (!body) {
		sendError(res, 400, "Request body is required");
		return;
	}

	try {
		const result = createSkillFromHttpApis(body, SKILL_REPO_BASE_DIR);
		if (!result.success) {
			sendError(res, 400, result.error ?? "Failed to create skill from HTTP APIs");
			return;
		}
		sendJson(res, 200, result);
	} catch (error) {
		sendError(
			res,
			500,
			`Failed to create skill from HTTP APIs: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

export async function handleSkillsFromMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await parseJsonBody<{
		name: string;
		description: string;
		category?: string;
		serverUrl: string;
		serverHeaders?: Record<string, string>;
		tools?: string[];
		overwrite?: boolean;
	}>(req);
	if (!body) {
		sendError(res, 400, "Request body is required");
		return;
	}

	try {
		const result = await createSkillFromMcp(body, SKILL_REPO_BASE_DIR);
		if (!result.success) {
			sendError(res, 400, result.error ?? "Failed to create skill from MCP");
			return;
		}
		sendJson(res, 200, result);
	} catch (error) {
		const msg = formatMcpError(error);
		console.error(`[MCP] handleSkillsFromMcp failed for ${body.serverUrl}:`, msg, error);
		sendError(res, 500, `Failed to create skill from MCP: ${msg}`);
	}
}
