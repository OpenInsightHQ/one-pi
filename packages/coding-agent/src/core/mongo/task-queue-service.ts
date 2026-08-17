/**
 * TaskQueue persistence service.
 *
 * Writes tasks directly to the MongoDB `taskqueues` collection shared with
 * arp/LibreChat — the same pattern as conversation-service.ts (pi owns the
 * write path for AI-created tasks; arp routes handle user-facing mutations).
 *
 * This replaces the earlier HTTP-based TaskSync: no ARP_HOST network
 * dependency, no api-key coupling. The MongoDB connection itself is the
 * trust boundary (identical to how messages/conversations are persisted).
 */

import { isMongoEnabled } from "./db.js";
import { getTaskQueueModel } from "./models.js";
import type { TaskQueueDoc } from "./types.js";

export interface CreateTaskData {
	toUserId: string;
	toAgentId?: string;
	fromUserId: string;
	fromAgentId?: string;
	title: string;
	description?: string;
	type?: string;
	/** Initial status. Defaults to 'pending' at the schema level; subagent executions pass 'running'. */
	status?: string;
	priority?: string;
	formType?: string;
	choices?: Array<{ label: string; value: string; description?: string }>;
	fields?: Array<Record<string, unknown>>;
	sourceConversationId?: string;
	sourceSessionId?: string;
	sourceTurnSeq?: number;
	subagentTaskId?: string;
	subagentName?: string;
}

const TERMINAL_STATUSES = new Set(["completed", "rejected", "dismissed", "failed", "aborted"]);

function toPlainDoc(doc: TaskQueueDoc | null): Record<string, unknown> | null {
	if (!doc) return null;
	const plain = (doc as unknown as { toObject: () => Record<string, unknown> }).toObject();
	delete plain.__v;
	return plain;
}

/** Create a task. Returns the new task as a plain object, or null on failure. */
export async function createTaskInMongo(data: CreateTaskData): Promise<Record<string, unknown> | null> {
	if (!isMongoEnabled()) return null;

	try {
		const TaskQueue = getTaskQueueModel();
		const doc = await TaskQueue.create(data);
		return toPlainDoc(doc);
	} catch (err) {
		console.error("[MongoDB] Error creating task:", err);
		return null;
	}
}

/** List tasks for a conversation (optionally filtered by status). */
export async function findTasksByConversation(
	conversationId: string,
	status?: string,
): Promise<Record<string, unknown>[]> {
	if (!isMongoEnabled()) return [];

	try {
		const TaskQueue = getTaskQueueModel();
		const filter: Record<string, unknown> = { sourceConversationId: conversationId };
		if (status) filter.status = status;
		const docs = await TaskQueue.find(filter).sort({ createdAt: 1 }).lean();
		return docs as unknown as Record<string, unknown>[];
	} catch (err) {
		console.error("[MongoDB] Error finding tasks:", err);
		return [];
	}
}

/** Find tasks in waiting_agent state for a conversation (pending AI pickup). */
export async function findWaitingAgentTasks(conversationId: string): Promise<Record<string, unknown>[]> {
	return findTasksByConversation(conversationId, "waiting_agent");
}

/** Update task status (and optional resultSummary). Returns success. */
export async function updateTaskStatusInMongo(
	taskId: string,
	status: string,
	resultSummary?: string,
): Promise<boolean> {
	if (!isMongoEnabled()) return false;

	try {
		const TaskQueue = getTaskQueueModel();
		const update: Record<string, unknown> = { status };
		if (resultSummary !== undefined) update.resultSummary = resultSummary;
		if (TERMINAL_STATUSES.has(status)) update.completedAt = new Date();

		const res = await TaskQueue.updateOne({ _id: taskId }, { $set: update });
		return res.matchedCount > 0;
	} catch (err) {
		console.error("[MongoDB] Error updating task status:", err);
		return false;
	}
}
