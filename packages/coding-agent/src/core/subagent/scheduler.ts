import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { extractLastAssistantText, generateTaskId, SubagentRecorder } from "./recorder.js";
import { DEFAULT_SUBAGENTS } from "./registry.js";
import type { SubagentDefinition, SubagentResult, SubagentSchedulerOptions, SubagentTask } from "./types.js";

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let index = 0;

	async function worker(): Promise<void> {
		while (index < items.length) {
			const current = index++;
			results[current] = await fn(items[current]);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

export class SubagentScheduler {
	private registry = new Map<string, SubagentDefinition>();
	private running = new Map<string, { agent: Agent; abort: AbortController }>();
	private readonly globalConcurrencyLimit: number;
	private readonly getModel: (modelId?: string) => Model<any>;
	private readonly streamFn: SubagentSchedulerOptions["streamFn"];
	private readonly getApiKey: SubagentSchedulerOptions["getApiKey"];
	private readonly resolveTools: (names: string[], cwd: string) => AgentTool<any>[];
	private readonly recordToMongo: SubagentSchedulerOptions["recordToMongo"];

	constructor(opts: SubagentSchedulerOptions) {
		this.globalConcurrencyLimit = opts.globalConcurrencyLimit ?? 4;
		this.getModel = opts.getModel;
		this.streamFn = opts.streamFn;
		this.getApiKey = opts.getApiKey;
		this.resolveTools = opts.resolveTools;
		this.recordToMongo = opts.recordToMongo;

		for (const def of DEFAULT_SUBAGENTS) {
			this.registry.set(def.name, def);
		}
	}

	register(def: SubagentDefinition): void {
		this.registry.set(def.name, def);
	}

	getAvailableAgents(): { name: string; description: string }[] {
		return Array.from(this.registry.values()).map((d) => ({
			name: d.name,
			description: d.description,
		}));
	}

	async execute(task: SubagentTask, onUpdate?: (progress: string) => void): Promise<SubagentResult> {
		const def = this.registry.get(task.agentName);
		if (!def) {
			return {
				taskId: task.id,
				agentName: task.agentName,
				success: false,
				finalOutput: "",
				error: `Unknown subagent: ${task.agentName}`,
				durationMs: 0,
			};
		}

		const model = this.getModel(def.model);
		const tools = this.resolveTools(def.tools, task.parentContext.cwd);
		const recorder = new SubagentRecorder(task, this.recordToMongo);

		const agent = new Agent({
			initialState: {
				systemPrompt: def.systemPrompt,
				model,
				thinkingLevel: def.thinkingLevel ?? "off",
				tools,
				messages: [],
				isStreaming: false,
				streamMessage: null,
				pendingToolCalls: new Set<string>(),
			},
			streamFn: this.streamFn,
			getApiKey: this.getApiKey,
			sessionId: task.id,
		});

		const abort = new AbortController();
		this.running.set(task.id, { agent, abort });

		if (task.abortSignal) {
			if (task.abortSignal.aborted) {
				abort.abort();
			} else {
				task.abortSignal.addEventListener("abort", () => abort.abort(), { once: true });
			}
		}

		const start = Date.now();
		let finalOutput = "";
		let usage: { promptTokens: number; completionTokens: number } | undefined;

		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end") {
				const msg = event.message as AgentMessage;
				recorder.record(msg);
				if (msg.role === "assistant") {
					const asstMsg = msg as { usage?: { input: number; output: number } };
					if (asstMsg.usage) {
						usage = { promptTokens: asstMsg.usage.input, completionTokens: asstMsg.usage.output };
					}
					const text = extractLastAssistantText(msg);
					if (text) finalOutput = text;
				}
			}
			// Forward live progress to the parent's onUpdate callback.
			// This drives pi's tool_execution_update SSE event, which arp translates
			// into reasoning_content chunks so the UI shows subagent activity live.
			if (onUpdate) {
				const progress = formatProgressEvent(task.agentName, event);
				if (progress) onUpdate(progress);
			}
		});

		try {
			await agent.prompt(task.prompt);
			unsubscribe();

			const result: SubagentResult = {
				taskId: task.id,
				agentName: task.agentName,
				success: true,
				finalOutput: finalOutput || "(no output)",
				usage,
				durationMs: Date.now() - start,
			};
			await recorder.flush(result.finalOutput, true, result.durationMs);
			return result;
		} catch (err) {
			unsubscribe();
			const result: SubagentResult = {
				taskId: task.id,
				agentName: task.agentName,
				success: false,
				finalOutput: "",
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - start,
			};
			await recorder.flush(result.error ?? "", false, result.durationMs);
			return result;
		} finally {
			this.running.delete(task.id);
		}
	}

	async executeAll(tasks: SubagentTask[], onUpdate?: (progress: string) => void): Promise<SubagentResult[]> {
		return mapWithConcurrencyLimit(tasks, this.globalConcurrencyLimit, (t) => this.execute(t, onUpdate));
	}

	abort(taskId: string): void {
		const entry = this.running.get(taskId);
		if (entry) entry.abort.abort();
	}

	abortAll(): void {
		for (const { abort } of this.running.values()) {
			abort.abort();
		}
	}

	createTask(agentName: string, prompt: string, parentContext: SubagentTask["parentContext"]): SubagentTask {
		return {
			id: generateTaskId(),
			agentName,
			prompt,
			parentContext,
		};
	}
}

const MAX_PROGRESS_LEN = 400;

/**
 * Format a subagent event as a progress string for live UI streaming.
 *
 * Boundary events (thinking_start/text_start/tool lifecycle) emit a prefixed
 * header line ending in a newline. Content deltas are forwarded raw so the
 * UI concatenates them into a continuous paragraph - prefixing every delta
 * would fragment the display word-by-word.
 */
function formatProgressEvent(agentName: string, event: AgentEvent): string | undefined {
	switch (event.type) {
		case "message_update": {
			const e = event.assistantMessageEvent;
			switch (e.type) {
				case "thinking_start":
					return `\n[${agentName} | thinking] `;
				case "thinking_delta":
					return e.delta ? truncate(e.delta) : undefined;
				case "text_start":
					return `\n[${agentName} | output] `;
				case "text_delta":
					return e.delta ? truncate(e.delta) : undefined;
				default:
					return undefined;
			}
		}
		case "tool_execution_start":
			return `\n[${agentName}] tool: ${event.toolName}\n`;
		case "tool_execution_end":
			return `\n[${agentName}] tool ${event.toolName} ${event.isError ? "failed" : "done"}\n`;
		default:
			return undefined;
	}
}

function truncate(text: string): string {
	if (text.length <= MAX_PROGRESS_LEN) return text;
	return `${text.slice(0, MAX_PROGRESS_LEN)}...`;
}
