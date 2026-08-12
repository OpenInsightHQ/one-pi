import type { AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ConversationPersistenceContext } from "../mongo/conversation-service.js";

export interface SubagentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxConcurrency?: number;
}

export interface ParentContext {
	sessionId: string;
	userId: string;
	agentId: string;
	cwd: string;
}

export interface SubagentTask {
	id: string;
	agentName: string;
	prompt: string;
	parentContext: ParentContext;
	abortSignal?: AbortSignal;
}

export interface SubagentResult {
	taskId: string;
	agentName: string;
	success: boolean;
	finalOutput: string;
	error?: string;
	usage?: { promptTokens: number; completionTokens: number };
	durationMs: number;
}

export type MongoRecorder = {
	ctx: ConversationPersistenceContext;
	saveMessage: (message: AgentMessage, parentMessageId: string) => Promise<string | null>;
};

export interface SubagentSchedulerOptions {
	globalConcurrencyLimit?: number;
	getModel: (modelId?: string) => Model<any>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	resolveTools: (names: string[], cwd: string) => AgentTool<any>[];
	recordToMongo?: MongoRecorder;
}
