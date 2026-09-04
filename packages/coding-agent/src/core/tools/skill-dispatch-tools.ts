import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	extractMcpConnection,
	findHttpSkillEntry,
	findMcpServerEntry,
	findRepoSkillEntry,
	type HttpSkillCatalogEntry,
} from "../mongo/catalog-service.js";
import { maskSecretValues, type ResolvedCredential, resolveCredentialsWithRef } from "../mongo/credential-service.js";
import { isMongoEnabled } from "../mongo/db.js";
import type { CredentialBinding } from "../mongo/types.js";
import { callMCPTool, type MCPToolConfig, probeMcpServerTools } from "./mcp-registry.js";

/**
 * Two-stage skill dispatch tools (docs/credential-skill-dev-plan.md §5.4).
 *
 * `skill_describe(skill)` lists a skill's APIs/tools; `skill_execute` invokes
 * one. This is the single choke point where credentials are resolved and
 * injected — the model only ever passes schema-validated business params, so
 * secrets never enter the model-reachable surface (no bash, no env dumps).
 */

const CREDENTIAL_MISSING_GUIDANCE = (kind: "skill" | "mcp", name: string, needed: string) =>
	`Credential required but not bound for ${kind} "${name}" (needs: ${needed}). ` +
	`Ask the user to configure it on the user portal ("My Credentials" page), then retry. ` +
	`Do NOT ask the user to paste credential values into the conversation.`;

const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

interface ProbeCacheEntry {
	tools: MCPToolConfig[];
	expiresAt: number;
	/** Headers the probe ran with — reused for the call so sessions match binding. */
	headers?: Record<string, string>;
}

const probeCache = new Map<string, ProbeCacheEntry>();

function probeCacheKey(userId: string, serverName: string): string {
	return `${userId}:${serverName}`;
}

// ---------------------------------------------------------------------------
// Credential header binding
// ---------------------------------------------------------------------------

function buildCredentialHeaders(
	binding: CredentialBinding | undefined,
	credentials: ResolvedCredential | null,
	schemaFields: Array<{ secretKey: string; sensitive?: boolean }> | undefined,
): Record<string, string> {
	if (!credentials) return {};
	const headers: Record<string, string> = {};
	if (binding?.authType === "bearer") {
		const bearerKey = schemaFields?.find((f) => f.sensitive)?.secretKey ?? Object.keys(credentials.values)[0];
		const token = credentials.values[bearerKey];
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}
	// Per-field mapping: mapped fields use headerMap, unmapped fields fall
	// back to their own credential field name as the header key.
	const headerMap = binding?.headerMap ?? {};
	for (const [secretKey, value] of Object.entries(credentials.values)) {
		if (!value) continue;
		const headerName = headerMap[secretKey] || secretKey;
		headers[headerName] = value;
	}
	return headers;
}

/** Environment variable name for a script skill credential field: mapped env name, or the field name as-is. */
function credentialEnvName(secretKey: string, envBinding?: { envMap?: Record<string, string> }): string {
	return envBinding?.envMap?.[secretKey] || secretKey;
}

// ---------------------------------------------------------------------------
// http executor
// ---------------------------------------------------------------------------

interface HttpApiDef {
	name?: string;
	description?: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	pathParams?: Array<{ name: string; required?: boolean }>;
	queryParams?: Array<{ name: string; required?: boolean }>;
	headerParams?: Array<{ name: string; required?: boolean }>;
	exposeToModel?: boolean;
}

function summarizeHttpApi(api: HttpApiDef): string {
	const method = (api.method ?? "GET").toUpperCase();
	const parts = [`- ${api.name ?? "(unnamed)"} [${method} ${api.url ?? ""}]`];
	if (api.description) parts.push(`  ${api.description}`);
	const params = [
		...(api.pathParams ?? []).map((p) => `path:${p.name}${p.required ? "*" : ""}`),
		...(api.queryParams ?? []).map((p) => `query:${p.name}${p.required ? "*" : ""}`),
		...(api.headerParams ?? []).map((p) => `header:${p.name}${p.required ? "*" : ""}`),
	];
	if (params.length > 0) parts.push(`  params: ${params.join(", ")}`);
	return parts.join("\n");
}

