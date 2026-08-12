import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { SubagentScheduler } from "./scheduler.js";
import type { ParentContext, SubagentResult } from "./types.js";

const subagentSchema = Type.Object({
	agentName: Type.String({
		description: "Which subagent to use. Available agents can be listed by calling with agentName='list'.",
	}),
	prompt: Type.String({ description: "The task to delegate to the subagent" }),
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
			}),
			{ description: "For 'parallel' mode: list of tasks to run concurrently" },
		),
	),
});

export interface SubagentToolDetails {
	mode: "single" | "parallel";
	results: SubagentResult[];
}

function formatResult(result: SubagentResult): string {
	if (!result.success) {
		return `[${result.agentName}] FAILED: ${result.error}`;
	}
	return `[${result.agentName}] (${result.durationMs}ms)\n${result.finalOutput}`;
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

Use 'single' mode for one task, 'parallel' mode with 'tasks' array for multiple concurrent tasks.`,
		parameters: subagentSchema,
		async execute(_toolCallId, params) {
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
				const tasks = params.tasks.map((t) => scheduler.createTask(t.agentName, t.prompt, parentContext));
				const results = await scheduler.executeAll(tasks);

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

			const task = scheduler.createTask(params.agentName, params.prompt, parentContext);
			const result = await scheduler.execute(task);

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
