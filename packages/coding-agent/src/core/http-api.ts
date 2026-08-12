import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getAgentDir, getPromptsDir } from "../config.js";
import type { AgentSession } from "./agent-session.js";
import { handleChatCompletions, handlePrompt } from "./http-api-chat.js";
import {
	handleFilesBatchDelete,
	handleFilesBatchDownload,
	handleFilesDelete,
	handleFilesDetails,
	handleFilesDownload,
	handleFilesList,
	handleFilesMkdir,
	handleFilesMove,
	handleFilesRename,
	handleFilesSearch,
	handleFilesUnzip,
	handleFilesUploadChunk,
	handleFilesUploadComplete,
	handleFilesUploadInit,
	handleUpload,
} from "./http-api-file.js";
import {
	authenticate,
	buildModelFromConfig,
	defaultHttpModel,
	getUserIdOrReject,
	type HttpModelConfig,
	type HttpServerOptions,
	loadHttpModelConfig,
	parseJsonBody,
	SKILL_REPO_BASE_DIR,
	saveHttpModelConfig,
	sendError,
	sendJson,
	sessionStore,
	setDefaultHttpModel,
	setHttpModelConfig,
	setUploadLimits,
	uploadLimits,
} from "./http-api-shared.js";
import {
	handleHttpSkills,
	handleMCPServers,
	handleMCPTools,
	handleMySkillDelete,
	handleMySkillDownload,
	handleMySkills,
	handleMySkillUpload,
	handleSkillDetail,
	handleSkillDownload,
	handleSkillExecute,
	handleSkills,
	handleSkillsAuthorize,
	handleSkillsDelete,
	handleSkillsExecute,
	handleSkillsFromHttpApis,
	handleSkillsFromMcp,
	handleSkillsRegisterMcp,
	handleSkillsUpload,
} from "./http-api-skill.js";
import { connectMongo } from "./mongo/index.js";
import { addAllowedReadPrefix } from "./tools/path-utils.js";

export { handleChatCompletions, handlePrompt } from "./http-api-chat.js";
export {
	handleFilesBatchDelete,
	handleFilesBatchDownload,
	handleFilesDelete,
	handleFilesDetails,
	handleFilesDownload,
	handleFilesList,
	handleFilesMkdir,
	handleFilesMove,
	handleFilesRename,
	handleFilesSearch,
	handleFilesUnzip,
	handleFilesUploadChunk,
	handleFilesUploadComplete,
	handleFilesUploadInit,
	handleUpload,
} from "./http-api-file.js";
export {
	type ChunkInfo,
	cleanExpiredUploadSessions,
	createDmpSpawnHook,
	createHttpResourceLoader,
	defaultHttpModel,
	defaultUploadLimits,
	getBaseUrl,
	getHttpSkillAgentTools,
	getMimeType,
	getOrCreateAgentOptionsMap,
	getOrCreateAgentSessionMap,
	getSkillRepoDir,
	getUserIdOrReject,
	getUserSessionDir,
	type HttpModelConfig,
	type HttpServerOptions,
	type HttpSkill,
	httpModelConfig,
	loadHttpSkills,
	parseJsonBody,
	refreshHttpSkillTools,
	removeLinkOrDir,
	type SessionStore,
	SKILL_REPO_BASE_DIR,
	saveHttpSkills,
	sendError,
	sendJson,
	sendSSE,
	sessionStore,
	type UploadLimits,
	type UploadSession,
	uploadLimits,
	uploadSessions,
	validateFileSize,
	validateFileType,
} from "./http-api-shared.js";
export {
	type CreateSkillFromHttpApisRequest,
	handleHttpSkills,
	handleMCPServers,
	handleMCPTools,
	handleSkillDetail,
	handleSkillExecute,
	handleSkills,
	handleSkillsAuthorize,
	handleSkillsDelete,
	handleSkillsExecute,
	handleSkillsFromHttpApis,
	handleSkillsFromMcp,
	handleSkillsRegisterMcp,
	handleSkillsUpload,
} from "./http-api-skill.js";

