# Subagent 调度池 + 任务服务 详细设计

## 背景

pi-agent-github 核心设计哲学是最小内核（README.md:401-417），无 subagent、无 plan mode、无 todo。
本设计在 pi 核心之上新增三层能力，为后续 workflow 编排打基础。

## Stream 重连（已由 arp-github 实现，无需重做）

arp-github 的 `ResumableAgentController`（`api/server/controllers/agents/request.js:57`）+ `GenerationJobManager`
已完整覆盖：
- 后台持续执行（res.json 返回 streamId 后异步执行）
- 事件缓冲 + 重放（GenerationJobManager.emitChunk/subscribe）
- 断线重连（`useResumableSSE.ts` 指数退避 + `?resume=true` sync 事件）
- 导航恢复（`useResumeOnLoad.ts` + `/api/agents/chat/status/:conversationId`）
- pi endpoint 完全走这条路径（`request.js:72` isPIEndpoint 标记，跳过 arp 端消息保存但保留事件缓冲）

---

## 模块二：In-process Subagent 调度池（pi-agent-github）

### 目标

- 父 agent 可派发子任务给 subagent（数字员工）
- subagent 有独立上下文，中间过程不污染父会话
- 只把最终结果回传父会话（节省 token）
- subagent 可并行/串行
- messages 表清晰记录，可追溯但不膨胀父上下文

### 关键决策

基于裸 `Agent` 类（`packages/agent/src/agent.ts:116`），不用 `AgentSession`（太重）。

Agent 实例全部状态都是 per-instance（`agent.ts:117-154`）：`_state`、`listeners`、`abortController`、
`steeringQueue`、`followUpQueue`、`runningPrompt`。无全局可变状态冲突。

共享：`streamFn`、`getApiKey`、`model`（凭证和 provider 配置复用父级）。
不进 `sessionStore`，不写 JSONL。

### 文件结构

```
packages/coding-agent/src/core/subagent/
├── index.ts        # 公共 API 导出
├── types.ts        # SubagentDefinition, SubagentTask, SubagentResult
├── scheduler.ts    # SubagentScheduler 调度器（并发池）
├── registry.ts     # 数字员工注册表（默认角色）
├── recorder.ts     # subagent 执行记录到 MongoDB messages 的策略
└── tool.ts         # subagent 工具注册（父 agent 可调用）
```

### types.ts

```typescript
import type { AgentTool, Model, AgentMessage, ThinkingLevel } from "@pi-agent/agent-core";

// 数字员工定义（注册表中的角色）
export interface SubagentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];              // 工具名（从父级工具解析）
	model?: string;               // 指定模型（如 explorer 用小模型省 token）
	thinkingLevel?: ThinkingLevel;
	maxConcurrency?: number;      // 此角色最大并发实例数（默认 2）
}

// 子任务
export interface SubagentTask {
	id: string;                   // UUID
	agentName: string;            // 用哪个数字员工
	prompt: string;
	cwd?: string;                 // 默认继承父级
	parentContext: ParentContext;  // 父会话信息
	abortSignal?: AbortSignal;
}

export interface ParentContext {
	sessionId: string;            // 父会话 ID（= conversationId）
	userId: string;
	agentId: string;
}

// 子任务结果
export interface SubagentResult {
	taskId: string;
	agentName: string;
	success: boolean;
	finalOutput: string;          // 只取最后一条 assistant text
	error?: string;
	usage?: { promptTokens: number; completionTokens: number };
	durationMs: number;
}
```

### scheduler.ts 核心逻辑

```typescript
export class SubagentScheduler {
	private registry = new Map<string, SubagentDefinition>();
	private running = new Map<string, { agent: Agent; abort: AbortController }>();
	private globalConcurrencyLimit: number;

	constructor(opts: {
		globalConcurrencyLimit?: number;        // 默认 4
		getModel: () => Model<any>;
		streamFn: StreamFunction;
		getApiKey: GetApiKeyFunction;
		resolveTools: (names: string[]) => AgentTool<any>[];
		recordToMongo?: MongoRecorder;
	}) { ... }

	register(def: SubagentDefinition): void;

	async execute(task: SubagentTask): Promise<SubagentResult>;

	async executeAll(tasks: SubagentTask[], mode: "parallel" | "serial"): Promise<SubagentResult[]>;

	abort(taskId: string): void;

	abortAll(): void;
}
```

execute() 流程：
1. 从 registry 取 SubagentDefinition
2. resolveTools(names) 从父级工具集获取工具实例
3. `new Agent({ initialState: { systemPrompt, model, thinkingLevel, tools, messages: [task] } })`
4. subscribe 收集 message_end 事件 → extractLastAssistantText
5. 每条 message_end 调 recorder 写 MongoDB（带 isSubagentTrace 标记）
6. await agent.prompt([])
7. 返回 SubagentResult（只含 finalOutput）

