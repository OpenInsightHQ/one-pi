/**
 * Conversation and message persistence service.
 *
 * Stores pi's conversation history (user messages, assistant responses, tool
 * results) in the same MongoDB `conversations` and `messages` collections used
 * by arp/LibreChat. This replaces the JSONL-only persistence with MongoDB as
 * the primary data store.
 *
 * Each message document stores both arp-compatible fields (for LibreChat UI
 * compatibility) and a full `agentMessage` field (for pi context
 * reconstruction on reload).
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	AssistantMessage,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@mariozechner/pi-ai";
import { estimateTokens } from "../compaction/compaction.js";
import type { UsageTotals } from "../usage-aggregation.js";
import { isMongoEnabled } from "./db.js";
import { getConversationModel, getMessageModel } from "./models.js";

const PI_ENDPOINT = "pi";
const PI_MODEL = "one-pi";
const PI_CONVO_AGENT_ID = "pi__one-pi___one-pi";
const PI_MAX_RECURSION = 50;
const NO_PARENT = "00000000-0000-0000-0000-000000000000";

export { NO_PARENT };

export interface ConversationPersistenceContext {
	userId: string;
	agentId: string;
	conversationId: string;
	cwd: string;
}

function generateMessageId(role: string): string {
	if (role === "assistant") {
		return `chatcmpl-${randomUUID()}`;
	}
	return randomUUID();
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextContent => typeof c === "object" && c !== null && c.type === "text")
		.map((c) => c.text)
		.join("");
}

function mapStopReason(stopReason: string): string {
	switch (stopReason) {
		case "stop":
			return "stop";
		case "toolUse":
			return "tool_calls";
		case "length":
			return "length";
		case "max_tokens":
			return "max_tokens";
		case "error":
			return "error";
		default:
			return "stop";
	}
}

interface ContentPart {
	type: string;
	[key: string]: unknown;
}

function buildContentParts(message: AssistantMessage): ContentPart[] {
	const parts: ContentPart[] = [];
	for (const c of message.content) {
		if (c.type === "thinking") {
			parts.push({ type: "think", think: c.thinking });
		} else if (c.type === "text") {
			parts.push({ type: "text", text: c.text });
		} else if (c.type === "toolCall") {
			const tc = c as ToolCall;
			parts.push({
				type: "tool_call",
				tool_call: {
					id: tc.id,
					name: tc.name,
					args: JSON.stringify(tc.arguments),
					type: "tool_call",
					progress: 0,
				},
			});
		}
	}
	return parts;
}

interface MessageDocData {
	messageId: string;
	conversationId: string;
	user: string;
	parentMessageId: string;
	endpoint: string;
	sender: string;
	isCreatedByUser: boolean;
	text: string;
	model: string | null;
	agentMessage: AgentMessage;
	content?: ContentPart[];
	finish_reason?: string;
	error?: boolean;
	/** Token count of this message's own text only — never call usage or cumulative totals. */
	tokenCount?: number;
	/** Legacy arp field: input tokens of the model call. */
	inputTokenCount?: number;
	/** Per-model-call usage (assistant messages). Strictly separate from tokenCount. */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Turn-cumulative usage on the turn's assistant document (all calls of the turn). */
	totalInputTokens?: number;
	totalOutputTokens?: number;
	totalCacheReadTokens?: number;
	totalCacheWriteTokens?: number;
	recursionLimit?: string;
	metadata?: Record<string, unknown>;
	createdAt?: Date;
}

