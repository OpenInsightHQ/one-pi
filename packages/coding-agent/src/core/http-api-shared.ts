import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve as resolvePath, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getAgentDir, getSessionsDir } from "../config.js";
import type { AgentSession } from "./agent-session.js";
import {
	checkAgentSkillPermission,
	checkSkillPermission,
	formatAvailablePromptsPrompt,
	formatMemoriesPrompt,
	getAccessiblePiPrompts,
	getAgentSkillDirs,
	getAuthorizedSkillDirs,
	getUserMemoriesWithAccess,
	isAgentPrincipalId,
} from "./mongo/index.js";
import type { ResourceLoader } from "./resource-loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import type { CreateAgentSessionOptions } from "./sdk.js";
import type { PathGuard } from "./tools/path-utils.js";

export interface SessionStore {
	sessions: Map<string, Map<string, AgentSession>>;
	options: Map<string, Map<string, CreateAgentSessionOptions>>;
}

export const sessionStore: SessionStore = {
	sessions: new Map(),
	options: new Map(),
};

export interface UploadLimits {
	maxFileSize: number;
	maxTotalSize: number;
	allowedTypes: string[];
}

const parseBytesFromEnv = (envVar: string, defaultMb: number): number => {
	const val = process.env[envVar];
	if (!val) return defaultMb * 1024 * 1024;
	const parsed = Number.parseInt(val, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultMb * 1024 * 1024;
	return parsed * 1024 * 1024;
};

export const defaultUploadLimits: UploadLimits = {
	maxFileSize: parseBytesFromEnv("PI_MAX_FILE_SIZE_MB", 1024),
	maxTotalSize: parseBytesFromEnv("PI_MAX_TOTAL_SIZE_MB", 2048),
	allowedTypes: [],
};

export let uploadLimits: UploadLimits = { ...defaultUploadLimits };

export function setUploadLimits(limits: Partial<UploadLimits>): void {
	uploadLimits = { ...defaultUploadLimits, ...limits };
}

export interface ChunkInfo {
	chunkIndex: number;
	chunk: Buffer;
	received: boolean;
}

export interface UploadSession {
	uploadId: string;
	agentId: string;
	sessionId: string;
	filename: string;
	totalSize: number;
	totalChunks: number;
	chunks: Map<number, ChunkInfo>;
	createdAt: number;
}

export const uploadSessions: Map<string, UploadSession> = new Map();

export let defaultHttpModel: Model<Api> | undefined;

export function setDefaultHttpModel(model: Model<Api> | undefined): void {
	defaultHttpModel = model;
}

export interface HttpModelConfig {
	api?: string;
	apiKey: string;
	baseUrl: string;
	provider: string;
	model: string;
	contextWindow?: number;
	maxTokens?: number;
}

export let httpModelConfig: HttpModelConfig | undefined;

export function setHttpModelConfig(config: HttpModelConfig | undefined): void {
	httpModelConfig = config;
}

const HTTP_MODEL_CONFIG_FILE = "http-model-config.json";

export function getHttpModelConfigPath(): string {
	return join(getAgentDir(), HTTP_MODEL_CONFIG_FILE);
}

export function saveHttpModelConfig(config: HttpModelConfig): void {
	const dir = getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getHttpModelConfigPath(), JSON.stringify(config, null, 2));
}

export function loadHttpModelConfig(): HttpModelConfig | undefined {
	const path = getHttpModelConfigPath();
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as HttpModelConfig;
	} catch {
		return undefined;
	}
}

export function buildModelFromConfig(config: HttpModelConfig, fallbackBaseUrl?: string): Model<Api> {
	let baseUrl = config.baseUrl || fallbackBaseUrl || "https://api.openai.com/v1";
	let api: Api = config.api as Api;

	if (!api) {
		const providerApiMap: Record<string, Api> = {
			anthropic: "anthropic-messages",
			google: "google-generative-ai",
			"amazon-bedrock": "bedrock-converse-stream",
		};
		api = providerApiMap[config.provider] || ("openai-completions" as Api);
	}

	if (api === "anthropic-messages") {
		baseUrl = baseUrl.replace(/\/v1\/?$/, "");
	}

	return {
		id: config.model,
		name: config.model,
		api,
		provider: config.provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow ?? 128000,
		maxTokens: config.maxTokens ?? 16384,
	};
}

export const SKILL_REPO_BASE_DIR = process.env.SKILL_REPO_DIR || "/app/skill-repo";

let PI_API_KEY = process.env.PI_API_KEY;

if (!PI_API_KEY) {
	PI_API_KEY = randomUUID();
	console.log(`[HTTP] No PI_API_KEY set, auto-generated: ${PI_API_KEY}`);
}