async function executeHttpApi(
	userId: string,
	entry: HttpSkillCatalogEntry,
	apiName: string,
	params: Record<string, unknown>,
): Promise<string> {
	const apis = (entry.skill.apiDefinitions ?? []) as HttpApiDef[];
	const api = apis.find((a) => a.name === apiName && a.exposeToModel !== false);
	if (!api) {
		const available = apis.filter((a) => a.exposeToModel !== false && a.name).map((a) => a.name);
		return `API "${apiName}" not found on http skill "${entry.name}". Available: ${available.join(", ") || "(none)"}`;
	}

	let credentials: ResolvedCredential | null = null;
	if (entry.requiresCredentials) {
		credentials = await resolveCredentialsWithRef(userId, "skill", entry.name, entry.skill.credentialRef);
		if (!credentials) {
			const needed = (entry.skill as { credentialSchema?: Array<{ secretKey: string; displayName?: string }> })
				.credentialSchema;
			const names = (needed ?? []).map((f) => f.displayName ?? f.secretKey).join(", ") || "credentials";
			return CREDENTIAL_MISSING_GUIDANCE("skill", entry.name, names);
		}
	}

	// URL template + validation
	let urlString = api.url ?? "";
	const missing: string[] = [];
	for (const p of api.pathParams ?? []) {
		const value = params[p.name];
		if (value === undefined || value === null || value === "") {
			if (p.required) missing.push(p.name);
		} else {
			urlString = urlString.replaceAll(`{${p.name}}`, encodeURIComponent(String(value)));
		}
	}
	for (const p of [...(api.queryParams ?? []), ...(api.headerParams ?? [])]) {
		if (p.required && (params[p.name] === undefined || params[p.name] === null || params[p.name] === "")) {
			missing.push(p.name);
		}
	}
	if (missing.length > 0) {
		return `Missing required parameters: ${missing.join(", ")}. Provide them in params and retry.`;
	}

	const method = (api.method ?? "GET").toUpperCase();
	const url = new URL(urlString);
	const headers: Record<string, string> = {
		Accept: "application/json",
		...(api.headers ?? {}),
	};
	if (credentials) {
		Object.assign(headers, buildCredentialHeaders(entry.skill.credentialBinding, credentials, undefined));
	}
	for (const p of api.headerParams ?? []) {
		if (params[p.name] !== undefined) headers[p.name] = String(params[p.name]);
	}

	let body: string | undefined;
	if (method === "GET") {
		for (const p of api.queryParams ?? []) {
			if (params[p.name] !== undefined) url.searchParams.append(p.name, String(params[p.name]));
		}
	} else {
		const payload: Record<string, unknown> = {};
		for (const p of api.queryParams ?? []) {
			if (params[p.name] !== undefined) payload[p.name] = params[p.name];
		}
		for (const [key, value] of Object.entries(params)) {
			if (!payload[key]) payload[key] = value;
		}
		body = JSON.stringify(payload);
		headers["Content-Type"] = "application/json";
	}

	const response = await fetch(url.toString(), { method, headers, body });
	const contentType = response.headers.get("content-type") ?? "";
	let output: string;
	if (contentType.includes("application/json")) {
		output = JSON.stringify(await response.json(), null, 2);
	} else {
		output = await response.text();
	}
	if (!response.ok) {
		output = `HTTP ${response.status} ${response.statusText}\n${output}`;
	}
	return credentials ? maskSecretValues(output, credentials.values) : output;
}

// ---------------------------------------------------------------------------
// mcp executor
// ---------------------------------------------------------------------------

