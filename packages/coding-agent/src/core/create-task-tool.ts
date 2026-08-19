import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { TaskSync } from "./task-sync.js";

const createSubtaskSchema = Type.Object({
	title: Type.String({ description: "Short title for the subtask shown in the user's task panel" }),
	description: Type.Optional(Type.String({ description: "What this subtask covers" })),
	priority: Type.Optional(
		Type.Enum({ low: "low", medium: "medium", high: "high" }, { description: "Task priority (default: medium)" }),
	),
});

export interface CreateTaskToolDetails {
	taskId: string | null;
	status: string;
}

/**
 * create_subtask — task DECOMPOSITION only.
 *
 * Interactive (human-pending) tasks were removed by design: skill runs and
 * agent turns run unattended, and user decisions happen through normal
 * conversation. This tool registers an execution-tracking task (type
 * 'subagent') that the user watches in the task panel; dispatch it via the
 * subagent tool with the returned _id as taskId so status auto-updates
 * (running → completed/failed).
 */
export function createCreateTaskTool(
	taskSync: TaskSync,
	defaultUserId: string,
	defaultConversationId: string,
	defaultAgentId: string,
	turnSeq: () => number,
): AgentTool<typeof createSubtaskSchema, CreateTaskToolDetails> {
	return {
		name: "create_subtask",
		label: "Create Subtask",
		description: `Register a subtask in the user's task panel (execution tracking).

Use when DECOMPOSING work into subtasks: create one entry per subtask FIRST so
the user sees the plan, then execute each via the subagent tool passing the
returned _id as taskId — the task status then auto-updates
(running → completed/failed) as work progresses.

User decisions/confirmations do NOT go here: ask in normal conversation text.`,
		parameters: createSubtaskSchema,
		async execute(_toolCallId, params) {
			if (!taskSync.isEnabled()) {
				return {
					content: [
						{
							type: "text",
							text: "Task queue is not available (MongoDB not enabled). Task was not created.",
						},
					],
					details: { taskId: null, status: "error" },
				};
			}

			const taskId = await taskSync.createTask({
				toUserId: defaultUserId,
				fromAgentId: defaultAgentId,
				title: params.title,
				description: params.description,
				type: "subagent",
				sourceConversationId: defaultConversationId,
				sourceTurnSeq: turnSeq(),
				priority: params.priority,
			});

			if (!taskId) {
				return {
					content: [{ type: "text", text: "Failed to create subtask." }],
					details: { taskId: null, status: "error" },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Subtask created: "${params.title}"\nTask ID: ${taskId}\nStatus: pending (queued for execution). Pass this _id as taskId to the subagent tool when dispatching.`,
					},
				],
				details: { taskId, status: "pending" },
			};
		},
	};
}
