import { Schema } from "mongoose";
import type {
	AccessRoleDoc,
	AclEntryDoc,
	AgentDoc,
	ConversationDoc,
	McpServerDoc,
	MemoryEntryDoc,
	MessageDoc,
	RoleDoc,
	SkillCredentialDoc,
	SkillDoc,
	SystemPromptDoc,
	TaskQueueDoc,
	UserDoc,
	UserRoleDoc,
} from "./types.js";

/**
 * Mongoose schemas for the ACL / skill collections.
 *
 * These mirror the on-disk shape written by the Java/yudao backend that shares
 * the MongoDB instance with arp (LibreChat). We use `{ strict: false }` so
 * extra Java-specific fields (like `_class`, `__v`) are preserved on read and
 * never stripped on write.
 *
 * Collection names are set explicitly to match the existing collections.
 */

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

export const skillSchema = new Schema<SkillDoc>(
	{
		skillType: { type: String },
		name: { type: String, required: true },
		displayName: { type: String },
		description: { type: String },
		category: { type: String },
		savePath: { type: String },
		author: { type: Schema.Types.ObjectId },
		creatorUserId: { type: Number },
		tenantId: { type: Number },
		status: { type: Number, default: 1 },
		requiresCredentials: { type: Boolean },
		userManaged: { type: Boolean },
		credentialSchema: { type: [Schema.Types.Mixed], default: undefined },
		apiDefinitions: { type: [Schema.Types.Mixed], default: undefined },
		credentialRef: { type: String },
		source: { type: String },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "skills" },
);

// ---------------------------------------------------------------------------
// mcpservers (shared with arp/LibreChat; credential fields written by dmp/arp)
// ---------------------------------------------------------------------------

export const mcpServerSchema = new Schema<McpServerDoc>(
	{
		serverName: { type: String, required: true },
		config: { type: Schema.Types.Mixed },
		author: { type: Schema.Types.ObjectId },
		isPiSkill: { type: Boolean },
		requiresCredentials: { type: Boolean },
		userManaged: { type: Boolean },
		credentialSchema: { type: [Schema.Types.Mixed], default: undefined },
		credentialBinding: { type: Schema.Types.Mixed, default: undefined },
		credentialRef: { type: String },
		_class: { type: String },
	},
	// Collection is owned by arp/LibreChat; strict:false preserves arp-written
	// fields (user vars, trusted, tools cache, ...).
	{ strict: false, timestamps: true, collection: "mcpservers" },
);
mcpServerSchema.index({ serverName: 1 });

// ---------------------------------------------------------------------------
// skillcredentials (AES-256-GCM encrypted skill/MCP credentials)
// ---------------------------------------------------------------------------