async function resolveMcpToolConfig(
	userId: string,
	serverName: string,
	toolName: string | undefined,
): Promise<{ config?: MCPToolConfig; error?: string }> {
	const entry = await findMcpServerEntry(userId, serverName);
	if (!entry) return { error: `MCP server "${serverName}" not found or not visible to this user.` };

	const { serverUrl, headers: staticHeaders } = extractMcpConnection(entry.server);
	const headers: Record<string, string> = { ...staticHeaders };
	let credentials: ResolvedCredential | null = null;
	if (entry.requiresCredentials) {
		credentials = await resolveCredentialsWithRef(userId, "mcp", serverName, entry.server.credentialRef);
		if (!credentials) {
			const names =
				(entry.server.credentialSchema ?? []).map((f) => f.displayName ?? f.secretKey).join(", ") || "credentials";
			return { error: CREDENTIAL_MISSING_GUIDANCE("mcp", serverName, names) };
		}
		Object.assign(
			headers,
			buildCredentialHeaders(entry.server.credentialBinding, credentials, entry.server.credentialSchema),
		);
	} else {
		// Credential-less servers may still reference a credential for the arp
		// user-key ({{MCP_API_KEY}}) mechanism — resolve best-effort.
		if (entry.server.credentialRef) {
			credentials = await resolveCredentialsWithRef(userId, "mcp", serverName, entry.server.credentialRef);
		}
	}
	// Replace {{MCP_API_KEY}} placeholders (arp user-key mechanism): use the
	// first credential value when available, drop the header otherwise.
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string" && value.includes("{{MCP_API_KEY}}")) {
			const credValue = credentials ? Object.values(credentials.values)[0] : undefined;
			if (credValue) {
				headers[key] = value.replaceAll("{{MCP_API_KEY}}", credValue);
			} else {
				delete headers[key];
			}
		}
	}

	const cacheKey = probeCacheKey(userId, serverName);
	const cached = probeCache.get(cacheKey);
	const fresh = cached && Date.now() < cached.expiresAt;
	let tools = fresh ? cached.tools : undefined;
	if (!tools) {
		const probe = await probeMcpServerTools(serverUrl, serverName, headers);
		if (probe.error) return { error: probe.error };
		tools = probe.tools;
		probeCache.set(cacheKey, { tools, expiresAt: Date.now() + PROBE_CACHE_TTL_MS, headers });
	}
	if (toolName === undefined) return {};

	const config = tools.find((t) => t.toolName === toolName);
	if (!config) {
		return { error: `Tool "${toolName}" not found on MCP server "${serverName}".` };
	}
	// Per-user headers (credentials resolved above) override the probe snapshot.
	return { config: { ...config, headers } };
}

// ---------------------------------------------------------------------------
// script executor (server-side spawn)
// ---------------------------------------------------------------------------

