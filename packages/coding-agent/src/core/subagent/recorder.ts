import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MongoRecorder, SubagentTask } from "./types.js";

const PI_SUBAGENT_ENDPOINT = "pi-subagent";

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && c.type === "text")
		.map((c) => c.text)
		.join("");
}

export class SubagentRecorder {
	private seq = 0;
	private lastMessageId = "00000000-0000-0000-0000-000000000000";

	constructor(
		private task: SubagentTask,
		private recorder: MongoRecorder | undefined,
	) {}

	async record(message: AgentMessage): Promise<void> {
		if (!this.recorder) return;

		// Capture seq synchronously: fire-and-forget concurrent record() calls
		// interleave across the await below, so this.seq must not be read later.
		const seq = ++this.seq;
		const messageId = `sub_${this.task.id}_${seq}`;
		const parentMessageId = this.lastMessageId;
		this.lastMessageId = messageId;

		const ctx = this.recorder.ctx;
		const text = extractText((message as { content?: unknown }).content ?? "");

		try {
			const Message = (await import("../mongo/models.js")).getMessageModel();
			await Message.findOneAndUpdate(
				{ messageId, user: ctx.userId },
				{
					$set: {
						messageId,
						conversationId: ctx.conversationId,
						parentMessageId,
						user: ctx.userId,
						endpoint: PI_SUBAGENT_ENDPOINT,
						sender: message.role === "user" ? "User" : message.role === "toolResult" ? "tool" : "one-pi",
						isCreatedByUser: message.role === "user",
						text,
						model: "one-pi",
						agentMessage: message,
						metadata: {
							isSubagentTrace: true,
							subagentTaskId: this.task.id,
							subagentName: this.task.agentName,
							subagentSeq: seq,
						},
					},
				},
				{ upsert: true, new: true },
			);
		} catch (err) {
			console.error("[SubagentRecorder] Error saving trace message:", err);
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
