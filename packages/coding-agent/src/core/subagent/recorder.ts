import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MongoRecorder, SubagentTask } from "./types.js";

const PI_SUBAGENT_ENDPOINT = "pi-subagent";
const NO_PARENT = "00000000-0000-0000-0000-000000000000";

/** Max characters per step text (output/args truncation guard). */
const MAX_STEP_TEXT = 10_000;
/** Max total characters across all buffered steps before oldest are dropped. */
const MAX_TOTAL_STEPS_CHARS = 4_000_000;

export interface SubagentStep {
	type: "text" | "thinking" | "tool_call" | "tool_result";
	ts: number;
	text?: string;
	role?: string;
	toolName?: string;
	args?: unknown;
	output?: string;
	isError?: boolean;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && c.type === "text")
		.map((c) => c.text)
		.join("");
}

function truncate(text: string): string {
	if (text.length <= MAX_STEP_TEXT) return text;
	return `${text.slice(0, MAX_STEP_TEXT)}\n... (truncated)`;
}

/**
 * Records a subagent execution as a SINGLE message document per task.
 *
 * Steps are buffered in memory while the subagent runs and written once on
 * flush() (called on completion, failure, or abort). This keeps the messages
 * collection at one trace doc per subagent task instead of one per internal
 * message, which previously bloated conversations (200+ docs per exploration).
 */
export class SubagentRecorder {
	private steps: SubagentStep[] = [];
	private totalChars = 0;
	private flushed = false;

	constructor(
		private task: SubagentTask,
		private recorder: MongoRecorder | undefined,
	) {}

	record(message: AgentMessage): void {
		const ts = Date.now();

		if (message.role === "user") {
			this.push({
				type: "text",
				role: "user",
				text: truncate(extractText((message as { content?: unknown }).content ?? "")),
				ts,
			});
			return;
		}

		if (message.role === "assistant") {
			const content = (message as unknown as { content?: Array<Record<string, unknown>> }).content ?? [];
			for (const part of content) {
				if (part.type === "thinking" && typeof part.thinking === "string") {
					this.push({ type: "thinking", text: truncate(part.thinking), ts });
				} else if (part.type === "text" && typeof part.text === "string") {
					this.push({ type: "text", role: "assistant", text: truncate(part.text), ts });
				} else if (part.type === "toolCall" && part.toolCall) {
					const tc = part.toolCall as { name?: string; arguments?: unknown };
					this.push({
						type: "tool_call",
						toolName: tc.name,
						args: tc.arguments,
						ts,
					});
				}
			}
			return;
		}

		if (message.role === "toolResult") {
			const msg = message as { toolName?: string; content?: unknown; isError?: boolean };
			this.push({
				type: "tool_result",
				toolName: msg.toolName,
				output: truncate(extractText(msg.content)),
				isError: msg.isError ?? false,
				ts,
			});
		}
	}

	private push(step: SubagentStep): void {
		this.steps.push(step);
		this.totalChars += step.text?.length ?? step.output?.length ?? 0;
		// Drop oldest intermediate steps if the buffer grows unboundedly
		while (this.totalChars > MAX_TOTAL_STEPS_CHARS && this.steps.length > 4) {
			const dropped = this.steps.splice(1, 1)[0];
			this.totalChars -= dropped.text?.length ?? dropped.output?.length ?? 0;
		}
	}

	/** Write the accumulated steps as a single trace document. Idempotent. */
	async flush(finalOutput: string, success: boolean, durationMs: number): Promise<void> {
		if (!this.recorder || this.flushed) return;
		this.flushed = true;

		const ctx = this.recorder.ctx;
		const messageId = `sub_${this.task.id}`;

		try {
			const Message = (await import("../mongo/models.js")).getMessageModel();
			await Message.findOneAndUpdate(
				{ messageId, user: ctx.userId },
				{
					$set: {
						messageId,
						conversationId: ctx.conversationId,
						parentMessageId: NO_PARENT,
						user: ctx.userId,
						endpoint: PI_SUBAGENT_ENDPOINT,
						sender: this.task.agentName,
						isCreatedByUser: false,
						text: truncate(finalOutput),
						model: "one-pi",
						metadata: {
							isSubagentTrace: true,
							subagentTaskId: this.task.id,
							subagentName: this.task.agentName,
							subagentSuccess: success,
							subagentDurationMs: durationMs,
							subagentStepCount: this.steps.length,
							subagentSteps: this.steps,
						},
					},
				},
				{ upsert: true, new: true },
			);
		} catch (err) {
			console.error("[SubagentRecorder] Error saving trace document:", err);
		}
	}
}

export function generateTaskId(): string {
	return randomUUID();
}

export function extractLastAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const content = (message as { content?: unknown[] }).content;
	if (!Array.isArray(content)) return "";
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i] as Record<string, unknown>;
		if (part && part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}