function executeScriptSkill(
	skillDir: string,
	credentials: ResolvedCredential | null,
	params: Record<string, unknown>,
	envBinding?: { envMap?: Record<string, string> },
): Promise<string> {
	const scriptPath = join(skillDir, "scripts", "main.py");
	if (!existsSync(scriptPath)) {
		return Promise.resolve(`Script not found: ${scriptPath}`);
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	if (credentials) {
		for (const [secretKey, value] of Object.entries(credentials.values)) {
			env[credentialEnvName(secretKey, envBinding)] = value;
		}
	}
	return new Promise((resolve) => {
		const child = spawn("python", [scriptPath], {
			cwd: skillDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (text: string) => {
			if (settled) return;
			settled = true;
			const output = stderr ? `${text}\n[stderr]\n${stderr}` : text;
			resolve(credentials ? maskSecretValues(output, credentials.values) : output);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (err) => finish(`Failed to spawn python: ${err.message}`));
		child.on("close", (code) => finish(code === 0 ? stdout || "(no output)" : `Exit code ${code}\n${stdout}`));
		const timer = setTimeout(() => {
			child.kill();
			finish(`${stdout}\n(timeout after ${SCRIPT_TIMEOUT_MS / 1000}s, process killed)`);
		}, SCRIPT_TIMEOUT_MS);
		child.on("close", () => clearTimeout(timer));
		child.stdin.write(JSON.stringify(params));
		child.stdin.end();
	});
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

export function createSkillDispatchTools(userId: string, agentId?: string | null): AgentTool[] {
	if (!isMongoEnabled()) return [];

	const skillDescribeTool: AgentTool = {
		name: "skill_describe",
		label: "skill_describe",
		description:
			"List the APIs (http skills) or tools (MCP servers) of one skill by name. " +
			"Use before skill_execute. Skill names come from <available_http_skills> / <available_mcp_skills>.",
		parameters: {
			type: "object",
			properties: {
				skill: { type: "string", description: "Skill name exactly as listed in the catalog" },
			},
			required: ["skill"],
		} as never,
		async execute(_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> {
			const { skill } = params as { skill: string };
			const httpEntry = await findHttpSkillEntry(userId, agentId, skill);
			if (httpEntry) {
				const apis = (httpEntry.skill.apiDefinitions ?? []) as HttpApiDef[];
				const visible = apis.filter((a) => a.exposeToModel !== false);
				const lines = [`http skill "${skill}" — ${visible.length} API(s):`, ...visible.map(summarizeHttpApi)];
				return textResult(lines.join("\n"));
			}
			const mcpResolved = await resolveMcpToolConfig(userId, skill, undefined);
			if (mcpResolved.error) {
				return textResult(mcpResolved.error);
			}
			const tools = probeCache.get(probeCacheKey(userId, skill))?.tools ?? [];
			if (tools.length === 0) return textResult(`MCP server "${skill}" exposes no tools.`);
			const lines = tools.map(
				(t) =>
					`- ${t.toolName}: ${t.toolDescription}` +
					(Object.keys(t.parameters).length > 0
						? `\n  params: ${Object.entries(t.parameters)
								.map(([k, p]) => `${k}:${p.type}${p.required ? "*" : ""}`)
								.join(", ")}`
						: ""),
			);
			return textResult(`mcp server "${skill}" — ${tools.length} tool(s):\n${lines.join("\n")}`);
		},
	};

	const skillExecuteTool: AgentTool = {
		name: "skill_execute",
		label: "skill_execute",
		description:
			"Execute one API/tool of a skill. Credentials are injected server-side; pass only business params. " +
			"Run skill_describe first to get exact parameter names (* = required).",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["http", "mcp", "script"], description: "Skill kind" },
				skill: { type: "string", description: "Skill name from the catalog" },
				api: { type: "string", description: "API name (http) or tool name (mcp)" },
				params: { type: "object", description: "Business parameters as JSON" },
			},
			required: ["kind", "skill", "api"],
		} as never,
		async execute(_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> {
			const { kind, skill, api } = params as { kind: string; skill: string; api: string };
			const callParams = ((params as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
			try {
				if (kind === "http") {
					const entry = await findHttpSkillEntry(userId, agentId, skill);
					if (!entry) return textResult(`http skill "${skill}" not found or not visible.`);
					return textResult(await executeHttpApi(userId, entry, api, callParams));
				}
				if (kind === "mcp") {
					const resolved = await resolveMcpToolConfig(userId, skill, api);
					if (resolved.error || !resolved.config) {
						return textResult(resolved.error ?? "Tool not found.");
					}
					const result = await callMCPTool(resolved.config, callParams);
					const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
					const entry = await findMcpServerEntry(userId, skill);
					if (entry?.requiresCredentials) {
						const credentials = await resolveCredentialsWithRef(userId, "mcp", skill, entry.server.credentialRef);
						if (credentials) return textResult(maskSecretValues(text, credentials.values));
					}
					return textResult(text);
				}
				if (kind === "script") {
					const repoSkill = await findRepoSkillEntry(userId, agentId, skill);
					if (!repoSkill || !repoSkill.savePath) {
						return textResult(`script skill "${skill}" not found or not visible.`);
					}
					let credentials: ResolvedCredential | null = null;
					if (repoSkill.requiresCredentials) {
						credentials = await resolveCredentialsWithRef(userId, "skill", skill, repoSkill.credentialRef);
						if (!credentials) {
							return textResult(CREDENTIAL_MISSING_GUIDANCE("skill", skill, "credentials"));
						}
					}
					return textResult(
						await executeScriptSkill(repoSkill.savePath, credentials, callParams, repoSkill.credentialBinding),
					);
				}
				return textResult(`Unknown kind "${kind}" (expected http | mcp | script).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(`skill_execute failed: ${message}`);
			}
		},
	};

	return [skillDescribeTool, skillExecuteTool];
}