export function getUserId(req: IncomingMessage): string | null {
	const userId = req.headers["x-user-id"];
	if (!userId || typeof userId !== "string") {
		return null;
	}
	return userId;
}

export function getUserIdOrReject(req: IncomingMessage, res: ServerResponse): string | null {
	const userId = getUserId(req);
	if (!userId) {
		sendError(res, 401, "X-User-Id header is required");
		return null;
	}
	return userId;
}

export function getUserSessionDir(userId: string, agentId: string, sessionId: string): string {
	return join(getSessionsDir(), sanitizeId(userId), sanitizeId(agentId), sanitizeId(sessionId));
}

/**
 * The per-user root directory under which all of a user's agent sessions and
 * skills live: `<sessionsDir>/<userId>/`. Used as the tools' `allowedRoot` so an
 * agent can query the user's own files and create skills under `<userRoot>/skills`
 * while its working directory (`cwd`) stays at a single session directory.
 */
export function getUserRootDir(userId: string): string {
	return join(getSessionsDir(), sanitizeId(userId));
}

export function sanitizeId(id: string): string {
	if (id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
		throw new Error(`Invalid identifier: contains forbidden characters`);
	}
	return id;
}

export function validatePathWithinCwd(cwd: string, inputPath: string): string {
	const normalizedCwd = resolvePath(cwd);
	const resolved = resolvePath(normalizedCwd, inputPath);
	if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd + sep)) {
		throw new Error(`Access denied: path '${inputPath}' is outside the working directory`);
	}
	return resolved;
}

/**
 * Builds the {@link ResourceLoader} for an HTTP API session.
 *
 * Skill visibility depends on the principal:
 *   - `agentId` starting with `agent_` (arp agent): only the skills listed in
 *     the agent document's `skills` field (MongoDB `agents` collection) are
 *     loaded. The user ACL is NOT consulted.
 *   - Otherwise: skills the user has VIEW permission on (ACL), as before.
 */
export async function createHttpResourceLoader(
	userId: string,
	cwd: string,
	agentId?: string | null,
): Promise<ResourceLoader> {
	const agentDir = getAgentDir();
	const additionalSkillPaths: string[] = [];

	// (1) Personal skills — stored in the user's own skill directory
	const userSkillsDir = join(getSessionsDir(), userId, "skills");
	if (existsSync(userSkillsDir)) {
		additionalSkillPaths.push(userSkillsDir);
	}

	// (2) Authorized skills — fetched from MongoDB. Agent principals (`agent_*`)
	//     resolve skills from the agent document; user principals use the ACL.
	//     If MongoDB is not configured or the query fails, we gracefully continue
	//     with personal skills only.
	if (isAgentPrincipalId(agentId)) {
		try {
			const agentDirs = await getAgentSkillDirs(agentId);
			additionalSkillPaths.push(...agentDirs);
			if (agentDirs.length > 0) {
				console.log(`[HTTP] Loaded ${agentDirs.length} skill(s) assigned to agent ${agentId} from MongoDB`);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[HTTP] Failed to load skills for agent ${agentId} from MongoDB: ${msg}`);
		}
	} else {
		try {
			const authorizedDirs = await getAuthorizedSkillDirs(userId);
			additionalSkillPaths.push(...authorizedDirs);
			if (authorizedDirs.length > 0) {
				console.log(`[HTTP] Loaded ${authorizedDirs.length} authorized skill(s) from MongoDB for user ${userId}`);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[HTTP] Failed to load authorized skills from MongoDB for user ${userId}: ${msg}`);
		}
	}

	// NOTE: the loader must keep the FULL skill list even in skill-execution
	// mode - /skill: command expansion (_expandSkillCommand) resolves skills
	// from this list. Hiding the <available_skills> catalog from the system
	// prompt is handled by AgentSession.setSkillCatalogHidden, which only
	// rebuilds the prompt and never touches the loader.
	const loader = new DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths });
	await loader.reload();
	return loader;
}

/**
 * Creates a {@link PathGuard} that enforces per-principal skill ACLs on paths
 * under {@link SKILL_REPO_BASE_DIR}. Paths outside the skill repo are always
 * allowed.
 *
 * Authorization source:
 *   - `agentId` starting with `agent_` (arp agent): allowed only when the
 *     skill is listed in the agent document's `skills` field (MongoDB `agents`
 *     collection). The user ACL is NOT consulted; a missing agent document or
 *     missing skill entry denies access.
 *   - Otherwise: the user ACL via {@link checkSkillPermission}.
 *
 * The skill directory name is extracted from the path structure
 * `SKILL_REPO_BASE_DIR/<category>/<skillDirName>/...` and checked against the
 * matching principal. Non-catalog skills are allowed for user principals
 * (personal/local).
 */