### messages 表记录策略（recorder.ts）

**设计原则：** 父会话只看到 subagent 的最终结果（作为 tool_result），
subagent 完整内部过程作为独立可追溯记录写入 MongoDB，但不进入父会话的上下文重建。

#### 父会话 messages（主上下文）

subagent 调度作为一个 tool，父 agent 通过工具调用触发。父会话 messages 中只记录：

```
1. assistant 消息含 tool_call: { name: "subagent", args: { agentName, prompt } }
2. toolResult 消息：只含 result.finalOutput（摘要）
```

#### subagent 独立记录（追溯用）

subagent 每条内部消息写入 messages 表，用 metadata 标记：

```javascript
{
  messageId: "sub_<uuid>_<seq>",
  conversationId: parentSessionId,       // 同一会话，便于按会话查询
  parentMessageId: "sub_<uuid>_<seq-1>",
  user: parentUserId,
  role: "assistant" | "user" | "toolResult",
  text: "...",
  endpoint: "pi-subagent",               // 新增 endpoint 值
  metadata: {
    isSubagentTrace: true,
    subagentTaskId: task.id,
    subagentName: task.agentName,
    subagentSeq: seq,
  },
}
```

#### 父会话上下文重建时过滤

`loadConversationMessages`（conversation-service.ts:564）增加查询条件：

```typescript
"metadata.isSubagentTrace": { $ne: true }
```

效果：
- 父 agent 上下文干净（只看到 tool_call + tool_result 摘要）
- 可追溯（前端 `GET /api/messages?conversationId=X` 拉子记录，用 metadata.isSubagentTrace 过滤）
- token 节省（subagent 中间过程不消耗父上下文）

### tool.ts（父 agent 工具注册）

在 `AgentSession._refreshToolRegistry`（agent-session.ts:2329）注入 subagent 工具：

```typescript
const subagentTool: AgentTool = {
	name: "subagent",
	label: "Subagent",
	description: "Delegate a subtask to a specialized subagent with isolated context.",
	parameters: z.object({
		agentName: z.string().describe("Which subagent to use"),
		prompt: z.string().describe("The task"),
		mode: z.enum(["single", "parallel"]).optional().default("single"),
		tasks: z.array(z.object({ agentName: z.string(), prompt: z.string() })).optional(),
	}),
	async execute(args, ctx) {
		// single 模式：一个 subagent
		// parallel 模式：scheduler.executeAll()
		// 返回 finalOutput 或汇总
	},
};
```

### registry.ts 默认角色

```typescript
export const DEFAULT_SUBAGENTS: SubagentDefinition[] = [
	{
		name: "explorer",
		description: "Fast read-only codebase reconnaissance. Finds files, code patterns, and structure.",
		systemPrompt: "You are a fast codebase explorer...",
		tools: ["read", "grep", "find", "ls"],
		model: undefined,              // 继承父级或用小模型
		thinkingLevel: "off",
	},
	{
		name: "coder",
		description: "Writes and modifies code files.",
		systemPrompt: "You are a focused code writer...",
		tools: ["read", "write", "edit", "bash", "grep"],
	},
	{
		name: "reviewer",
		description: "Reviews code for bugs, style, and improvements.",
		systemPrompt: "You are a code reviewer...",
		tools: ["read", "grep", "find"],
	},
];
```

### agent-session.ts 集成点

在 `createAgentSession`（sdk.ts:204）中创建 SubagentScheduler 实例，
传入父级 model/streamFn/getApiKey/tools，
挂到 AgentSession 上供 tool.ts 的 execute 回调访问。

---

## 模块三：任务服务（arp-github TaskQueue 扩展 + pi TaskSync）

### 现状

`api/models/TaskQueue.js`（101 行）已有 schema：
- toUserId / fromUserId / toAgentId / fromAgentId
- type: ai_pending | collaboration | manual
- status: pending | accepted | in_progress | completed | rejected | dismissed
- title / description / metadata / resultSummary / userResponse
- sourceConversationId / sourceSessionId

不足：无结构化表单、无 subagent 关联、状态机不完整、无会话内按轮次查询。

### 3.1 schema 扩展（api/models/TaskQueue.js）

新增字段（全部可选，向后兼容）：

```javascript
// 结构化表单
formType: { type: String, enum: ['free_text', 'choice', 'form', 'confirmation'], default: 'free_text' },
choices: [{ label: String, value: String, description: String }],
fields: [{
	name: String, label: String,
	type: { type: String, enum: ['text', 'textarea', 'number', 'select', 'multiselect', 'date'] },
	required: Boolean, options: [String], default: Schema.Types.Mixed,
}],
formResponse: { type: Schema.Types.Mixed, default: {} },

// subagent 关联
subagentTaskId: String,
subagentName: String,

// 来源轮次（stream 中按轮次带出任务列表）
sourceTurnSeq: Number,

// 状态扩展
// status enum 增加: waiting_agent, running, failed, aborted
```

