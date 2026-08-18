import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { TaskFormField, TaskSync } from "./task-sync.js";

const createTaskSchema = Type.Object({
	title: Type.String({ description: "Short title for the task" }),
	description: Type.Optional(Type.String({ description: "Detailed description of what's needed" })),
	type: Type.Optional(
		Type.Enum(
			{
				ai_pending: "ai_pending",
				collaboration: "collaboration",
				manual: "manual",
				subagent: "subagent",
			},
			{
				description:
					"'ai_pending' (default): waits for a human response. 'subagent': an AI-execution subtask — use when decomposing work; pass the returned _id as taskId to the subagent tool so status auto-updates. 'collaboration'/'manual': cross-user collaboration tasks.",
			},
		),
	),
	formType: Type.Optional(
		Type.Enum(
			{
				free_text: "free_text",
				choice: "choice",
				form: "form",
				confirmation: "confirmation",
			},
			{
				description:
					"Type of response expected. 'free_text' (default), 'choice' (pick from options), 'form' (structured fields), 'confirmation' (approve/reject).",
			},
		),
	),
	choices: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ description: "Display label" }),
				value: Type.String({ description: "Value to submit" }),
				description: Type.Optional(Type.String({ description: "Optional explanation" })),
				isCancel: Type.Optional(
					Type.Boolean({
						description:
							"Mark this option as cancel semantics (e.g. '取消'/'Cancel'/'取消'/'None of the above'). Selecting it rejects the task immediately as a terminal state instead of waiting for AI processing.",
					}),
				),
			}),
			{
				description:
					"For 'choice' formType: available options. Mark exactly one cancel-like option with isCancel=true if the plan can be abandoned.",
			},
		),
	),
	fields: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				label: Type.String(),
				fieldType: Type.Enum({
					text: "text",
					textarea: "textarea",
					number: "number",
					select: "select",
					multiselect: "multiselect",
					date: "date",
				}),
				required: Type.Optional(Type.Boolean()),
				options: Type.Optional(Type.Array(Type.String())),
			}),
			{ description: "For 'form' formType: structured fields" },
		),
	),
	toUserId: Type.Optional(
		Type.String({
			description:
				"User ID to assign this task to. Defaults to the current conversation user. Specify another user for cross-user collaboration.",
		}),
	),
	priority: Type.Optional(
		Type.Enum({ low: "low", medium: "medium", high: "high" }, { description: "Task priority (default: medium)" }),
	),
});

export interface CreateTaskToolDetails {
	taskId: string | null;
	status: string;
}

export function createCreateTaskTool(
	taskSync: TaskSync,
	defaultUserId: string,
	defaultConversationId: string,
	defaultAgentId: string,
	turnSeq: () => number,
): AgentTool<typeof createTaskSchema, CreateTaskToolDetails> {
	return {
		name: "create_task",
		label: "Create Task",
		description: `Create a task in the shared task queue. Tasks appear in the user's task panel.

Two usage patterns:
1. Human-pending tasks (type 'ai_pending', default): wait for user input before you proceed.
   - 'confirmation': approve/reject before an action
   - 'choice': user picks from options
   - 'form': structured input fields
   - 'free_text': free-form text response
2. AI-execution subtasks (type 'subagent'): use when DECOMPOSING work into subtasks.
   Create one task per subtask FIRST so the user sees the plan, then execute them
   via the subagent tool passing each returned _id as taskId — the task status
   then auto-updates (running → completed/failed).`,
		parameters: createTaskSchema,
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

			const type = params.type ?? "ai_pending";
			const taskId = await taskSync.createTask({
				toUserId: params.toUserId ?? defaultUserId,
				fromAgentId: defaultAgentId,
				title: params.title,
				description: params.description,
				type,
				formType: params.formType ?? "free_text",
				choices: params.choices,
				fields: params.fields as TaskFormField[] | undefined,
				sourceConversationId: defaultConversationId,
				sourceTurnSeq: turnSeq(),
				priority: params.priority,
			});

			if (!taskId) {
				return {
					content: [{ type: "text", text: "Failed to create task." }],
					details: { taskId: null, status: "error" },
				};
			}

			if (type === "subagent") {
				return {
					content: [
						{
							type: "text",
							text: `Subtask created: "${params.title}"\nTask ID: ${taskId}\nStatus: pending (queued for execution). Pass this _id as taskId to the subagent tool when dispatching.`,
						},
					],
					details: { taskId, status: "pending" },
				};
			}

			const formDesc = params.formType ? ` (expects ${params.formType} response)` : "";

			return {
				content: [
					{
						type: "text",
						text: `Task created: "${params.title}"${formDesc}\nTask ID: ${taskId}\nStatus: pending (waiting for user response)`,
					},
				],
				details: { taskId, status: "pending" },
			};
		},
	};
}