export function createSkillPathGuard(userId: string, agentId?: string | null): PathGuard {
	const normalizedBase = resolvePath(SKILL_REPO_BASE_DIR);
	return async (absolutePath: string): Promise<void> => {
		const normalizedPath = resolvePath(absolutePath);
		if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(normalizedBase + sep)) {
			return;
		}
		const relative = normalizedPath.slice(normalizedBase.length + 1);
		const parts = relative.split(/[/\\]/);
		if (parts.length < 2) return;
		const skillDirName = parts[1];
		const allowed = isAgentPrincipalId(agentId)
			? await checkAgentSkillPermission(agentId, skillDirName)
			: await checkSkillPermission(userId, skillDirName);
		if (!allowed) {
			const principal = isAgentPrincipalId(agentId) ? `Agent "${agentId}"` : "The user";
			throw new Error(
				`PERMISSION DENIED: ${principal} does not have access to skill "${skillDirName}". ` +
					`The skill does not exist or access has not been granted. ` +
					`This is an authorization restriction, not a technical error. ` +
					`Do NOT attempt to access this skill via any other method (read, bash, find, cat, python, etc.). ` +
					`Stop immediately and tell the user: the skill "${skillDirName}" does not exist or they do not have ` +
					`permission to use it, and they should contact an administrator to request access.`,
			);
		}
	};
}

export function getBaseUrl(): string {
	const httpHost = "0.0.0.0";
	const httpPort = 3000;
	return `http://${httpHost}:${httpPort}`;
}

/**
 * Builds the per-user context appended to the system prompt on every turn
 * (migrated from arp's pi.system prompt composition):
 *
 *   1. `<available_prompts>` — pi-flagged system prompts (`systemprompts`
 *      collection) the user has ACL VIEW permission on, with their
 *      server-local file locations.
 *   2. `[用户长期记忆]` — the user's long-term memories (`memoryentries`
 *      collection), gated by role MEMORIES USE+READ and the personalization
 *      opt-out.
 *
 * Each section is fetched independently; failures degrade to an empty string
 * so a MongoDB hiccup never blocks the chat turn.
 */
export async function buildUserContextSuffix(userId: string): Promise<string> {
	if (!userId || userId === "system") return "";

	const parts: string[] = [];

	try {
		const prompts = await getAccessiblePiPrompts(userId);
		const promptsText = formatAvailablePromptsPrompt(prompts);
		if (promptsText) parts.push(promptsText);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[HTTP] Failed to load available prompts for user ${userId}: ${msg}`);
	}

	try {
		const memories = await getUserMemoriesWithAccess(userId);
		if (memories) {
			const memoriesText = formatMemoriesPrompt(memories);
			if (memoriesText) parts.push(memoriesText);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[HTTP] Failed to load memories for user ${userId}: ${msg}`);
	}

	return parts.join("\n\n");
}

export function createDmpSpawnHook(userId: string, agentId: string, sessionId: string) {
	return (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => {
		ctx.env["X-User-Id"] = userId;
		ctx.env["X-Agent-Id"] = agentId;
		ctx.env["X-Conversation-Id"] = sessionId;
		ctx.env.DMP_CONTEXT_PATH = ctx.cwd;
		return ctx;
	};
}

export function getOrCreateAgentSessionMap(agentId: string): Map<string, AgentSession> {
	let agentSessions = sessionStore.sessions.get(agentId);
	if (!agentSessions) {
		agentSessions = new Map();
		sessionStore.sessions.set(agentId, agentSessions);
	}
	return agentSessions;
}

export function getOrCreateAgentOptionsMap(agentId: string): Map<string, CreateAgentSessionOptions> {
	let agentOptions = sessionStore.options.get(agentId);
	if (!agentOptions) {
		agentOptions = new Map();
		sessionStore.options.set(agentId, agentOptions);
	}
	return agentOptions;
}

export function getMimeType(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	const mimeTypes: Record<string, string> = {
		pdf: "application/pdf",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		html: "text/html",
		js: "application/javascript",
		ts: "application/typescript",
		py: "text/x-python",
		json: "application/json",
		txt: "text/plain",
	};
	return mimeTypes[ext] || "application/octet-stream";
}

export function validateFileType(_filename: string): boolean {
	return true;
}

export function validateFileSize(size: number): boolean {
	return size <= uploadLimits.maxFileSize;
}

export function cleanExpiredUploadSessions(): void {
	const now = Date.now();
	const maxAge = 24 * 60 * 60 * 1000;
	for (const [uploadId, session] of uploadSessions.entries()) {
		if (now - session.createdAt > maxAge) {
			uploadSessions.delete(uploadId);
		}
	}
}

export async function parseJsonBody<T>(req: IncomingMessage): Promise<T | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf-8");
			if (!body) {
				resolve(null);
				return;
			}
			try {
				resolve(JSON.parse(body) as T);
			} catch {
				resolve(null);
			}
		});
	});
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