function buildMessageDoc(
	ctx: ConversationPersistenceContext,
	message: AgentMessage,
	parentMessageId: string,
	overrideMessageId?: string,
	forceHidden?: boolean,
	turnUsageTotals?: UsageTotals,
): MessageDocData {
	const messageId = overrideMessageId || generateMessageId(message.role);
	const base: MessageDocData = {
		messageId,
		conversationId: ctx.conversationId,
		user: ctx.userId,
		parentMessageId,
		endpoint: PI_ENDPOINT,
		sender: "User",
		isCreatedByUser: false,
		text: "",
		model: PI_MODEL,
		agentMessage: message,
		// Persist the agent message's own creation time, not the DB insert
		// time: arp/LibreChat fetches messages sorted by createdAt, and the
		// user message must sort before the assistant reply of the same turn.
		// Insert-time defaults can invert that order when the dual writers
		// (arp pipeline + pi persistence) race, forking the message tree.
		createdAt: new Date(message.timestamp),
	};

	if (message.role === "user") {
		const userMsg = message as UserMessage;
		base.sender = "User";
		base.isCreatedByUser = true;
		base.text = extractText(userMsg.content);
		// Own-size token count of this message's text (not call usage)
		base.tokenCount = userMsg.tokenCount ?? estimateTokens(message);
		// Machine-injected user messages are not typed by the human and would
		// render as stray user bubbles / fork the visible tree. Hide them:
		// - "/skill:" commands injected by arp's execute_skill tool
		// - "<task_responses>" context blocks injected at prompt pickup
		if (base.text.startsWith("/skill:") || base.text.startsWith("<task_responses>")) {
			base.metadata = { ...(base.metadata ?? {}), hiddenFromTree: true };
		}
	} else if (message.role === "assistant") {
		const assistantMsg = message as AssistantMessage;
		base.sender = PI_MODEL;
		base.isCreatedByUser = false;
		base.text = extractText(assistantMsg.content);
		base.content = buildContentParts(assistantMsg);
		base.finish_reason = mapStopReason(assistantMsg.stopReason);
		base.error = assistantMsg.stopReason === "error";
		base.model = assistantMsg.model || PI_MODEL;
		// Own-size token count of this message's text/thinking/tool-call args
		base.tokenCount = assistantMsg.tokenCount ?? estimateTokens(message);
		if (assistantMsg.usage) {
			// Per-model-call usage — recorded separately, never folded into tokenCount
			base.inputTokens = assistantMsg.usage.input;
			base.outputTokens = assistantMsg.usage.output;
			base.cacheReadTokens = assistantMsg.usage.cacheRead;
			base.cacheWriteTokens = assistantMsg.usage.cacheWrite;
			// Legacy arp-compatible field
			base.inputTokenCount = assistantMsg.usage.input;
			// Turn-cumulative totals (all model calls of this turn so far)
			if (turnUsageTotals) {
				base.totalInputTokens = turnUsageTotals.totalInputTokens;
				base.totalOutputTokens = turnUsageTotals.totalOutputTokens;
				base.totalCacheReadTokens = turnUsageTotals.totalCacheReadTokens;
				base.totalCacheWriteTokens = turnUsageTotals.totalCacheWriteTokens;
			}
		}
		base.recursionLimit = `1/${PI_MAX_RECURSION}`;
	} else if (message.role === "toolResult") {
		const toolMsg = message as ToolResultMessage;
		base.sender = "tool";
		base.isCreatedByUser = false;
		base.text = extractText(toolMsg.content);
		base.model = PI_MODEL;
		// Own-size token count of this message's content (not call usage)
		base.tokenCount = toolMsg.tokenCount ?? estimateTokens(message);
	}

	// Whole-turn hiding (skillExecution mode): pi runs as a subagent of the
	// outer agent's execute_skill tool call. Its full transcript must stay out
	// of the visible tree (the agent's tool result already carries the
	// summary), while remaining in pi's own context (loadConversationMessages
	// does not filter hiddenFromTree).
	if (forceHidden) {
		base.metadata = { ...(base.metadata ?? {}), hiddenFromTree: true };
	}

	return base;
}

function isDuplicateKeyError(err: unknown): boolean {
	const e = err as { code?: number; message?: string } | null;
	if (!err) return false;
	return e?.code === 11000 || (typeof e?.message === "string" && e.message.includes("E11000"));
}

/**
 * Save a single agent message to the MongoDB messages collection.
 * Returns the generated messageId, or null if not saved.
 */
export async function saveMessageToMongo(
	ctx: ConversationPersistenceContext,
	message: AgentMessage,
	parentMessageId: string,
	overrideMessageId?: string,
	forceHidden?: boolean,
	turnUsageTotals?: UsageTotals,
): Promise<string | null> {
	if (!isMongoEnabled()) return null;

	const doc = buildMessageDoc(ctx, message, parentMessageId, overrideMessageId, forceHidden, turnUsageTotals);

	try {
		const Message = getMessageModel();
		// Upsert by (messageId, user). Under the unique index, a concurrent
		// writer winning the insert makes this upsert fail with E11000 —
		// retry once: the winner's document now exists, so the retry takes
		// the update path and both writers converge on a single document.
		try {
			await Message.findOneAndUpdate(
				{ messageId: doc.messageId, user: ctx.userId },
				{ $set: doc },
				{ upsert: true, new: true },
			);
		} catch (err) {
			if (!isDuplicateKeyError(err)) throw err;
			await Message.findOneAndUpdate(
				{ messageId: doc.messageId, user: ctx.userId },
				{ $set: doc },
				{ upsert: true, new: true },
			);
		}
		return doc.messageId;
	} catch (err) {
		console.error("[MongoDB] Error saving message:", err);
		return null;
	}
}

