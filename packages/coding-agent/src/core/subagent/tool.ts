import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { updateTaskStatusInMongo } from "../mongo/task-queue-service.js";
import type { SubagentScheduler } from "./scheduler.js";
import type { ParentContext, SubagentResult } from "./types.js";

const subagentSchema = Type.Object({
	agentName: Type.String({
		description: "Which subagent to use. Available agents can be listed by calling with agentName='list'.",
	}),
	prompt: Type.String({ description: "The task to delegate to the subagent" }),
	taskId: Type.Optional(
		Type.String({
			description:
				"Optional taskqueues _id of a create_task-created subtask (type 'subagent'). When linked, the task status auto-updates: running on start, completed/failed on finish.",
		}),
	),
	mode: Type.Optional(
		Type.Enum(
			{ single: "single", parallel: "parallel" },
			{
				description:
					"Execution mode. 'single' runs one subagent (default). 'parallel' runs multiple tasks concurrently.",
			},
		),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agentName: Type.String({ description: "Which subagent to use for this task" }),
				prompt: Type.String({ description: "The task for this subagent" }),
				taskId: Type.Optional(
					Type.String({ description: "Optional linked create_task task _id for status auto-update" }),
				),
			}),
			{ description: "For 'parallel' mode: list of tasks to run concurrently" },
		),
	),
});

export interface SubagentToolDetails {
	mode: "single" | "parallel";
	results: SubagentResult[];
}

/** Max chars of finalOutput written back as task resultSummary. */
const MAX_SUMMARY_LEN = 300;

function formatResult(result: SubagentResult): string {
	if (!result.success) {
		return `[${result.agentName}] FAILED: ${result.error}`;
	}
	return `[${result.agentName}] (${result.durationMs}ms)\n${result.finalOutput}`;
}

/** Update a linked taskqueues doc for one executed subtask. Never throws. */
function syncTaskStatus(taskId: string | undefined, result: SubagentResult): void {
	if (!taskId) return;
	const status = result.success ? "completed" : "failed";
	const summary = (result.success ? result.finalOutput : (result.error ?? "")).slice(0, MAX_SUMMARY_LEN);
	updateTaskStatusInMongo(taskId, status, summary).catch(() => {});
}

function markTaskRunning(taskId: string | undefined): void {
	if (!taskId) return;
	updateTaskStatusInMongo(taskId, "running").catch(() => {});
}

export function createSubagentTool(
	scheduler: SubagentScheduler,
	parentContext: ParentContext,
): AgentTool<typeof subagentSchema, SubagentToolDetails> {
	return {
		name: "subagent",
		label: "Subagent",
		description: `Delegate a subtask to a specialized subagent with isolated context. The subagent runs independently and returns only its final result, saving tokens and keeping the main context clean.

Available agents:
${scheduler
	.getAvailableAgents()
	.map((a) => `- ${a.name}: ${a.description}`)
	.join("\n")}

Use 'single' mode for one task, 'parallel' mode with 'tasks' array for multiple concurrent tasks.

Task tracking: when you decomposed the work into visible tasks via create_task (type 'subagent'), pass each task's _id via taskId so its status auto-updates in the user's task panel.`,
		parameters: subagentSchema,
		async execute(_toolCallId, params, _signal, onUpdate) {
			if (params.agentName === "list") {
				const agents = scheduler.getAvailableAgents();
				return {
					content: [
						{
							type: "text",
							text: `Available subagents:\n${agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n")}`,
						},
					],
					details: { mode: "single", results: [] },
				};
			}

			const mode = params.mode ?? "single";

			if (mode === "parallel" && params.tasks && params.tasks.length > 0) {
				for (const t of params.tasks) {
					markTaskRunning(t.taskId);
				}

				const tasks = params.tasks.map((t) => scheduler.createTask(t.agentName, t.prompt, parentContext));
				const results = await scheduler.executeAll(tasks, (progress) => {
					onUpdate?.({
						content: [{ type: "text", text: progress }],
						details: { mode: "parallel", results: [] },
					});
				});

				// results preserve input order; map back to linked taskIds by index
				results.forEach((result, i) => {
					syncTaskStatus(params.tasks?.[i]?.taskId, result);
				});

				return {
					content: [
						{
							type: "text",
							text: results.map(formatResult).join("\n\n---\n\n"),
						},
					],
					details: { mode: "parallel", results },
				};
			}

			markTaskRunning(params.taskId);
			const task = scheduler.createTask(params.agentName, params.prompt, parentContext);
			const result = await scheduler.execute(task, (progress) => {
				onUpdate?.({
					content: [{ type: "text", text: progress }],
					details: { mode: "single", results: [] },
				});
			});
			syncTaskStatus(params.taskId, result);

			return {
				content: [
					{
						type: "text",
						text: formatResult(result),
					},
				],
				details: { mode: "single", results: [result] },
			};
		},
	};
}
