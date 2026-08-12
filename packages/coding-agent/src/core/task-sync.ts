/**
 * TaskSync — pi 端与 arp-github TaskQueue 的同步服务。
 *
 * pi 通过 arp-github 的 /api/task-queue REST API（api-key 认证）创建和更新任务。
 * arp-github 已有 TaskQueue schema 和 requireTaskQueueAuth 中间件（支持 api-key 回退）。
 */

export interface CreateTaskParams {
	toUserId: string;
	fromAgentId?: string;
	title: string;
	description?: string;
	type?: "ai_pending" | "collaboration" | "manual";
	formType?: "free_text" | "choice" | "form" | "confirmation";
	choices?: { label: string; value: string; description?: string }[];
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
	choices?: { label: string; value: string; description?: string }[];
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
	private arpHost: string;
	private apiKey: string;

	constructor(arpHost?: string, apiKey?: string) {
		this.arpHost = arpHost ?? process.env.ARP_HOST ?? "http://localhost:3080";
		this.apiKey = apiKey ?? process.env.PI_API_KEY ?? "";
	}

	isEnabled(): boolean {
		return this.apiKey.length > 0;
	}

	private headers(userId: string): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"api-key": this.apiKey,
			"x-user-id": userId,
		};
	}

	async createTask(params: CreateTaskParams): Promise<string | null> {
		if (!this.isEnabled()) return null;

		try {
			const response = await fetch(`${this.arpHost}/api/task-queue`, {
				method: "POST",
				headers: this.headers(params.toUserId),
				body: JSON.stringify(params),
			});

			if (!response.ok) {
				console.error("[TaskSync] createTask failed:", response.status, await response.text());
				return null;
			}

			const task = (await response.json()) as { _id: string };
			return task._id;
		} catch (err) {
			console.error("[TaskSync] createTask error:", err);
			return null;
		}
	}

	async getTasksByConversation(conversationId: string, userId: string, status?: string): Promise<TaskQueueItem[]> {
		if (!this.isEnabled()) return [];

		try {
			const url = new URL(`${this.arpHost}/api/task-queue/by-conversation/${conversationId}`);
			if (status) url.searchParams.set("status", status);

			const response = await fetch(url.toString(), {
				method: "GET",
				headers: this.headers(userId),
			});

			if (!response.ok) return [];

			const data = (await response.json()) as { tasks: TaskQueueItem[] };
			return data.tasks;
		} catch (err) {
			console.error("[TaskSync] getTasksByConversation error:", err);
			return [];
		}
	}

	async startTask(taskId: string, userId: string): Promise<void> {
		if (!this.isEnabled()) return;

		try {
			await fetch(`${this.arpHost}/api/task-queue/${taskId}/start`, {
				method: "POST",
				headers: this.headers(userId),
			});
		} catch (err) {
			console.error("[TaskSync] startTask error:", err);
		}
	}

	async completeTask(taskId: string, userId: string, resultSummary: string): Promise<void> {
		if (!this.isEnabled()) return;

		try {
			await fetch(`${this.arpHost}/api/task-queue/${taskId}`, {
				method: "PATCH",
				headers: this.headers(userId),
				body: JSON.stringify({ status: "completed", resultSummary }),
			});
		} catch (err) {
			console.error("[TaskSync] completeTask error:", err);
		}
	}

	async getPendingTasks(conversationId: string, userId: string): Promise<TaskQueueItem[]> {
		return this.getTasksByConversation(conversationId, userId, "waiting_agent");
	}

	async updateTaskStatus(taskId: string, userId: string, status: string, resultSummary?: string): Promise<void> {
		if (!this.isEnabled()) return;

		try {
			const body: Record<string, unknown> = { status };
			if (resultSummary) body.resultSummary = resultSummary;

			await fetch(`${this.arpHost}/api/task-queue/${taskId}`, {
				method: "PATCH",
				headers: this.headers(userId),
				body: JSON.stringify(body),
			});
		} catch (err) {
			console.error("[TaskSync] updateTaskStatus error:", err);
		}
	}
}