/**
 * Merge an assistant message's content into an existing assistant message
 * document in MongoDB. Used to combine consecutive LLM responses within the
 * same tool-use turn into a single document (matching arp/LibreChat behavior).
 *
 * Appends content parts (think, text, tool_call) to the existing document's
 * content array, concatenates text, and updates usage/finish_reason.
 */
export async function mergeAssistantMessageInMongo(
	ctx: ConversationPersistenceContext,
	targetMessageId: string,
	message: AssistantMessage,
	turnUsageTotals?: UsageTotals,
): Promise<void> {
	if (!isMongoEnabled()) return;

	try {
		const Message = getMessageModel();
		const existing = (await Message.findOne({ messageId: targetMessageId, user: ctx.userId }).lean()) as Record<
			string,
			unknown
		> | null;
		if (!existing) {
			// Target not found — fallback to creating a new document
			await saveMessageToMongo(ctx, message, NO_PARENT, undefined, undefined, turnUsageTotals);
			return;
		}

		// Build new content parts to append
		const newParts: ContentPart[] = buildContentParts(message);

		// Merge existing content with new parts
		const existingContent = (existing.content as ContentPart[]) || [];
		const mergedContent = [...existingContent, ...newParts];

		// Concatenate text
		const existingText = (existing.text as string) || "";
		const newText = extractText(message.content);
		const mergedText = existingText + (existingText && newText ? "\n" : "") + newText;

		// Update usage (take the latest)
		const update: Record<string, unknown> = {
			content: mergedContent,
			text: mergedText,
			finish_reason: mapStopReason(message.stopReason),
			// Same-turn merges (error retries, abort finalizers) must refresh
			// the error flag — otherwise a failed first attempt leaves the
			// merged document permanently marked as error.
			error: message.stopReason === "error",
		};

		// Own-size token count of the merged text (not call usage, not cumulative)
		update.tokenCount = Math.ceil(mergedText.length / 4);
		if (message.usage) {
			// Per-model-call usage of the latest call — separate fields, never tokenCount
			update.inputTokens = message.usage.input;
			update.outputTokens = message.usage.output;
			update.cacheReadTokens = message.usage.cacheRead;
			update.cacheWriteTokens = message.usage.cacheWrite;
			// Legacy arp-compatible field
			update.inputTokenCount = message.usage.input;
		}
		// Turn-cumulative totals (all model calls of this turn so far)
		if (turnUsageTotals) {
			update.totalInputTokens = turnUsageTotals.totalInputTokens;
			update.totalOutputTokens = turnUsageTotals.totalOutputTokens;
			update.totalCacheReadTokens = turnUsageTotals.totalCacheReadTokens;
			update.totalCacheWriteTokens = turnUsageTotals.totalCacheWriteTokens;
		}

		// Update agentMessage to the latest assistant message
		update.agentMessage = message;

		await Message.updateOne({ messageId: targetMessageId, user: ctx.userId }, { $set: update });
	} catch (err) {
		console.error("[MongoDB] Error merging assistant message:", err);
	}
}

/**
 * Update a tool_call content part's `output` field on the most recent
 * assistant message, matching by `toolCallId`.
 *
 * This bridges pi's separate ToolResultMessage model to arp's inline
 * `tool_call.output` format. When pi completes a tool call, the result is
 * written back into the assistant message's content array so arp/LibreChat
 * can display the tool output inline.
 *
 * Does NOT create a separate message document — the tool result lives inline
 * in the assistant message's content array (arp format). On reload,
 * `reconstructAgentMessage` extracts ToolResultMessages from the inline output.
 *
 * Returns the parentMessageId (the assistant message's messageId) for linking,
 * or null if not updated.
 */
