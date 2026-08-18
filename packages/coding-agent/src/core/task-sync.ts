/**
 * TaskSync — pi 端任务队列访问层。
 *
 * 直接读写 MongoDB `taskqueues` 集合（与 arp/LibreChat 共享），与
 * conversation-service 的消息持久化模式一致：
 * - 无 ARP_HOST 网络依赖（容器内 localhost 不可达宿主机的问题不复存在）
 * - 无 api-key 认证耦合（MongoDB 连接本身就是信任边界）
 * - 前端通知由 ConversationTaskList 轮询 + arp REST 端点完成
 */

import { createTaskInMongo, findTasksByConversation, isMongoEnabled, updateTaskStatusInMongo } from "./mongo/index.js";

export interface CreateTaskParams {
	toUserId: string;
	fromAgentId?: string;
	title: string;
	description?: string;
	type?: "ai_pending" | "collaboration" | "manual" | "subagent";
	formType?: "free_text" | "choice" | "form" | "confirmation";
	choices?: { label: string; value: string; description?: string; isCancel?: boolean }[];
	fields?: TaskFormField[];
	sourceConversationId?: string;
	sourceSessionId?: string;
	sourceTurnSeq?: number;
	priority?: "low" | "medium" | "high";
	subagentTaskId?: string;
	subagentName?: string;
}

export interface TaskFormField {
	name: string;
	label: string;
	fieldType: "text" | "textarea" | "number" | "select" | "multiselect" | "date";
	required?: boolean;
	options?: string[];
	default?: unknown;
}

export interface TaskQueueItem {
	_id: string;
	toUserId: string;
	fromUserId: string;
	title: string;
	description?: string;
	status: string;
	type: string;
	formType?: string;
	choices?: { label: string; value: string; description?: string; isCancel?: boolean }[];
	fields?: TaskFormField[];
	formResponse?: Record<string, unknown>;
	sourceConversationId?: string;
	sourceSessionId?: string;
	resultSummary?: string;
	userResponse?: string;
	subagentTaskId?: string;
	subagentName?: string;
	createdAt: string;
	updatedAt: string;
}

export class TaskSync {
	isEnabled(): boolean {
		return isMongoEnabled();
	}

	/** Create a task. Returns the new task _id, or null on failure. */
	async createTask(params: CreateTaskParams): Promise<string | null> {
		const doc = await createTaskInMongo({
			toUserId: params.toUserId,
			fromUserId: params.toUserId, // AI-created tasks: creator identity is the target user
			fromAgentId: params.fromAgentId,
			title: params.title,
			description: params.description,
			type: params.type ?? "ai_pending",
			priority: params.priority,
			formType: params.formType,
			choices: params.choices,
			fields: params.fields as Array<Record<string, unknown>> | undefined,
			sourceConversationId: params.sourceConversationId,
			sourceSessionId: params.sourceSessionId,
			sourceTurnSeq: params.sourceTurnSeq,
			subagentTaskId: params.subagentTaskId,
			subagentName: params.subagentName,
		});
		return doc ? String(doc._id) : null;
	}

	async getTasksByConversation(conversationId: string, status?: string): Promise<TaskQueueItem[]> {
		const docs = await findTasksByConversation(conversationId, status);
		return docs.map((d) => ({
			_id: String(d._id),
			toUserId: d.toUserId as string,
			fromUserId: d.fromUserId as string,
			title: d.title as string,
			description: d.description as string | undefined,
			status: (d.status as string) ?? "pending",
			type: (d.type as string) ?? "ai_pending",
			formType: d.formType as string | undefined,
			choices: d.choices as TaskQueueItem["choices"],
			fields: d.fields as TaskFormField[] | undefined,
			formResponse: d.formResponse as Record<string, unknown> | undefined,
			sourceConversationId: d.sourceConversationId as string | undefined,
			sourceSessionId: d.sourceSessionId as string | undefined,
			resultSummary: d.resultSummary as string | undefined,
			userResponse: d.userResponse as string | undefined,
			subagentTaskId: d.subagentTaskId as string | undefined,
			subagentName: d.subagentName as string | undefined,
			createdAt: String(d.createdAt ?? ""),
			updatedAt: String(d.updatedAt ?? ""),
		}));
	}

	async getPendingTasks(conversationId: string): Promise<TaskQueueItem[]> {
		return this.getTasksByConversation(conversationId, "waiting_agent");
	}

	async updateTaskStatus(taskId: string, status: string, resultSummary?: string): Promise<boolean> {
		return updateTaskStatusInMongo(taskId, status, resultSummary);
	}

	async startTask(taskId: string): Promise<boolean> {
		return updateTaskStatusInMongo(taskId, "running");
	}

	async completeTask(taskId: string, resultSummary: string): Promise<boolean> {
		return updateTaskStatusInMongo(taskId, "completed", resultSummary);
	}
}
