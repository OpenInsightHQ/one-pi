import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { TaskFormField, TaskSync } from "./task-sync.js";

const createTaskSchema = Type.Object({
	title: Type.String({ description: "Short title for the task" }),
	description: Type.Optional(Type.String({ description: "Detailed description of what's needed" })),
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
			}),
			{ description: "For 'choice' formType: available options" },
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
		description: `Create a task in the task queue that waits for human or agent processing.

Use this when you need:
- User confirmation or approval before proceeding ('confirmation')
- User to choose between options ('choice')
- Structured input from the user ('form')
- Free-form text response ('free_text')

The task will appear in the user's task panel. When the user responds, the task status changes to 'waiting_agent' and the response becomes available for the next prompt.`,
		parameters: createTaskSchema,
		async execute(_toolCallId, params) {
			if (!taskSync.isEnabled()) {
				return {
					content: [
						{
							type: "text",
							text: "Task sync is not configured (ARP_HOST or PI_API_KEY not set). Task was not created.",
						},
					],
					details: { taskId: null, status: "error" },
				};
			}

			const taskId = await taskSync.createTask({
				toUserId: params.toUserId ?? defaultUserId,
				fromAgentId: defaultAgentId,
				title: params.title,
				description: params.description,
				type: "ai_pending",
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
