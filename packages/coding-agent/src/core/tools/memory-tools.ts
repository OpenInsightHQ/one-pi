import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getUserMemoriesWithAccess, readConversationByMemory, readMemoryDetail } from "../mongo/memory-service.js";

/**
 * Long-term memory tools (migrated from arp's `/api/memories/details` and
 * `/api/memories/conversation-by-memory` skill-wrapped endpoints).
 *
 * The tools are injected into HTTP API sessions when the user has memory
 * access (role MEMORIES USE+READ, not opted out) and at least one memory
 * entry; each tool reads MongoDB directly, scoped to the session user.
 */

const memoryIdSchema = Type.Object({
	memoryId: Type.String({ description: "Memory ID (记忆ID) listed in the [用户长期记忆] section" }),
});

type MemoryIdParams = Static<typeof memoryIdSchema>;

function textResult(text: string): AgentToolResult<{ user: string }> {
	return { content: [{ type: "text" as const, text }], details: { user: "memory" } };
}

/**
 * Returns the memory tools for the given user, or an empty array when the
 * user has no accessible memories.
 */
export async function createMemoryAgentTools(userId: string): Promise<AgentTool[]> {
	const memories = await getUserMemoriesWithAccess(userId).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[Memory] Failed to load memories for user ${userId}: ${message}`);
		return null;
	});
	if (!memories || memories.length === 0) return [];

	const readMemoryDetailTool: AgentTool = {
		name: "read_memory_detail",
		label: "read_memory_detail",
		description:
			"Read a long-term memory's details and the original messages that produced it, by memory ID (记忆ID) from the [用户长期记忆] section. Use when the user asks for the source or details of a specific memory.",
		parameters: memoryIdSchema as any,
		async execute(
			_toolCallId: string,
			params: any,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<{ user: string }>> {
			const { memoryId } = params as MemoryIdParams;
			try {
				const result = await readMemoryDetail(userId, memoryId);
				return textResult(typeof result === "string" ? result : JSON.stringify(result, null, 2));
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return textResult(`read_memory_detail failed: ${message}`);
			}
		},
	};

	const readMemoryConversationTool: AgentTool = {
		name: "read_memory_conversation",
		label: "read_memory_conversation",
		description:
			"Read the full conversation chat history that a long-term memory was produced in, by memory ID (记忆ID) from the [用户长期记忆] section. Use when the user asks about the original conversation behind a memory.",
		parameters: memoryIdSchema as any,
		async execute(
			_toolCallId: string,
			params: any,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<{ user: string }>> {
			const { memoryId } = params as MemoryIdParams;
			try {
				const result = await readConversationByMemory(userId, memoryId);
				return textResult(typeof result === "string" ? result : JSON.stringify(result, null, 2));
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return textResult(`read_memory_conversation failed: ${message}`);
			}
		},
	};

	return [readMemoryDetailTool, readMemoryConversationTool];
}
