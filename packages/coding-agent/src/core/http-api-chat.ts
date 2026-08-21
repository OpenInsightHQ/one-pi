import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve as resolvePath, sep } from "node:path";
import { getSessionsDir } from "../config.js";
import { AuthStorage } from "./auth-storage.js";
import {
	buildUserContextSuffix,
	createDmpSpawnHook,
	createHttpResourceLoader,
	createSkillPathGuard,
	defaultHttpModel,
	getBaseUrl,
	getHttpSkillAgentTools,
	getMimeType,
	getOrCreateAgentOptionsMap,
	getOrCreateAgentSessionMap,
	getUserIdOrReject,
	getUserRootDir,
	getUserSessionDir,
	httpModelConfig,
	parseJsonBody,
	sanitizeId,
	sendError,
	sendJson,
	sendSSE,
} from "./http-api-shared.js";
import { createTaskInMongo, findTasksByConversation, updateTaskStatusInMongo } from "./mongo/task-queue-service.js";
import { type CreateAgentSessionOptions, createAgentSession } from "./sdk.js";
import { findMostRecentSession, SessionManager } from "./session-manager.js";
import { createLibreChatTools } from "./tools/document-generator.js";
import { getCachedMCPTools } from "./tools/mcp-registry.js";
import { createMemoryAgentTools } from "./tools/memory-tools.js";
import { type AggregatedUsage, aggregateUsage } from "./usage-aggregation.js";

interface PromptRequestBody {
	message: string;
	agentId: string;
	sessionId?: string;
	cwd?: string;
	stream?: boolean;
	systemPrompt?: string;
	userMessageId?: string;
	responseMessageId?: string;
	/** Pin the Mongo message-tree mount point for this turn (leaf message id). */
	parentMessageId?: string;
	/**
	 * Caller is executing ONE specific skill (e.g. arp's execute_skill tool).
	 * When true, the session hides the <available_skills> catalog: the
	 * /skill: command is already expanded by pi itself, and letting the
	 * model see other skills invites out-of-scope attempts. The target
	 * skill's own files still load via the /skill: expansion.
	 */
	skillExecution?: boolean;
}

export async function handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
	await handlePromptInternal(req, res, await parseJsonBody<PromptRequestBody>(req));
}

/**
 * POST /execute-agent-skill — run ONE skill as a subagent of an outer
 * (arp/LibreChat) agent's execute_skill tool call.
 *
 * Differences from /prompt:
 * - message is built from skillName + input as "/skill:<name> <input>"
 * - the outer agent's system prompt is passed via systemPrompt (append
 *   mode): pi's base prompt (tool catalog, guidelines) and the DMP context
 *   suffix remain in effect, with the agent prompt appended on top
 * - skillExecution mode: catalog hidden, whole turn hidden from the tree
 */
export async function handleExecuteAgentSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		skillName: string;
		input?: string;
		agentId: string;
		sessionId?: string;
		stream?: boolean;
		userMessageId?: string;
		responseMessageId?: string;
		parentMessageId?: string;
		/** The outer agent's system prompt, appended to pi's base prompt. */
		agentSystemPrompt?: string;
		/** Fallback when no agentSystemPrompt is available. */
		fallbackSystemPrompt?: string;
	}>(req);

	if (!body || !body.skillName || !body.agentId) {
		sendError(res, 400, "Missing skillName or agentId in request body");
		return;
	}

	const promptBody: PromptRequestBody = {
		message: `/skill:${body.skillName}${body.input ? ` ${body.input}` : ""}`,
		agentId: body.agentId,
		sessionId: body.sessionId,
		stream: body.stream ?? true,
		userMessageId: body.userMessageId,
		responseMessageId: body.responseMessageId,
		parentMessageId: body.parentMessageId,
		skillExecution: true,
		systemPrompt: body.agentSystemPrompt || body.fallbackSystemPrompt,
	};

	await handlePromptInternal(req, res, promptBody);
}