export function sendSSE(res: ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
	if (typeof (res as any).flush === "function") {
		(res as any).flush();
	}
}

export function authenticate(req: IncomingMessage): boolean {
	if (!PI_API_KEY) {
		return true;
	}
	const apiKey = req.headers["api-key"];
	return apiKey === PI_API_KEY;
}

export function getSkillRepoDir(category: string): string {
	return join(SKILL_REPO_BASE_DIR, category);
}

export function removeLinkOrDir(path: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return;
	if (stat.isDirectory() && !stat.isSymbolicLink()) {
		rmSync(path, { recursive: true, force: true });
	} else {
		try {
			unlinkSync(path);
		} catch {
			rmSync(path, { force: true });
		}
	}
}

export interface HttpServerOptions {
	port?: number;
	host?: string;
	uploadLimits?: Partial<UploadLimits>;
}

export interface HttpSkill {
	id: string;
	name: string;
	description?: string;
	group?: string;
	method: "GET" | "POST" | "PUT" | "DELETE";
	url: string;
	headers?: Record<string, string>;
	schema?: object;
	createdAt: string;
}

const HTTP_SKILLS_FILE = "http-skills.json";

export function loadHttpSkills(): HttpSkill[] {
	const path = join(getAgentDir(), HTTP_SKILLS_FILE);
	if (existsSync(path)) {
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return [];
		}
	}
	return [];
}

export function saveHttpSkills(skills: HttpSkill[]): void {
	const dir = getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, HTTP_SKILLS_FILE), JSON.stringify(skills, null, 2));
}

export async function executeHttpSkill(skill: HttpSkill, parameters?: Record<string, unknown>): Promise<unknown> {
	let urlString = skill.url;
	const pathParams: string[] = [];
	if (parameters) {
		for (const [key, value] of Object.entries(parameters)) {
			const placeholder = `{${key}}`;
			if (urlString.includes(placeholder)) {
				urlString = urlString.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
				pathParams.push(key);
			}
		}
	}

	const url = new URL(urlString);
	if (skill.method === "GET" && parameters) {
		for (const [key, value] of Object.entries(parameters)) {
			if (!pathParams.includes(key)) url.searchParams.append(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		method: skill.method,
		headers: skill.headers,
		body: skill.method !== "GET" && parameters ? JSON.stringify(parameters) : undefined,
	});

	if (!response.ok) throw new Error(`HTTP call failed: ${response.status} ${response.statusText}`);

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) return response.json();
	return response.text();
}

function createHttpSkillAgentTool(skill: HttpSkill): AgentTool {
	const toolName = `http_${skill.name.replace(/^http:/, "")}`;
	const description = skill.description || `HTTP Skill: ${skill.name}`;

	const properties: Record<string, unknown> = {};

	if (skill.schema && typeof skill.schema === "object" && Object.keys(skill.schema).length > 0) {
		for (const [key, def] of Object.entries(skill.schema)) {
			properties[key] = typeof def === "string" ? { type: "string", description: def } : def;
		}
	} else if (skill.method === "GET") {
		const pathParamMatch = skill.url.match(/\{([^}]+)\}/g);
		if (pathParamMatch) {
			for (const param of pathParamMatch) {
				const name = param.replace(/[{}]/g, "");
				properties[name] = { type: "string", description: `Path parameter: ${name}` };
			}
		}
		try {
			const urlObj = new URL(skill.url);
			for (const [key] of urlObj.searchParams.entries()) {
				if (!properties[key]) {
					properties[key] = { type: "string", description: `Parameter: ${key}` };
				}
			}
		} catch {}
	} else {
		properties.body = { type: "string", description: "JSON body" };
	}

	if (Object.keys(properties).length === 0) {
		properties.id = { type: "string", description: "Resource ID" };
	}

	const parameters: any = {
		type: "object",
		properties,
		additionalProperties: true,
	};

	return {
		name: toolName,
		label: toolName,
		description,
		parameters,
		async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<AgentToolResult<any>> {
			try {
				const result = await executeHttpSkill(skill, params);
				const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				return {
					content: [{ type: "text" as const, text }],
					details: { skill: skill.name },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text" as const, text: `HTTP Skill call failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}

let _cachedHttpTools: AgentTool[] | null = null;

export function getHttpSkillAgentTools(): AgentTool[] {
	if (_cachedHttpTools) {
		return _cachedHttpTools;
	}

	const skills = loadHttpSkills();
	_cachedHttpTools = skills.map((skill) => createHttpSkillAgentTool(skill));
	return _cachedHttpTools;
}

export function refreshHttpSkillTools(): void {
	_cachedHttpTools = null;
	console.log("[HTTP Skills] Agent tools cache refreshed");
}