export async function updateToolCallOutputInMongo(
	ctx: ConversationPersistenceContext,
	toolCallId: string,
	output: string,
): Promise<string | null> {
	if (!isMongoEnabled()) return null;

	try {
		const Message = getMessageModel();

		// Find the most recent assistant message that has a tool_call matching this toolCallId
		const assistantDocs = await Message.find({
			conversationId: ctx.conversationId,
			user: ctx.userId,
			isCreatedByUser: false,
			"content.type": "tool_call",
		})
			.sort({ createdAt: -1 })
			.lean();

		for (const doc of assistantDocs) {
			const content = (doc as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined;
			if (!content || !Array.isArray(content)) continue;

			for (let i = 0; i < content.length; i++) {
				const part = content[i];
				if (part.type === "tool_call") {
					const tc = part.tool_call as Record<string, unknown> | undefined;
					if (tc && tc.id === toolCallId) {
						const contentPath = `content.${i}.tool_call.output`;
						const progressPath = `content.${i}.tool_call.progress`;
						await Message.updateOne(
							{ _id: (doc as Record<string, unknown>)._id },
							{
								$set: {
									[contentPath]: output,
									[progressPath]: 1,
								},
							},
						);
						// Return the assistant message's messageId for parent linking
						return (doc as Record<string, unknown>).messageId as string;
					}
				}
			}
		}
		return null;
	} catch (err) {
		console.error("[MongoDB] Error updating tool call output:", err);
		return null;
	}
}

/**
 * Save or update the conversation record. Re-links the messages array from
 * the messages collection.
 */
export async function saveConversationToMongo(
	ctx: ConversationPersistenceContext,
	options?: { title?: string; finishReason?: string; usageTotals?: UsageTotals },
): Promise<void> {
	if (!isMongoEnabled()) return;

	try {
		const Conversation = getConversationModel();
		const Message = getMessageModel();

		const messageDocs = await Message.find(
			{
				conversationId: ctx.conversationId,
				user: ctx.userId,
				"metadata.isSubagentTrace": { $ne: true },
				"metadata.hiddenFromTree": { $ne: true },
			},
			"_id",
		)
			.sort({ createdAt: 1 })
			.lean();
		const messageObjectIds = messageDocs.map((m) => m._id);

		const update: Record<string, unknown> = {
			user: ctx.userId,
			messages: messageObjectIds,
			endpoint: PI_ENDPOINT,
			// arp/LibreChat frontend validates endpointType against the strict
			// EModelEndpoint zod enum ('pi' is not a member). The pi endpoint is
			// a librechat.yaml custom endpoint, so arp writes 'custom' — we must
			// match, otherwise createPayload's tConvoUpdateSchema.parse throws
			// ZodError when the user sends a message in a pi-written conversation.
			endpointType: "custom",
			agent_id: PI_CONVO_AGENT_ID,
			model: PI_MODEL,
			cwd: ctx.cwd,
			isArchived: false,
			resendFiles: true,
			toolCallVisible: false,
			tags: [],
			files: [],
			expiredAt: null,
		};

		if (options?.title !== undefined) {
			update.title = options.title;
		}
		if (options?.finishReason !== undefined) {
			update.finish_reason = options.finishReason;
		}
		// Cumulative session usage totals for metering/display
		if (options?.usageTotals) {
			update.totalInputTokens = options.usageTotals.totalInputTokens;
			update.totalOutputTokens = options.usageTotals.totalOutputTokens;
			update.totalCacheReadTokens = options.usageTotals.totalCacheReadTokens;
			update.totalCacheWriteTokens = options.usageTotals.totalCacheWriteTokens;
		}

		await Conversation.findOneAndUpdate(
			{ conversationId: ctx.conversationId, user: ctx.userId },
			{ $set: update },
			{ upsert: true, new: true },
		);
	} catch (err) {
		console.error("[MongoDB] Error saving conversation:", err);
	}
}

/**
 * Map arp `finish_reason` back to pi's `StopReason`.
 */
function mapFinishReasonToStopReason(finishReason: string | undefined): StopReason {
	switch (finishReason) {
		case "stop":
			return "stop";
		case "tool_calls":
			return "toolUse";
		case "length":
		case "max_tokens":
			return "length";
		case "error":
			return "error";
		default:
			return "stop";
	}
}

/**
 * Reconstruct pi AgentMessages from a MongoDB message document.
 *
 * Returns an array because one arp message document with tool_call content
 * parts maps to multiple pi messages (one AssistantMessage + one
 * ToolResultMessage per tool call with output).
 *
 * If the document was written by pi (has `agentMessage` field), it is used
 * directly — this preserves tool calls, tool results, and other pi-specific
 * message types.
 *
 * If the document was written by arp/LibreChat (no `agentMessage` field), it
 * is reverse-constructed from the arp-compatible fields. Tool calls in the
 * arp `content` array (`{type:'tool_call', tool_call:{id,name,args,output}}`)
 * are split into a pi `AssistantMessage` (with `ToolCall` content blocks) and
 * separate `ToolResultMessage` entries (one per tool call with output).
 */
function reconstructAgentMessage(doc: Record<string, unknown>): AgentMessage[] {
	// Path 1: pi-written message with full agentMessage
	const agentMessage = doc.agentMessage as AgentMessage | undefined;
	if (agentMessage && typeof agentMessage === "object" && "role" in agentMessage) {
		// Skip standalone tool result documents — tool results are now inline
		// in the assistant message's content array (arp format). These standalone
		// docs may exist from older data but should be ignored.
		if (doc.isToolResult as boolean) {
			return [];
		}

		// For pi-written assistant messages, extract tool results from the
		// inline content array (tool_call.output) and generate ToolResultMessages
		if (agentMessage.role === "assistant") {
			const content = doc.content as Array<{ type: string; [key: string]: unknown }> | undefined;
			const toolResults = extractToolResultsFromContent(content);
			if (toolResults.length > 0) {
				return [agentMessage, ...toolResults];
			}
		}

		return [agentMessage];
	}

	// Path 2: arp/LibreChat-written message — reverse-construct from arp fields
	const isCreatedByUser = doc.isCreatedByUser as boolean | undefined;
	const text = (doc.text as string) || "";
	const content = doc.content as Array<{ type: string; [key: string]: unknown }> | undefined;
	const model = (doc.model as string) || PI_MODEL;
	const tokenCount = doc.tokenCount as number | undefined;
	const inputTokenCount = doc.inputTokenCount as number | undefined;
	const finishReason = doc.finish_reason as string | undefined;
	const createdAt = doc.createdAt;
	const timestamp = createdAt ? new Date(createdAt as string).getTime() : Date.now();

	// User message
	if (isCreatedByUser) {
		return [
			{
				role: "user",
				content: text,
				timestamp,
			} as UserMessage,
		];
	}

	// Skip standalone tool result documents (no agentMessage, sender='tool')
	// These are from older data — tool results are inline in assistant messages
	if ((doc.sender as string) === "tool" || (doc.isToolResult as boolean)) {
		return [];
	}

	// Assistant message — reconstruct content from arp content array
	const assistantContent: Array<TextContent | ThinkingContent | ToolCall> = [];
	const toolCallOutputs: Array<{ id: string; name: string; output: string }> = [];

	if (content && Array.isArray(content)) {
		for (const part of content) {
			if (part.type === "think" && part.think) {
				assistantContent.push({ type: "thinking", thinking: part.think as string });
			} else if (part.type === "text" && part.text) {
				assistantContent.push({ type: "text", text: part.text as string });
			} else if (part.type === "tool_call") {
				const tc = part.tool_call as
					| {
							id?: string;
							name?: string;
							args?: string | Record<string, unknown>;
							output?: string;
							progress?: number;
					  }
					| undefined;
				if (tc) {
					// Parse args from string or object
					let args: Record<string, unknown> = {};
					if (typeof tc.args === "string") {
						try {
							args = JSON.parse(tc.args);
						} catch {
							args = { raw: tc.args };
						}
					} else if (tc.args && typeof tc.args === "object") {
						args = tc.args as Record<string, unknown>;
					}

					// Add ToolCall to assistant content
					assistantContent.push({
						type: "toolCall",
						id: tc.id || "",
						name: tc.name || "",
						arguments: args,
					});

					// Collect tool output for separate ToolResultMessage
					if (tc.output != null && tc.output !== "") {
						toolCallOutputs.push({
							id: tc.id || "",
							name: tc.name || "",
							output: tc.output,
						});
					}
				}
			}
		}
	}

	// Fallback: use text field if content array has no text/thinking
	const hasTextOrThinking = assistantContent.some((c) => c.type === "text" || c.type === "thinking");
	if (!hasTextOrThinking && text) {
		assistantContent.push({ type: "text", text });
	}
	if (assistantContent.length === 0) {
		return [];
	}

	const inputTokens = inputTokenCount ?? 0;
	const outputTokens = tokenCount ?? 0;
	const messages: AgentMessage[] = [
		{
			role: "assistant",
			content: assistantContent,
			api: "openai-chat-completions",
			provider: "openai",
			model,
			usage: {
				input: inputTokens,
				output: outputTokens,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens + outputTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: mapFinishReasonToStopReason(finishReason),
			timestamp,
		} as AssistantMessage,
	];

	// Create ToolResultMessage for each tool call with output
	for (const tco of toolCallOutputs) {
		messages.push({
			role: "toolResult",
			toolCallId: tco.id,
			toolName: tco.name,
			content: [{ type: "text", text: tco.output }],
			isError: false,
			timestamp,
		} as ToolResultMessage);
	}

	return messages;
}

/**
 * Extract ToolResultMessages from inline tool_call.output fields in an arp
 * content array. Returns one ToolResultMessage per tool_call that has a
 * non-empty output.
 */
function extractToolResultsFromContent(
	content: Array<{ type: string; [key: string]: unknown }> | undefined,
): ToolResultMessage[] {
	if (!content || !Array.isArray(content)) return [];

	const results: ToolResultMessage[] = [];
	for (const part of content) {
		if (part.type !== "tool_call") continue;
		const tc = part.tool_call as { id?: string; name?: string; output?: string } | undefined;
		if (!tc || tc.output == null || tc.output === "") continue;

		results.push({
			role: "toolResult",
			toolCallId: tc.id || "",
			toolName: tc.name || "",
			content: [{ type: "text", text: tc.output }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	return results;
}

/**
 * Load all messages for a conversation from MongoDB, reconstructed as
 * AgentMessage[] for pi context restoration.
 *
 * Supports both pi-written messages (via `agentMessage` field) and
 * arp/LibreChat-written messages (reverse-constructed from arp fields,
 * including inline tool_call splitting into separate ToolResultMessages).
 */
export async function loadConversationMessages(ctx: ConversationPersistenceContext): Promise<AgentMessage[]> {
	if (!isMongoEnabled()) return [];

	try {
		const Message = getMessageModel();
		const docs = await Message.find({
			conversationId: ctx.conversationId,
			user: ctx.userId,
			"metadata.isSubagentTrace": { $ne: true },
		})
			.sort({ createdAt: 1 })
			.lean();

		const messages: AgentMessage[] = [];
		for (const doc of docs) {
			const reconstructed = reconstructAgentMessage(doc as Record<string, unknown>);
			messages.push(...reconstructed);
		}
		return messages;
	} catch (err) {
		console.error("[MongoDB] Error loading messages:", err);
		return [];
	}
}

/**
 * Get the messageId of the most recently created message in this conversation.
 * Used to set parentMessageId for the next message.
 *
 * A wrong NO_PARENT here forks the message tree from the root, so when the
 * primary query yields NO_PARENT but the conversation has messages (transient
 * error / replication lag), re-query once before giving up.
 */
export async function getLastMessageId(ctx: ConversationPersistenceContext): Promise<string> {
	if (!isMongoEnabled()) return NO_PARENT;

	const queryLast = async (): Promise<string | null> => {
		const Message = getMessageModel();
		const lastMsg = await Message.findOne({ conversationId: ctx.conversationId, user: ctx.userId }, "messageId")
			.sort({ createdAt: -1 })
			.lean();
		return ((lastMsg as Record<string, unknown> | null)?.messageId as string | undefined) ?? null;
	};

	try {
		const first = await queryLast();
		if (first) return first;

		// NO_PARENT candidate: verify the conversation is actually empty.
		try {
			const Message = getMessageModel();
			const count = await Message.countDocuments({ conversationId: ctx.conversationId, user: ctx.userId });
			if (count > 0) {
				console.error(
					`[MongoDB] getLastMessageId: primary query returned null but conversation has ${count} messages - re-querying`,
				);
				const retry = await queryLast();
				if (retry) return retry;
				console.error("[MongoDB] getLastMessageId: retry also returned null - mounting at NO_PARENT");
			}
		} catch (verifyErr) {
			console.error("[MongoDB] getLastMessageId verification failed:", verifyErr);
		}
		return NO_PARENT;
	} catch (err) {
		console.error("[MongoDB] Error getting last message ID:", err);
		return NO_PARENT;
	}
}

/**
 * Get the conversation document from MongoDB.
 */
export async function getConversationFromMongo(
	ctx: ConversationPersistenceContext,
): Promise<Record<string, unknown> | null> {
	if (!isMongoEnabled()) return null;

	try {
		const Conversation = getConversationModel();
		return (await Conversation.findOne({ conversationId: ctx.conversationId, user: ctx.userId }).lean()) as Record<
			string,
			unknown
		> | null;
	} catch (err) {
		console.error("[MongoDB] Error getting conversation:", err);
		return null;
	}
}

/**
 * Derive a conversation title from the first user message.
 */
export function deriveTitle(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "New Chat";
	const firstLine = trimmed.split("\n")[0];
	return firstLine.length > 50 ? `${firstLine.slice(0, 50)}...` : firstLine;
}