索引补充：
```javascript
schema.index({ sourceConversationId: 1, sourceTurnSeq: 1 });
schema.index({ subagentTaskId: 1 });
```

### 3.2 状态机

```
pending ──accepted──► in_progress ──► waiting_agent ──► running ──► completed
  │                     │                                          │
  ├──dismissed          ├──rejected                                ├──failed
  └──rejected           └──completed                               └──aborted
```

| 状态 | 含义 | 谁触发 |
|------|------|--------|
| pending | 待处理 | AI 创建任务 |
| accepted | 已接受 | 人/agent 确认 |
| in_progress | 处理中 | 人/agent 开始处理 |
| waiting_agent | 等待 AI 处理 | 人提交表单后 |
| running | AI 执行中 | pi 开始执行 |
| completed | 完成 | 处理方完成 |
| rejected/dismissed/failed/aborted | 终态 | 各方 |

### 3.3 新增 API 端点（api/server/routes/taskQueue.js）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/task-queue/by-conversation/:conversationId` | 按会话拉任务列表 |
| POST | `/api/task-queue/:taskId/submit` | 提交表单响应，状态 → waiting_agent |
| POST | `/api/task-queue/:taskId/start` | pi 开始处理，状态 → running |

### 3.4 pi 端 TaskSync（packages/coding-agent/src/core/task-sync.ts）

pi 端**直接读写 MongoDB `taskqueues` 集合**（`mongo/task-queue-service.ts`），与
messages/conversations 持久化模式一致：

- 无 ARP_HOST 网络依赖（避免容器内 localhost 不可达宿主机的问题）
- 无 api-key 认证耦合（MongoDB 连接即信任边界，同消息写入）
- arp REST 端点保留给前端/管理用途；pi 是 AI 侧写路径

```typescript
export class TaskSync {
	isEnabled(): boolean;                          // = isMongoEnabled()
	async createTask(params): Promise<string>;     // 直插 taskqueues
	async getTasksByConversation(convId, status?); // 直查
	async getPendingTasks(convId);                 // waiting_agent 状态
	async updateTaskStatus(taskId, status, summary?);
	async startTask(taskId);                       // → running
	async completeTask(taskId, summary);           // → completed
}
```

### 3.5 create_task 工具（pi 端）

在父 agent 工具集中新增 `create_task` 工具，让 AI 能主动创建任务节点：

```typescript
const createTaskTool: AgentTool = {
	name: "create_task",
	label: "Create Task",
	description: "Create a task that waits for human or agent processing.",
	parameters: z.object({
		title: z.string(),
		description: z.string().optional(),
		formType: z.enum(['free_text', 'choice', 'form', 'confirmation']).default('free_text'),
		choices: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
		toUserId: z.string().optional(),  // 默认父会话用户；可指定他人
	}),
};
```

AI 调用 create_task → TaskSync.createTask → POST /api/task-queue。
下一轮 pi prompt 时，检查 waiting_agent 任务，注入用户响应。

---

## 模块四：前端任务面板（arp-github）

### 现状

`client/src/components/ArtifactsGallery/TaskCenterPanel.tsx` 已存在（全局任务中心），
但非实时、无表单、无会话内嵌入。

### 4.1 SSE task_update 事件

复用 pi 的 SSE 流（走 arp 的 GenerationJobManager）。
pi 端在 AI 调用 create_task 工具时，tool_end 事件中携带任务信息。
arp 端在 SSE 事件翻译层（`controllers/pi/chatCompletions.js` streamFromPI）将 tool_end 中的
task 信息转为 task_update 事件推给前端。

### 4.2 会话内任务列表组件

新建 `client/src/components/Chat/TaskList/ConversationTaskList.tsx`：
- 用 `getTasksByConversation(conversationId)` 拉取
- 订阅 task_update 事件自动 refetch
- 按状态分组展示（pending / in_progress / completed）
- 嵌入 ChatView 消息流下方

### 4.3 任务表单组件

新建 `client/src/components/Chat/TaskList/TaskForm.tsx`：
- 根据 formType 渲染：free_text → textarea；choice → 单选 + 补充输入；form → 动态字段；confirmation → 确认/拒绝
- 提交 → POST /api/task-queue/:taskId/submit

### 4.4 data-provider 函数

在 `packages/data-provider/src/data-service.ts` 新增：
- `getTasksByConversation(conversationId)`
- `submitTaskQueueItem(taskId, formResponse)`

在 `packages/data-provider/src/api-endpoints.ts` 新增对应 URL。

---

## 实施顺序

1. 模块二 Subagent 调度池（pi-agent-github）→ 核心执行能力
2. 模块三 TaskQueue 扩展 + TaskSync → 任务协作能力
3. 模块四 前端面板 → 用户交互层

每模块可独立测试，不互相阻塞。
