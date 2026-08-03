import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve as resolvePath, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getAgentDir, getSessionsDir } from "../config.js";
import type { AgentSession } from "./agent-session.js";
import type { ResourceLoader } from "./resource-loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import type { CreateAgentSessionOptions } from "./sdk.js";

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
		contextWindow: 128000,
		maxTokens: 16384,
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

export async function createHttpResourceLoader(userId: string, cwd: string): Promise<ResourceLoader> {
	const agentDir = getAgentDir();
	const additionalSkillPaths: string[] = [];
	const userSkillsDir = join(getSessionsDir(), userId, "skills");
	if (existsSync(userSkillsDir)) {
		additionalSkillPaths.push(userSkillsDir);
	}
	const loader = new DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths });
	await loader.reload();
	return loader;
}

export function getBaseUrl(): string {
	const httpHost = "0.0.0.0";
	const httpPort = 3000;
	return `http://${httpHost}:${httpPort}`;
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