export const skillCredentialSchema = new Schema<SkillCredentialDoc>(
	{
		userId: { type: Schema.Types.ObjectId, required: true },
		resourceType: { type: String, required: true, enum: ["skill", "mcp", "credential"] },
		resourceName: { type: String, required: true },
		cipher: { type: String, default: "aes-256-gcm" },
		iv: { type: String, required: true },
		authTag: { type: String, required: true },
		data: { type: String, required: true },
		keyVersion: { type: Number, default: 1 },
		lastVerifiedAt: { type: Date, default: null },
		status: { type: String, default: "active" },
		schemaJson: { type: String },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "skillcredentials" },
);
// One credential document per (principal, resource).
skillCredentialSchema.index({ userId: 1, resourceType: 1, resourceName: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// accessroles
// ---------------------------------------------------------------------------

export const accessRoleSchema = new Schema<AccessRoleDoc>(
	{
		accessRoleId: { type: String, required: true },
		name: { type: String, required: true },
		description: { type: String },
		permBits: { type: Number, required: true },
		resourceType: { type: String, required: true },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "accessroles" },
);

// ---------------------------------------------------------------------------
// aclentries
// ---------------------------------------------------------------------------

export const aclEntrySchema = new Schema<AclEntryDoc>(
	{
		principalType: { type: String, required: true },
		principalId: { type: Schema.Types.Mixed },
		principalModel: { type: String },
		resourceType: { type: String, required: true },
		resourceId: { type: Schema.Types.ObjectId, required: true },
		permBits: { type: Number, default: 1 },
		roleId: { type: Schema.Types.ObjectId },
		grantedBy: { type: Schema.Types.ObjectId },
		grantedAt: { type: Date, default: Date.now },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "aclentries" },
);

aclEntrySchema.index({ resourceType: 1, resourceId: 1 });
aclEntrySchema.index({ principalType: 1, principalId: 1 });
aclEntrySchema.index({ principalType: 1, resourceType: 1, permBits: 1 });

// ---------------------------------------------------------------------------
// userroles  (maps userId → role names, same pattern as arp)
// ---------------------------------------------------------------------------

export const userRoleSchema = new Schema<UserRoleDoc>(
	{
		userId: { type: Schema.Types.ObjectId },
		roleNames: { type: [String], default: [] },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "userroles" },
);

// ---------------------------------------------------------------------------
// roles  (role name → ObjectId lookup)
// ---------------------------------------------------------------------------

export const roleSchema = new Schema<RoleDoc>(
	{
		name: { type: String },
		description: { type: String },
		permissions: { type: Schema.Types.Mixed },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "roles" },
);
roleSchema.index({ name: 1 });

// ---------------------------------------------------------------------------
// users (shared with arp/LibreChat; read-only for pi: role + memory opt-out)
// ---------------------------------------------------------------------------

export const userSchema = new Schema<UserDoc>(
	{
		role: { type: String },
		roles: { type: [String], default: undefined },
		personalization: {
			type: { memories: { type: Boolean } },
			default: undefined,
		},
		username: { type: String },
	},
	// Collection is owned by arp/LibreChat; strict:false so arp-written fields
	// are preserved on read. Indexes are owned by the arp model definition.
	{ strict: false, timestamps: true, collection: "users" },
);

// ---------------------------------------------------------------------------
// systemprompts (shared with arp/LibreChat; read-only for pi)
// ---------------------------------------------------------------------------

export const systemPromptSchema = new Schema<SystemPromptDoc>(
	{
		key: { type: String, required: true },
		description: { type: String },
		category: { type: String },
		content: { type: String },
		defaultContent: { type: String },
		changeNote: { type: String },
		isSystem: { type: Boolean },
		piPrompt: { type: Boolean },
		piSavePath: { type: String },
		updatedBy: { type: String },
		versionHistory: { type: [Schema.Types.Mixed], default: undefined },
		_class: { type: String },
	},
	// Read-only for pi (arp/dmp own the documents); strict:false preserves
	// Java-backend fields. timestamps:false: the collection uses its own fields.
	{ strict: false, timestamps: false, collection: "systemprompts" },
);

// ---------------------------------------------------------------------------
// memoryentries (shared with arp/LibreChat; read-only for pi)
// ---------------------------------------------------------------------------

export const memoryEntrySchema = new Schema<MemoryEntryDoc>(
	{
		userId: { type: Schema.Types.ObjectId, required: true },
		key: { type: String, required: true },
		value: { type: String, required: true },
		tokenCount: { type: Number, default: 0 },
		type: { type: String, default: "knowledge" },
		source: {
			type: {
				from: { type: String, default: "auto" },
				conversationId: { type: String, default: null },
				messageIds: { type: [String], default: undefined },
			},
			default: undefined,
		},
		weight: {
			type: { importance: { type: Number, default: 0.5 } },
			default: undefined,
		},
		last_accessed_at: { type: Date, default: null },
		updated_at: { type: Date },
	},
	// Read-only for pi (arp owns the documents); timestamps:false — the
	// collection uses `updated_at` instead of mongoose timestamps.
	{ strict: false, timestamps: false, collection: "memoryentries" },
);

// ---------------------------------------------------------------------------
// agents (shared with arp/LibreChat)
// ---------------------------------------------------------------------------

export const agentSchema = new Schema<AgentDoc>(
	{
		id: { type: String, required: true },
		name: { type: String },
		description: { type: String },
		skills: { type: [{ name: String, description: String }], default: undefined },
	},
	// Collection is owned by arp/LibreChat; strict:false so arp-written fields
	// are preserved on read. Indexes are owned by the arp model definition.
	{ strict: false, timestamps: true, collection: "agents" },
);

// ---------------------------------------------------------------------------
// messages (shared with arp/LibreChat)
// ---------------------------------------------------------------------------

export const messageSchema = new Schema<MessageDoc>(
	{
		messageId: { type: String, required: true },
		conversationId: { type: String, required: true },
		user: { type: String, required: true },
		model: { type: String, default: null },
		endpoint: { type: String },
		parentMessageId: { type: String },
		tokenCount: { type: Number },
		inputTokenCount: { type: Number },
		inputTokens: { type: Number },
		outputTokens: { type: Number },
		cacheReadTokens: { type: Number },
		cacheWriteTokens: { type: Number },
		totalInputTokens: { type: Number },
		totalOutputTokens: { type: Number },
		totalCacheReadTokens: { type: Number },
		totalCacheWriteTokens: { type: Number },
		sender: { type: String },
		text: { type: String },
		streamLog: { type: String },
		isCreatedByUser: { type: Boolean, default: false },
		unfinished: { type: Boolean, default: false },
		error: { type: Boolean, default: false },
		finish_reason: { type: String },
		recursionLimit: { type: String },
		content: { type: [Schema.Types.Mixed], default: undefined },
		attachments: { type: [Schema.Types.Mixed], default: undefined },
		files: { type: [Schema.Types.Mixed], default: undefined },
		expiredAt: { type: Date },
		agentMessage: { type: Schema.Types.Mixed },
	},
	{ strict: false, timestamps: true, collection: "messages" },
);

// Enforce one document per (messageId, user). Concurrent upserts racing the
// findOneAndUpdate in saveMessageToMongo previously inserted duplicate docs
// with the same messageId (e.g. abort finalizing two assistant messages at
// once), forking the LibreChat message tree. Same index as arp's message
// schema declaration — declared here so pi builds it on shared databases
// where arp's autoIndex never created it.
messageSchema.index({ messageId: 1, user: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// conversations (shared with arp/LibreChat)
// ---------------------------------------------------------------------------

export const conversationSchema = new Schema<ConversationDoc>(
	{
		conversationId: { type: String, required: true },
		user: { type: String },
		messages: [{ type: Schema.Types.ObjectId, ref: "Message" }],
		title: { type: String, default: "New Chat" },
		endpoint: { type: String },
		endpointType: { type: String },
		model: { type: String },
		agent_id: { type: String },
		isArchived: { type: Boolean, default: false },
		tags: { type: [String], default: [] },
		files: { type: [String] },
		maxContextTokens: { type: Number },
		resendFiles: { type: Boolean },
		toolCallVisible: { type: Boolean },
		finish_reason: { type: String },
		cwd: { type: String },
		totalInputTokens: { type: Number },
		totalOutputTokens: { type: Number },
		totalCacheReadTokens: { type: Number },
		totalCacheWriteTokens: { type: Number },
		expiredAt: { type: Date },
	},
	{ strict: false, timestamps: true, collection: "conversations" },
);

// ---------------------------------------------------------------------------
// taskqueues (shared with arp/LibreChat)
// ---------------------------------------------------------------------------

export const taskQueueSchema = new Schema<TaskQueueDoc>(
	{
		toUserId: { type: String, required: true },
		toAgentId: { type: String },
		fromUserId: { type: String, required: true },
		fromAgentId: { type: String },
		sourceConversationId: { type: String },
		sourceSessionId: { type: String },
		sourceTurnSeq: { type: Number },
		type: { type: String, default: "ai_pending" },
		title: { type: String, required: true },
		description: { type: String },
		status: { type: String, default: "pending" },
		priority: { type: String, default: "medium" },
		formType: { type: String, default: "free_text" },
		choices: { type: [Schema.Types.Mixed], default: undefined },
		fields: { type: [Schema.Types.Mixed], default: undefined },
		formResponse: { type: Schema.Types.Mixed, default: {} },
		subagentTaskId: { type: String },
		subagentName: { type: String },
		metadata: { type: Schema.Types.Mixed, default: {} },
		resultSummary: { type: String },
		userResponse: { type: String },
		callbackUrl: { type: String },
		completedAt: { type: Date },
		expiresAt: { type: Date },
	},
	// Indexes are owned by the arp/LibreChat model definition; strict:false so
	// fields written by arp routes (e.g. fromUserName joins) are never stripped.
	{ strict: false, timestamps: true, collection: "taskqueues" },
);