let httpServerInstance: ReturnType<typeof createServer> | undefined;

export function createHttpApiServer(
	_session: AgentSession,
	_resourceLoader: any,
	_options: HttpServerOptions = {},
): ReturnType<typeof createServer> {
	const server = createServer(async (req, res) => {
		try {
			await handleRequest(req, res);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal server error";
			console.error("[HTTP] Request handler error:", error);
			sendError(res, 500, message);
		}
	});

	// Allow long-running operations (e.g. large zip extraction) to exceed Node's 5min default.
	// Override via PI_REQUEST_TIMEOUT_MS env var (milliseconds).
	const requestTimeoutMs = parseInt(process.env.PI_REQUEST_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);
	server.requestTimeout = requestTimeoutMs;
	server.timeout = requestTimeoutMs;

	return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const pathname = url.pathname;

	if (!authenticate(req)) {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Unauthorized" }));
		return;
	}

	if (pathname === "/health") {
		sendJson(res, 200, { status: "ok" });
		return;
	}

	if (pathname === "/model" && req.method === "GET") {
		if (!defaultHttpModel) {
			sendJson(res, 200, { provider: "", model: "" });
		} else {
			sendJson(res, 200, {
				provider: defaultHttpModel.provider,
				model: defaultHttpModel.id,
				contextWindow: defaultHttpModel.contextWindow,
				maxTokens: defaultHttpModel.maxTokens,
			});
		}
		return;
	}

	if (pathname === "/model" && req.method === "PUT") {
		const body = await parseJsonBody<HttpModelConfig>(req);
		if (!body || !body.provider || !body.model) {
			sendError(res, 400, "Missing provider or model in request body");
			return;
		}
		if (!body.apiKey) {
			sendError(res, 400, "Missing apiKey in request body");
			return;
		}
		if (
			(body.contextWindow !== undefined && (!Number.isFinite(body.contextWindow) || body.contextWindow <= 0)) ||
			(body.maxTokens !== undefined && (!Number.isFinite(body.maxTokens) || body.maxTokens <= 0))
		) {
			sendError(res, 400, "contextWindow and maxTokens must be positive numbers");
			return;
		}

		const newModel = buildModelFromConfig(body, defaultHttpModel?.baseUrl);

		setDefaultHttpModel(newModel);
		setHttpModelConfig(body);
		saveHttpModelConfig(body);

		for (const [, agentSessions] of sessionStore.sessions.entries()) {
			for (const [, session] of agentSessions.entries()) {
				try {
					session.modelRegistry.authStorage.setRuntimeApiKey(body.provider, body.apiKey);
					session.agent.setModel(newModel);
				} catch (error) {
					console.error(
						`[HTTP] Failed to update model for session: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
			}
		}

		console.log(
			`[HTTP] Model updated: ${body.provider}/${body.model}, api=${newModel.api}, baseUrl=${newModel.baseUrl}, contextWindow=${newModel.contextWindow}, maxTokens=${newModel.maxTokens}`,
		);
		sendJson(res, 200, {
			success: true,
			provider: body.provider,
			model: body.model,
			api: newModel.api,
			baseUrl: newModel.baseUrl,
			contextWindow: newModel.contextWindow,
			maxTokens: newModel.maxTokens,
		});
		return;
	}

	if (pathname === "/mcp/servers") {
		await handleMCPServers(req, res);
		return;
	}

	if (pathname === "/mcp/tools") {
		await handleMCPTools(req, res);
		return;
	}

	if (pathname === "/http-skills") {
		await handleHttpSkills(req, res);
		return;
	}

	if (pathname === "/skills/register-mcp") {
		await handleSkillsRegisterMcp(req, res);
		return;
	}

	if (pathname === "/skills" && req.method === "GET") {
		await handleSkills(req, res);
		return;
	}

	if (pathname === "/skills/my" && req.method === "GET") {
		await handleMySkills(req, res);
		return;
	}

	if (pathname === "/skills/my/upload" && req.method === "POST") {
		await handleMySkillUpload(req, res);
		return;
	}

	const mySkillMatch = pathname.match(/^\/skills\/my\/([^/]+)$/);
	if (mySkillMatch) {
		const skillName = decodeURIComponent(mySkillMatch[1]);
		if (req.method === "GET") {
			await handleMySkillDownload(req, res, skillName);
			return;
		}
		if (req.method === "DELETE") {
			await handleMySkillDelete(req, res, skillName);
			return;
		}
	}

	const skillDownloadMatch = pathname.match(/^\/skills\/download\/([^/]+)\/([^/]+)$/);
	if (skillDownloadMatch && req.method === "GET") {
		const category = decodeURIComponent(skillDownloadMatch[1]);
		const skillName = decodeURIComponent(skillDownloadMatch[2]);
		await handleSkillDownload(req, res, category, skillName);
		return;
	}

	const skillDetailMatch = pathname.match(/^\/skills\/([^/]+)$/);
	if (skillDetailMatch && req.method === "GET") {
		await handleSkillDetail(req, res, decodeURIComponent(skillDetailMatch[1]));
		return;
	}

	if (pathname === "/skills/execute" && req.method === "POST") {
		await handleSkillsExecute(req, res);
		return;
	}

	const skillExecMatch = pathname.match(/^\/skills\/([^/]+)\/execute$/);
	if (skillExecMatch && req.method === "POST") {
		await handleSkillExecute(req, res, decodeURIComponent(skillExecMatch[1]));
		return;
	}

	if (pathname === "/skills/delete" && req.method === "POST") {
		await handleSkillsDelete(req, res);
		return;
	}

	if (pathname === "/skills/upload" && req.method === "POST") {
		await handleSkillsUpload(req, res);
		return;
	}

	if (pathname === "/skills/authorize") {
		await handleSkillsAuthorize(req, res);
		return;
	}

	if (pathname === "/skills/from-http-apis" && req.method === "POST") {
		await handleSkillsFromHttpApis(req, res);
		return;
	}

	if (pathname === "/skills/from-mcp" && req.method === "POST") {
		await handleSkillsFromMcp(req, res);
		return;
	}

	if (pathname === "/prompt" && req.method === "POST") {
		await handlePrompt(req, res);
		return;
	}

	if (pathname === "/abort" && req.method === "POST") {
		const userId = getUserIdOrReject(req, res);
		if (!userId) return;

		const body = await parseJsonBody<{ sessionId?: string; agentId?: string }>(req);
		if (!body?.sessionId) {
			sendError(res, 400, "Missing sessionId in request body");
			return;
		}

		const targetAgentId = body.agentId;
		let found = false;
		let wasStreaming = false;

		for (const [agentId, agentSessions] of sessionStore.sessions.entries()) {
			if (targetAgentId && agentId !== targetAgentId) continue;
			const session = agentSessions.get(body.sessionId);
			if (session) {
				found = true;
				if (session.isStreaming) {
					wasStreaming = true;
					try {
						await session.abort();
						console.log(`[HTTP] /abort: session ${body.sessionId} aborted successfully`);
					} catch (err: unknown) {
						console.error(`[HTTP] /abort: error aborting session ${body.sessionId}:`, err);
					}
				}
				break;
			}
		}

		if (!found) {
			sendError(res, 404, `Session not found: ${body.sessionId}`);
			return;
		}

		sendJson(res, 200, { success: true, sessionId: body.sessionId, wasStreaming });
		return;
	}

	if (pathname === "/v1/chat/completions" && req.method === "POST") {
		await handleChatCompletions(req, res);
		return;
	}

	if (pathname === "/sessions" && req.method === "GET") {
		const sessions: { agentId: string; sessionId: string; cwd: string }[] = [];
		for (const [agentId, agentSessions] of sessionStore.sessions.entries()) {
			for (const [sessionId, session] of agentSessions.entries()) {
				sessions.push({ agentId, sessionId, cwd: session.sessionManager.getCwd() });
			}
		}
		sendJson(res, 200, { sessions });
		return;
	}

	if (pathname.startsWith("/sessions/") && req.method === "DELETE") {
		const pathParts = pathname.slice("/sessions/".length).split("/");
		const agentId = pathParts[0];
		const sessionId = pathParts[1];
		if (agentId && sessionId) {
			const agentSessions = sessionStore.sessions.get(agentId);
			if (agentSessions?.has(sessionId)) {
				agentSessions.delete(sessionId);
				const agentOptions = sessionStore.options.get(agentId);
				agentOptions?.delete(sessionId);
				sendJson(res, 200, { success: true });
			} else {
				sendError(res, 404, `Session not found: ${agentId}/${sessionId}`);
			}
		} else if (agentId) {
			if (sessionStore.sessions.has(agentId)) {
				sessionStore.sessions.delete(agentId);
				sessionStore.options.delete(agentId);
				sendJson(res, 200, { success: true });
			} else {
				sendError(res, 404, `Agent not found: ${agentId}`);
			}
		} else {
			sendError(res, 400, "Invalid path");
		}
		return;
	}

	if (pathname === "/upload" && req.method === "POST") {
		await handleUpload(req, res);
		return;
	}

	if (pathname === "/files" && req.method === "GET") {
		await handleFilesList(req, res);
		return;
	}

	if (pathname === "/files" && req.method === "DELETE") {
		await handleFilesDelete(req, res);
		return;
	}

	if (pathname === "/files/download" && req.method === "GET") {
		await handleFilesDownload(req, res);
		return;
	}

	if (pathname === "/files/unzip" && req.method === "POST") {
		await handleFilesUnzip(req, res);
		return;
	}

	if (pathname === "/files/batch-delete" && req.method === "POST") {
		await handleFilesBatchDelete(req, res);
		return;
	}

	if (pathname === "/files/batch-download" && req.method === "POST") {
		await handleFilesBatchDownload(req, res);
		return;
	}

	if (pathname === "/files/mkdir" && req.method === "POST") {
		await handleFilesMkdir(req, res);
		return;
	}

	if (pathname === "/files/rename" && req.method === "POST") {
		await handleFilesRename(req, res);
		return;
	}

	if (pathname === "/files/move" && req.method === "POST") {
		await handleFilesMove(req, res);
		return;
	}

	if (pathname === "/files/details" && req.method === "GET") {
		await handleFilesDetails(req, res);
		return;
	}

	if (pathname === "/files/search" && req.method === "GET") {
		await handleFilesSearch(req, res);
		return;
	}

	if (pathname === "/files/upload/init" && req.method === "POST") {
		await handleFilesUploadInit(req, res);
		return;
	}

	if (pathname === "/files/upload/chunk" && req.method === "POST") {
		await handleFilesUploadChunk(req, res);
		return;
	}

	if (pathname === "/files/upload/complete" && req.method === "POST") {
		await handleFilesUploadComplete(req, res);
		return;
	}

	if (pathname === "/prompts" && req.method === "GET") {
		const promptsDir = getPromptsDir();
		if (!existsSync(promptsDir)) {
			sendJson(res, 200, { prompts: [] });
			return;
		}
		const files = readdirSync(promptsDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""));
		sendJson(res, 200, { prompts: files });
		return;
	}

	if (pathname === "/prompts" && req.method === "POST") {
		const body = await parseJsonBody<{ key: string; content: string }>(req);
		if (!body || !body.key || !body.content) {
			sendError(res, 400, "Missing key or content in request body");
			return;
		}
		const key = body.key.replace(/[^a-zA-Z0-9_.-]/g, "_");
		const promptsDir = getPromptsDir();
		if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true });
		const filePath = join(promptsDir, `${key}.md`);
		writeFileSync(filePath, body.content, "utf-8");
		sendJson(res, 200, { success: true, key, path: filePath });
		return;
	}

	if (pathname === "/prompts" && req.method === "DELETE") {
		const body = await parseJsonBody<{ key: string }>(req);
		if (!body || !body.key) {
			sendError(res, 400, "Missing key in request body");
			return;
		}
		const key = body.key.replace(/[^a-zA-Z0-9_.-]/g, "_");
		const promptsDir = getPromptsDir();
		const filePath = join(promptsDir, `${key}.md`);
		if (!existsSync(filePath)) {
			sendError(res, 404, `Prompt not found: ${key}`);
			return;
		}
		try {
			unlinkSync(filePath);
			sendJson(res, 200, { success: true, key, deleted: filePath });
		} catch (error) {
			sendError(res, 500, `Failed to delete prompt: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
		return;
	}

	sendError(res, 404, "Not found");
}

export async function startHttpServer(
	_session: AgentSession,
	_resourceLoader: any,
	options: HttpServerOptions = {},
): Promise<ReturnType<typeof createServer>> {
	if (httpServerInstance) {
		throw new Error("HTTP server already running");
	}

	if (!process.env.PI_BASH_SANDBOX) {
		process.env.PI_BASH_SANDBOX = "1";
	}

	// Connect to MongoDB (for authorized skills + ACL permission checks).
	// Non-fatal: server starts regardless; authorized skills are simply unavailable on failure.
	await connectMongo();

	if (options.uploadLimits) {
		setUploadLimits(options.uploadLimits);
	}

	setDefaultHttpModel(_session.model);

	const savedConfig = loadHttpModelConfig();
	if (savedConfig) {
		const restoredModel = buildModelFromConfig(savedConfig, _session.model?.baseUrl);
		setDefaultHttpModel(restoredModel);
		setHttpModelConfig(savedConfig);
		console.log(
			`[HTTP] Restored saved model: ${savedConfig.provider}/${savedConfig.model}, api=${restoredModel.api}, baseUrl=${restoredModel.baseUrl}`,
		);
	}

	const server = createHttpApiServer(_session, _resourceLoader, options);
	httpServerInstance = server;

	return new Promise((resolve, reject) => {
		server.on("error", (err) => {
			console.error("HTTP server error:", err);
			reject(err);
		});

		server.listen(options.port ?? 3000, options.host ?? "0.0.0.0", () => {
			addAllowedReadPrefix(SKILL_REPO_BASE_DIR);
			addAllowedReadPrefix(join(getAgentDir(), "skills"));
			addAllowedReadPrefix(getPromptsDir());
			console.log(`HTTP API server running on http://${options.host ?? "0.0.0.0"}:${options.port ?? 3000}`);
			console.log(`[HTTP] Skill Repo: ${SKILL_REPO_BASE_DIR} (exists=${existsSync(SKILL_REPO_BASE_DIR)})`);
			if (!existsSync(SKILL_REPO_BASE_DIR)) {
				console.warn(`[HTTP] WARNING: Skill repo directory does not exist: ${SKILL_REPO_BASE_DIR}`);
			}
			if (uploadLimits.maxFileSize < Number.MAX_SAFE_INTEGER) {
				console.log(
					`[HTTP] Upload limits: maxFileSize=${uploadLimits.maxFileSize}, allowedTypes=${uploadLimits.allowedTypes.length > 0 ? uploadLimits.allowedTypes.join(", ") : "all"}`,
				);
			}
			console.log("Endpoints:");
			console.log("  GET    /health           - Health check");
			console.log("  GET    /model            - Get current model");
			console.log("  PUT    /model            - Set model");
			console.log("  GET    /sessions          - List sessions");
			console.log("  DELETE /sessions/:id      - Delete session");
			console.log("  POST   /prompt            - Prompt agent");
			console.log("  POST   /v1/chat/completions - Chat completions");
			console.log("  POST   /upload            - Upload file");
			console.log("  GET    /files             - List files");
			console.log("  ...and more skill/MCP/file endpoints");
			resolve(server);
		});
	});
}