async function handlePromptInternal(
	req: IncomingMessage,
	res: ServerResponse,
	body: PromptRequestBody | null,
): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	if (!body || !body.message) {
		sendError(res, 400, "Missing message in request body");
		return;
	}

	if (!body.agentId) {
		sendError(res, 400, "Missing agentId in request body");
		return;
	}

	const agentId = sanitizeId(body.agentId);
	const sessionId = body.sessionId ? sanitizeId(body.sessionId) : randomUUID();
	const sessionDir = getUserSessionDir(userId, agentId, sessionId);
	let cwd: string;
	if (body.cwd) {
		const sessionsRoot = resolvePath(getSessionsDir(), userId);
		const resolvedCwd = resolvePath(body.cwd);
		if (!resolvedCwd.startsWith(sessionsRoot + sep) && resolvedCwd !== sessionsRoot) {
			sendError(res, 403, "cwd must be within the user's session directory");
			return;
		}
		cwd = resolvedCwd;
	} else {
		cwd = sessionDir;
	}
	const streamMode = body.stream ?? false;

	if (!existsSync(cwd)) {
		mkdirSync(cwd, { recursive: true });
	}

	const dmpContext = JSON.stringify({
		"X-User-Id": userId,
		"X-Agent-Id": agentId,
		"X-Conversation-Id": sessionId,
	});
	const dmpContextDir = join(cwd, ".pi");
	if (!existsSync(dmpContextDir)) {
		mkdirSync(dmpContextDir, { recursive: true });
	}
	writeFileSync(join(dmpContextDir, "dmp-context.json"), dmpContext, "utf-8");

	const agentSessions = getOrCreateAgentSessionMap(agentId);
	const agentOptions = getOrCreateAgentOptionsMap(agentId);
	let session = agentSessions.get(sessionId);
	let isNewSession = false;

	console.log(
		`[HTTP] /prompt called, agentId=${agentId}, sessionId=${sessionId}, existingSession=${!!session}, defaultHttpModel=${defaultHttpModel?.provider}/${defaultHttpModel?.id}`,
	);

	// If session is still streaming from a previous request, abort it first.
	// Capped wait: a previous turn stuck in a long-running tool can take
	// minutes to wind down; hanging here makes the new request appear dead
	// (no output, no thinking). After the cap, fail fast so the caller shows
	// an error and the user can retry once the old turn drains.
	if (session?.isStreaming) {
		console.log(`[HTTP] /prompt: session ${sessionId} is still streaming, aborting...`);
		const ABORT_WAIT_MS = 15_000;
		const aborted = await Promise.race([
			session
				.abort()
				.then(() => true)
				.catch((err: unknown) => {
					console.error(`[HTTP] /prompt: error aborting session ${sessionId}:`, err);
					return true;
				}),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ABORT_WAIT_MS)),
		]);
		if (!aborted) {
			console.error(
				`[HTTP] /prompt: previous turn on ${sessionId} still draining after ${ABORT_WAIT_MS}ms, rejecting`,
			);
			sendError(
				res,
				409,
				"Previous request is still finishing on the server (a long-running tool has not stopped yet). Please retry in a moment.",
			);
			return;
		}
		console.log(`[HTTP] /prompt: session ${sessionId} aborted successfully`);
	}

	if (!session) {
		try {
			const libreChatTools = createLibreChatTools(cwd);
			const memoryTools = await createMemoryAgentTools(userId);
			if (memoryTools.length > 0) {
				console.log(`[HTTP] /prompt: added ${memoryTools.length} memory tool(s) for user ${userId}`);
			}
			const allTools = [...libreChatTools, ...getCachedMCPTools(), ...getHttpSkillAgentTools(), ...memoryTools];

			const sessionDir = join(getUserSessionDir(userId, agentId, sessionId), ".pi", "sessions");

			const existingSessionFile = findMostRecentSession(sessionDir);
			let sessionManager: SessionManager;

			if (existingSessionFile) {
				sessionManager = SessionManager.open(existingSessionFile, sessionDir);
				isNewSession = false;
			} else {
				sessionManager = SessionManager.create(cwd, sessionDir);
				isNewSession = true;
			}

			console.log(`[HTTP] Creating session with model: ${defaultHttpModel?.provider}/${defaultHttpModel?.id}`);

			const resourceLoader = await createHttpResourceLoader(userId, cwd, agentId);

			let authStorage: AuthStorage | undefined;
			if (httpModelConfig?.apiKey && defaultHttpModel) {
				authStorage = AuthStorage.create();
				authStorage.setRuntimeApiKey(defaultHttpModel.provider, httpModelConfig.apiKey);
			}

			const options: CreateAgentSessionOptions = {
				cwd,
				sessionManager,
				allowedRoot: getUserRootDir(userId),
				bashToolOptions: { spawnHook: createDmpSpawnHook(userId, agentId, sessionId), sandbox: true },
				customTools: allTools,
				model: defaultHttpModel,
				continueSession: false,
				forceModel: true,
				resourceLoader,
				authStorage,
				skillPathGuard: createSkillPathGuard(userId, agentId),
				conversationPersistence: { userId, agentId, conversationId: sessionId, cwd },
			};
			const result = await createAgentSession(options);
			session = result.session;
			console.log(`[HTTP] Session created with model: ${session.model?.provider}/${session.model?.id}`);
			agentSessions.set(sessionId, session);
			agentOptions.set(sessionId, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			sendError(res, 500, `Failed to create session: ${message}`);
			return;
		}
	}

	let finalMessage: string = "";
	let responseSent = false;
	let collectedUsage: AggregatedUsage | undefined;
	const generatedFiles: {
		name: string;
		path: string;
		type: string;
		mimeType: string;
		size: number;
		url?: string;
	}[] = [];

	if (streamMode) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders();

		sendSSE(res, "session", {
			agentId,
			sessionId,
			cwd: session.sessionManager.getCwd(),
			newSession: isNewSession,
		});
	}

	const unsubscribe = session.subscribe((event) => {
		if (responseSent) {
			return;
		}

		if (streamMode) {
			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent;
				if (
					assistantEvent.type === "thinking_start" ||
					assistantEvent.type === "thinking_delta" ||
					assistantEvent.type === "thinking_end"
				) {
					emit("thinking", {
						type: assistantEvent.type,
						contentIndex: "contentIndex" in assistantEvent ? assistantEvent.contentIndex : undefined,
						delta: "delta" in assistantEvent ? assistantEvent.delta : undefined,
						content: "content" in assistantEvent ? assistantEvent.content : undefined,
					});
				} else if (
					assistantEvent.type === "text_start" ||
					assistantEvent.type === "text_delta" ||
					assistantEvent.type === "text_end"
				) {
					emit("text", {
						type: assistantEvent.type,
						contentIndex: "contentIndex" in assistantEvent ? assistantEvent.contentIndex : undefined,
						delta: "delta" in assistantEvent ? assistantEvent.delta : undefined,
						content: "content" in assistantEvent ? assistantEvent.content : undefined,
					});
				}
			} else if (event.type === "tool_execution_start") {
				emit("tool_start", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
			} else if (event.type === "tool_execution_update") {
				emit("tool_update", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
				});
			} else if (event.type === "tool_execution_end") {
				emit("tool_end", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				});
			}
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message;
			const textContent = msg.content.find((c) => c.type === "text");
			finalMessage = textContent?.text ?? "";
			if (msg.usage) {
				collectedUsage = aggregateUsage(collectedUsage, {
					input: msg.usage.input || 0,
					output: msg.usage.output || 0,
					cacheRead: msg.usage.cacheRead || 0,
					cacheWrite: msg.usage.cacheWrite || 0,
				});
			}
			if (msg.stopReason === "error" && msg.errorMessage) {
				responseSent = true;
				if (streamMode) {
					emit("error", { message: msg.errorMessage });
					if (!res.writableEnded) res.end();
				} else {
					sendError(res, 500, msg.errorMessage);
				}
				return;
			}
		}

		if (event.type === "turn_end") {
			for (const toolResult of event.toolResults ?? []) {
				const details = (toolResult as any).details;
				if (details?.localFiles && Array.isArray(details.localFiles)) {
					for (const file of details.localFiles) {
						const fileName = file.name;
						const localPath = file.localPath;
						if (existsSync(localPath)) {
							const stats = require("node:fs").statSync(localPath);
							generatedFiles.push({
								name: fileName,
								path: localPath,
								type: "code",
								mimeType: getMimeType(fileName),
								size: stats.size,
								url: `${getBaseUrl()}/files/download?agentId=${agentId}&sessionId=${sessionId}&filename=${encodeURIComponent(fileName)}`,
							});
						}
					}
				}
			}
		}
	});

	// Per-user context (available prompts + long-term memory) appended to the
	// system prompt. Migrated from arp's pi.system prompt composition; fetched
	// fresh each turn so mid-conversation memory changes appear immediately.
	// Skipped in skill-execution mode: the turn runs as a subagent of an outer
	// agent, isolated from the user's personal prompt/memory context.
	const userContextSuffix = body.skillExecution === true ? "" : await buildUserContextSuffix(userId);

	const dmpSystemSuffix = `${userContextSuffix}${userContextSuffix ? "\n" : ""}\n[DMP Context]\nX-User-Id: ${userId}\nX-Agent-Id: ${agentId}\nX-Conversation-Id: ${sessionId}\nWhen calling any dmp- skill script via python, always pass these as CLI arguments: --X-User-Id "${userId}" --X-Agent-Id "${agentId}" --X-Conversation-Id "${sessionId}"`;

	session.setMessageIds(body.userMessageId, body.responseMessageId, body.parentMessageId);

	// Skill-execution mode: hide the <available_skills> catalog for this turn
	// so the model can't see or attempt skills other than the one being
	// executed (the /skill: command content itself is injected by pi).
	// Also hide the whole turn's messages from the visible tree: pi runs as a
	// subagent of the caller's execute_skill tool - its transcript stays in
	// pi's context but the caller's tool result carries the user-facing
	// summary, so standalone pi messages would duplicate/fork the tree.
	if (body.skillExecution === true) {
		session.setSkillCatalogHidden(true);
		session.setTurnHidden(true);
	} else {
		session.setSkillCatalogHidden(false);
		session.setTurnHidden(false);
	}

	// Active task snapshot: lets the model act on conversational cancel/stop
	// requests without an extra list_tasks round-trip. Interactive
	// (human-pending) tasks no longer exist - user decisions happen in
	// conversation - so this list is execution-tracking only.
	let taskPrefix = "";
	const activeTasks = (await findTasksByConversation(sessionId)).filter(
		(t) => !["completed", "rejected", "dismissed", "failed", "aborted"].includes(String(t.status)),
	);
	if (activeTasks.length > 0) {
		const lines = activeTasks.map(
			(t) => `- id=${t._id} status=${t.status} type=${t.type ?? "subagent"} title="${t.title}"`,
		);
		taskPrefix += `<active_tasks>\n${lines.join("\n")}\n</active_tasks>\n(If the user asks to cancel one of these, use the cancel_task tool with its id.)\n\n`;
	}

	// Skill-execution task tracking. /skill: turns (typically dispatched by
	// arp's execute_skill tool) commonly run for minutes. Track them in the
	// task panel so the user sees live status even when the caller stops
	// reading the stream (pi keeps running: /prompt has no disconnect abort).
	const isSkillTurn = body.message.trim().startsWith("/skill:");
	let skillTaskId: string | null = null;
	if (isSkillTurn) {
		const skillName = /^\/skill:([^\s]+)/.exec(body.message.trim())?.[1] ?? "skill";
		const skillTask = await createTaskInMongo({
			toUserId: userId,
			fromUserId: userId,
			fromAgentId: agentId,
			type: "subagent",
			title: `[skill] ${skillName}`,
			status: "running",
			sourceConversationId: sessionId,
			subagentName: skillName,
		});
		skillTaskId = skillTask ? String(skillTask._id) : null;
		if (skillTaskId) {
			console.log(`[HTTP] /prompt: skill execution tracked as task ${skillTaskId}`);
		}
	}

	// SSE write guard: after the caller disconnects (e.g. arp abandons a slow
	// skill stream), writes fail silently but waste cycles - and must never
	// throw into the event callback. The backend keeps executing regardless.
	const emit = (event: string, data: unknown): void => {
		if (res.destroyed || res.writableEnded) return;
		sendSSE(res, event, data);
	};

	try {
		await session.prompt(taskPrefix + body.message, {
			appendSystemPrompt: (body.systemPrompt ?? "") + dmpSystemSuffix,
		});

		if (skillTaskId) {
			updateTaskStatusInMongo(skillTaskId, "completed", finalMessage.slice(0, 300) || "skill finished").catch(
				() => {},
			);
		}

		await new Promise<void>((resolve) => {
			const checkDone = (): void => {
				setTimeout(() => {
					if (session!.agent.state.pendingToolCalls.size === 0) {
						resolve();
					} else {
						checkDone();
					}
				}, 100);
			};
			checkDone();
		});

		if (!responseSent) {
			if (streamMode) {
				if (collectedUsage) {
					emit("usage", collectedUsage);
				}
				emit("done", {
					message: finalMessage,
					generatedFiles,
				});
				if (!res.writableEnded) res.end();
			} else {
				sendJson(res, 200, {
					message: finalMessage,
					agentId,
					sessionId,
					cwd: session.sessionManager.getCwd(),
					newSession: isNewSession,
				});
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		if (skillTaskId) {
			updateTaskStatusInMongo(skillTaskId, "failed", message.slice(0, 300)).catch(() => {});
		}
		if (responseSent) {
			return;
		}
		if (streamMode) {
			emit("error", { message });
			if (!res.writableEnded) res.end();
		} else {
			sendError(res, 500, `Prompt execution failed: ${message}`);
		}
	} finally {
		unsubscribe();
	}
}

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const agentId = req.headers["x-agent-id"];
	if (!agentId || typeof agentId !== "string") {
		sendError(res, 400, "Missing X-Agent-Id header");
		return;
	}

	const sessionIdHeader = req.headers["x-session-id"];
	const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : randomUUID();

	const body = await parseJsonBody<{
		messages: Array<{ role: string; content?: string }>;
		model?: string;
		stream?: boolean;
	}>(req);

	if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
		sendError(res, 400, "Missing or empty messages in request body");
		return;
	}

	let systemPrompt: string | undefined;
	let userMessage: string | undefined;

	for (const msg of body.messages) {
		if (msg.role === "system" && msg.content) {
			systemPrompt = msg.content;
		}
	}

	for (let i = body.messages.length - 1; i >= 0; i--) {
		if (body.messages[i].role === "user" && body.messages[i].content) {
			userMessage = body.messages[i].content;
			break;
		}
	}

	if (!userMessage) {
		sendError(res, 400, "No user message found in messages");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	const streamMode = body.stream ?? false;

	if (!existsSync(cwd)) {
		mkdirSync(cwd, { recursive: true });
	}

	const agentSessions = getOrCreateAgentSessionMap(agentId);
	const agentOptions = getOrCreateAgentOptionsMap(agentId);
	let session = agentSessions.get(sessionId);

	console.log(`[HTTP] /v1/chat/completions called, sessionId=${sessionId}, existingSession=${!!session}`);

	if (!session) {
		try {
			const libreChatTools = createLibreChatTools(cwd);
			const memoryTools = await createMemoryAgentTools(userId);
			if (memoryTools.length > 0) {
				console.log(`[HTTP] /v1/chat/completions: added ${memoryTools.length} memory tool(s) for user ${userId}`);
			}
			const allTools = [...libreChatTools, ...getCachedMCPTools(), ...getHttpSkillAgentTools(), ...memoryTools];
			const sessionDir = join(getUserSessionDir(userId, agentId, sessionId), ".pi", "sessions");
			const existingSessionFile = findMostRecentSession(sessionDir);
			let sessionManager: SessionManager;

			if (existingSessionFile) {
				sessionManager = SessionManager.open(existingSessionFile, sessionDir);
			} else {
				sessionManager = SessionManager.create(cwd, sessionDir);
			}

			const resourceLoader = await createHttpResourceLoader(userId, cwd, agentId);

			let authStorage: AuthStorage | undefined;
			if (httpModelConfig?.apiKey && defaultHttpModel) {
				authStorage = AuthStorage.create();
				authStorage.setRuntimeApiKey(defaultHttpModel.provider, httpModelConfig.apiKey);
			}

			const options: CreateAgentSessionOptions = {
				cwd,
				sessionManager,
				allowedRoot: getUserRootDir(userId),
				bashToolOptions: { spawnHook: createDmpSpawnHook(userId, agentId, sessionId), sandbox: true },
				customTools: allTools,
				model: defaultHttpModel,
				continueSession: false,
				forceModel: true,
				resourceLoader,
				authStorage,
				skillPathGuard: createSkillPathGuard(userId, agentId),
				conversationPersistence: { userId, agentId, conversationId: sessionId, cwd },
			};

			const result = await createAgentSession(options);
			session = result.session;
			agentSessions.set(sessionId, session);
			agentOptions.set(sessionId, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			sendError(res, 500, `Failed to create session: ${message}`);
			return;
		}
	}

	const chatCompletionId = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const modelName = session.model?.id ?? body.model ?? "unknown";
	let responseSent = false;
	let collectedText = "";
	let collectedThinking = "";
	const collectedToolCalls: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}> = [];
	let collectedFinishReason: string = "stop";
	let collectedUsage: { input: number; output: number; totalTokens: number } | undefined;
	const toolCallIndexMap = new Map<string, number>();
	let nextToolCallIndex = 0;

	function sendOpenAIChunk(delta: Record<string, unknown>, finishReason: string | null): void {
		res.write(
			`data: ${JSON.stringify({
				id: chatCompletionId,
				object: "chat.completion.chunk",
				created,
				model: modelName,
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`,
		);
		if (typeof (res as any).flush === "function") {
			(res as any).flush();
		}
	}

	if (streamMode) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders();

		sendOpenAIChunk({ role: "assistant", content: null }, null);
	}

	const unsubscribe = session.subscribe((event) => {
		if (responseSent) return;

		if (streamMode && event.type === "message_update") {
			const ae = event.assistantMessageEvent;

			if (ae.type === "thinking_delta") {
				sendOpenAIChunk({ reasoning_content: ae.delta }, null);
			} else if (ae.type === "text_delta") {
				sendOpenAIChunk({ content: ae.delta }, null);
			} else if (ae.type === "toolcall_start") {
				const tc = ae.partial.content[ae.contentIndex];
				if (tc && tc.type === "toolCall") {
					const idx = nextToolCallIndex++;
					toolCallIndexMap.set(tc.id, idx);
					sendOpenAIChunk(
						{
							tool_calls: [
								{
									index: idx,
									id: tc.id,
									type: "function",
									function: { name: tc.name, arguments: "" },
								},
							],
						},
						null,
					);
				}
			} else if (ae.type === "toolcall_delta") {
				const tc = ae.partial.content[ae.contentIndex];
				if (tc && tc.type === "toolCall") {
					const idx = toolCallIndexMap.get(tc.id) ?? 0;
					sendOpenAIChunk(
						{
							tool_calls: [{ index: idx, function: { arguments: ae.delta } }],
						},
						null,
					);
				}
			}
		} else if (!streamMode && event.type === "message_update") {
			const ae = event.assistantMessageEvent;

			if (ae.type === "thinking_delta") {
				collectedThinking += ae.delta;
			} else if (ae.type === "text_delta") {
				collectedText += ae.delta;
			}
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message;
			for (const c of msg.content) {
				if (c.type === "text") {
					collectedText += c.text;
				} else if (c.type === "thinking") {
					collectedThinking += c.thinking;
				} else if (c.type === "toolCall") {
					collectedToolCalls.push({
						id: c.id,
						type: "function",
						function: {
							name: c.name,
							arguments: JSON.stringify(c.arguments),
						},
					});
				}
			}
			collectedFinishReason = msg.stopReason === "toolUse" ? "tool_calls" : "stop";
			collectedUsage = msg.usage;
			if (msg.stopReason === "error" && msg.errorMessage) {
				responseSent = true;
				if (streamMode) {
					sendOpenAIChunk({ content: msg.errorMessage }, "stop");
					res.write("data: [DONE]\n\n");
					res.end();
				} else {
					sendError(res, 500, msg.errorMessage);
				}
			}
		}
	});

	// Per-user context (available prompts + long-term memory), see /prompt.
	const chatUserContextSuffix = await buildUserContextSuffix(userId);
	const chatDmpSuffix = `${chatUserContextSuffix}${chatUserContextSuffix ? "\n" : ""}\n[DMP Context]\nX-User-Id: ${userId}\nX-Agent-Id: ${agentId}\nX-Conversation-Id: ${sessionId}\nWhen calling any dmp- skill script via python, always pass these as CLI arguments: --X-User-Id "${userId}" --X-Agent-Id "${agentId}" --X-Conversation-Id "${sessionId}"`;

	try {
		await session.prompt(userMessage, {
			appendSystemPrompt: (systemPrompt ?? "") + chatDmpSuffix,
		});

		await new Promise<void>((resolve) => {
			const checkDone = (): void => {
				setTimeout(() => {
					if (session!.agent.state.pendingToolCalls.size === 0) {
						resolve();
					} else {
						checkDone();
					}
				}, 100);
			};
			checkDone();
		});

		if (!responseSent) {
			if (streamMode) {
				sendOpenAIChunk({}, "stop");
				res.write("data: [DONE]\n\n");
				res.end();
			} else {
				const message: Record<string, unknown> = {
					role: "assistant",
					content: collectedText || null,
				};

				if (collectedThinking) {
					message.reasoning_content = collectedThinking;
				}

				if (collectedToolCalls.length > 0) {
					message.tool_calls = collectedToolCalls;
				}

				sendJson(res, 200, {
					id: chatCompletionId,
					object: "chat.completion",
					created,
					model: modelName,
					choices: [
						{
							index: 0,
							message,
							finish_reason: collectedFinishReason,
						},
					],
					usage: collectedUsage
						? {
								prompt_tokens: collectedUsage.input,
								completion_tokens: collectedUsage.output,
								total_tokens: collectedUsage.totalTokens,
							}
						: {
								prompt_tokens: 0,
								completion_tokens: 0,
								total_tokens: 0,
							},
				});
			}
		}
	} catch (error) {
		if (responseSent) return;
		const message = error instanceof Error ? error.message : "Unknown error";
		if (streamMode) {
			sendOpenAIChunk({ content: message }, "stop");
			res.write("data: [DONE]\n\n");
			res.end();
		} else {
			sendError(res, 500, `Chat completion failed: ${message}`);
		}
	} finally {
		unsubscribe();
	}
}
