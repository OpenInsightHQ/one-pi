import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { findTasksByConversation, updateTaskStatusInMongo } from "./mongo/index.js";

const cancelTaskSchema = Type.Object({
	taskId: Type.String({ description: "The _id of the task to cancel (from the task panel / injected task context)" }),
	reason: Type.Optional(Type.String({ description: "Short reason shown in the task panel" })),
});

export interface CancelTaskToolDetails {
	taskId: string;
	cancelled: boolean;
}

const CANCELLABLE_STATUSES = new Set(["pending", "accepted", "in_progress", "waiting_agent", "running"]);

/**
 * Cancel an active task by id. Users can ask in natural language
 * ("取消那个 PPT 任务") - the model matches that to the task list injected
 * into context (or fetched via list_tasks) and calls this tool.
 */
export function createCancelTaskTool(
	defaultConversationId: string,
): AgentTool<typeof cancelTaskSchema, CancelTaskToolDetails> {
	return {
		name: "cancel_task",
		label: "Cancel Task",
		description: `Cancel an active task in the user's task panel by its _id.

Works on tasks still in progress (pending/accepted/in_progress/waiting_agent/running).
Cancelled tasks end in status 'aborted' and stop appearing as active.

Use when the user asks to cancel/stop/drop a task ("取消那个任务", "别做了").
To find the taskId, use the list_tasks tool first if it is not already in context.`,
		parameters: cancelTaskSchema,
		async execute(_toolCallId, params) {
			try {
				// Guard: only cancel tasks belonging to this conversation
				const tasks = await findTasksByConversation(defaultConversationId);
				const target = tasks.find((t) => String(t._id) === params.taskId);
				if (!target) {
					return {
						content: [{ type: "text", text: `Task ${params.taskId} not found in this conversation.` }],
						details: { taskId: params.taskId, cancelled: false },
					};
				}
				if (!CANCELLABLE_STATUSES.has(String(target.status))) {
					return {
						content: [
							{ type: "text", text: `Task "${target.title}" is already ${target.status} - nothing to cancel.` },
						],
						details: { taskId: params.taskId, cancelled: false },
					};
				}

				const ok = await updateTaskStatusInMongo(
					params.taskId,
					"aborted",
					params.reason ?? "cancelled by user request",
				);
				return {
					content: [
						{
							type: "text",
							text: ok
								? `Task "${target.title}" cancelled${params.reason ? ` (${params.reason})` : ""}.`
								: `Failed to cancel task "${target.title}".`,
						},
					],
					details: { taskId: params.taskId, cancelled: ok },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error cancelling task: ${String(err)}` }],
					details: { taskId: params.taskId, cancelled: false },
				};
			}
		},
	};
}

const listTasksSchema = Type.Object({});

export interface ListTasksToolDetails {
	count: number;
}

/** List this conversation's tasks so the model can resolve cancel requests to ids. */
export function createListTasksTool(
	defaultConversationId: string,
): AgentTool<typeof listTasksSchema, ListTasksToolDetails> {
	return {
		name: "list_tasks",
		label: "List Tasks",
		description:
			"List the current conversation's task-panel tasks (id, title, status, type). Use before cancel_task to find the right _id, or when the user asks what tasks exist.",
		parameters: listTasksSchema,
		async execute() {
			const tasks = await findTasksByConversation(defaultConversationId);
			const lines = tasks.map(
				(t) => `- ${t._id} | ${t.status} | ${t.type ?? "ai_pending"} | ${(t.title as string) ?? ""}`,
			);
			return {
				content: [
					{
						type: "text",
						text: lines.length > 0 ? lines.join("\n") : "(no tasks in this conversation)",
					},
				],
				details: { count: tasks.length },
			};
		},
	};
}
