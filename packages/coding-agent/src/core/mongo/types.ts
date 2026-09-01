/**
 * Shared types and constants for the MongoDB data layer.
 *
 * These mirror the ACL model used by the arp (LibreChat) system and the
 * Java/yudao backend that shares the same MongoDB instance.
 *
 * Three collections govern permissions:
 *   - `skills`       — skill metadata (name, savePath, status, ...)
 *   - `accessroles`  — role definitions (accessRoleId, permBits, resourceType)
 *   - `aclentries`   — per-principal grants (principalType, principalId, resourceId, permBits)
 */

// ---------------------------------------------------------------------------
// Principal / Resource enums
// ---------------------------------------------------------------------------

export const PrincipalType = {
	USER: "user",
	ROLE: "role",
	PUBLIC: "public",
	GROUP: "group",
} as const;
export type PrincipalType = (typeof PrincipalType)[keyof typeof PrincipalType];

export const PrincipalModel = {
	USER: "User",
	ROLE: "Role",
	GROUP: "Group",
} as const;
export type PrincipalModel = (typeof PrincipalModel)[keyof typeof PrincipalModel];

export const ResourceType = {
	SKILL: "skill",
	SYSTEM_PROMPT: "systemPrompt",
	// Future: MESSAGE, CONVERSATION, AGENT, ...
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

// ---------------------------------------------------------------------------
// Permission bitmask
// ---------------------------------------------------------------------------

export const PermissionBits = {
	VIEW: 1,
	EDIT: 2,
	DELETE: 4,
	SHARE: 8,
} as const;
export type PermissionBits = (typeof PermissionBits)[keyof typeof PermissionBits];

/** Convenience role-bit presets (bitwise OR of PermissionBits). */
export const RoleBits = {
	VIEWER: PermissionBits.VIEW,
	EDITOR: PermissionBits.VIEW | PermissionBits.EDIT,
	MANAGER: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
	OWNER: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
} as const;

/** Returns true when `permissions` has ALL bits in `required` set. */
export function hasPermissions(permissions: number, required: number): boolean {
	return (permissions & required) === required;
}

// ---------------------------------------------------------------------------
// Document interfaces (match the on-disk shape written by the Java backend)
// ---------------------------------------------------------------------------

export interface SkillDoc {
	_id: import("mongoose").Types.ObjectId;
	skillType: string;
	name: string;
	displayName?: string;
	description?: string;
	category?: string;
	savePath?: string;
	author?: import("mongoose").Types.ObjectId;
	creatorUserId?: number;
	tenantId?: number;
	status?: number;
	/** true = this skill requires bound credentials before execution */
	requiresCredentials?: boolean;
	/** true = users bind their own credentials (fallback: admin binding); false = admin-managed only */
	userManaged?: boolean;
	/** Declares which secret fields this skill needs (values live in `skillcredentials`) */
	credentialSchema?: CredentialSchemaField[];
	/** http skills: API definitions stored inline (former apis.json content) for pi direct-read */
	apiDefinitions?: Array<Record<string, unknown>>;
	/** How resolved credential values are injected (http skills: request headers) */
	credentialBinding?: CredentialBinding;
	/** Origin of the skill record (e.g. `skill-creator` for synced personal skills) */
	source?: string;
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

export interface AccessRoleDoc {
	_id: import("mongoose").Types.ObjectId;
	accessRoleId: string;
	name: string;
	description?: string;
	permBits: number;
	resourceType: string;
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

export interface AclEntryDoc {
	_id: import("mongoose").Types.ObjectId;
	principalType: PrincipalType;
	principalId?: import("mongoose").Types.ObjectId | null;
	principalModel?: PrincipalModel | string;
	resourceType: string;
	resourceId: import("mongoose").Types.ObjectId;
	permBits?: number;
	roleId?: import("mongoose").Types.ObjectId;
	grantedBy?: import("mongoose").Types.ObjectId;
	grantedAt?: Date;
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

export interface UserRoleDoc {
	_id: import("mongoose").Types.ObjectId;
	userId?: import("mongoose").Types.ObjectId;
	roleNames?: string[];
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

export interface RoleDoc {
	_id: import("mongoose").Types.ObjectId;
	name?: string;
	description?: string;
	/**
	 * LibreChat role permissions, keyed by permission type then permission
	 * (e.g. `MEMORIES: { USE: true, READ: true }`). Values are boolean flags
	 * merged with OR semantics across all of a user's roles.
	 */
	permissions?: Record<string, Record<string, boolean>>;
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

// ---------------------------------------------------------------------------
// User document (shared with arp/LibreChat `users` collection)
// ---------------------------------------------------------------------------

export interface UserDoc {
	_id: import("mongoose").Types.ObjectId;
	/** Primary role name (e.g. `ADMIN`, `USER`) */
	role?: string;
	/** Multi-role names, populated from the `userroles` collection at auth time */
	roles?: string[];
	personalization?: {
		/** false = user opted out of long-term memory injection */
		memories?: boolean;
	};
	username?: string;
	createdAt?: Date;
	updatedAt?: Date;
	__v?: number;
	_class?: string;
}

// ---------------------------------------------------------------------------
// SystemPrompt document (shared with arp/LibreChat `systemprompts` collection)
// ---------------------------------------------------------------------------

export interface SystemPromptDoc {
	_id: import("mongoose").Types.ObjectId;
	/** Globally unique prompt key, e.g. `pi.system`, `visualization.echarts` */
	key: string;
	description?: string;
	category?: string;
	/** Current prompt content (with `{{lang}}` placeholders, resolved by arp) */
	content?: string;
	/** Seed content for admin-side reset */
	defaultContent?: string;
	changeNote?: string;
	isSystem?: boolean;
	/** true = listed in pi's <available_prompts> section */
	piPrompt?: boolean;
	/** Absolute path of the prompt file on the pi server (readable via the read tool) */
	piSavePath?: string;
	updatedBy?: string;
	versionHistory?: Array<Record<string, unknown>>;
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

// ---------------------------------------------------------------------------
// MemoryEntry document (shared with arp/LibreChat `memoryentries` collection)
// ---------------------------------------------------------------------------

export type MemoryType = "profile" | "preference" | "constraint" | "knowledge";

export interface MemorySourceDoc {
	from?: "auto" | "manual";
	conversationId?: string | null;
	messageIds?: string[];
}

export interface MemoryEntryDoc {
	_id: import("mongoose").Types.ObjectId;
	userId: import("mongoose").Types.ObjectId;
	key: string;
	value: string;
	tokenCount?: number;
	type?: MemoryType;
	source?: MemorySourceDoc;
	weight?: { importance?: number };
	last_accessed_at?: Date | null;
	updated_at?: Date;
	createdAt?: Date;
	__v?: number;
}

// ---------------------------------------------------------------------------
// Agent document (shared with arp/LibreChat `agents` collection)
// ---------------------------------------------------------------------------

/** Skill reference embedded in an arp agent document (`agents.skills`). */
export interface AgentSkillRef {
	name: string;
	description?: string;
}

export interface AgentDoc {
	_id: import("mongoose").Types.ObjectId;
	/** String agent identifier, e.g. `agent_s917T8qpLYVrXzDxIpu4j` */
	id: string;
	name?: string;
	description?: string;
	/** Skills executable by this agent — the agent-side permission list */
	skills?: AgentSkillRef[];
	createdAt?: Date;
	updatedAt?: Date;
	__v?: number;
	_class?: string;
}

// ---------------------------------------------------------------------------
// Conversation & Message documents (shared with arp/LibreChat)
// ---------------------------------------------------------------------------

export interface MessageDoc {
	_id: import("mongoose").Types.ObjectId;
	messageId: string;
	conversationId: string;
	user: string;
	model?: string | null;
	endpoint?: string;
	parentMessageId?: string;
	/** Token count of THIS message's own text only (not call usage, not cumulative). */
	tokenCount?: number;
	/** Legacy arp field: input tokens of the model call that produced this message. */
	inputTokenCount?: number;
	/** Per-model-call usage (assistant messages only). Kept strictly separate from tokenCount. */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Turn-cumulative usage on the turn's assistant document: sum over all model
	 *  calls of the turn (user message → next user message). */
	totalInputTokens?: number;
	totalOutputTokens?: number;
	totalCacheReadTokens?: number;
	totalCacheWriteTokens?: number;
	sender?: string;
	text?: string;
	streamLog?: string;
	isCreatedByUser?: boolean;
	unfinished?: boolean;
	error?: boolean;
	finish_reason?: string;
	recursionLimit?: string;
	content?: unknown[];
	attachments?: unknown[];
	files?: unknown[];
	expiredAt?: Date | null;
	createdAt?: Date;
	updatedAt?: Date;
	__v?: number;
	_class?: string;
	/** Full pi AgentMessage object stored for context reconstruction */
	agentMessage?: unknown;
}

export interface ConversationDoc {
	_id: import("mongoose").Types.ObjectId;
	conversationId: string;
	user?: string;
	messages?: import("mongoose").Types.ObjectId[];
	title?: string;
	endpoint?: string;
	endpointType?: string;
	model?: string;
	agent_id?: string;
	isArchived?: boolean;
	tags?: string[];
	files?: string[];
	maxContextTokens?: number;
	resendFiles?: boolean;
	toolCallVisible?: boolean;
	finish_reason?: string;
	/** pi-specific: working directory for the session */
	cwd?: string;
	/** pi-specific: cumulative session usage totals for metering/display */
	totalInputTokens?: number;
	totalOutputTokens?: number;
	totalCacheReadTokens?: number;
	totalCacheWriteTokens?: number;
	expiredAt?: Date | null;
	createdAt?: Date;
	updatedAt?: Date;
	__v?: number;
	_class?: string;
}

// ---------------------------------------------------------------------------
// TaskQueue document (shared with arp/LibreChat taskqueues collection)
// ---------------------------------------------------------------------------

export interface TaskQueueDoc {
	_id: import("mongoose").Types.ObjectId;
	toUserId: string;
	toAgentId?: string;
	fromUserId: string;
	fromAgentId?: string;
	sourceConversationId?: string;
	sourceSessionId?: string;
	sourceTurnSeq?: number;
	type?: "ai_pending" | "collaboration" | "manual" | "subagent";
	title: string;
	description?: string;
	status?: string;
	priority?: "low" | "medium" | "high";
	formType?: "free_text" | "choice" | "form" | "confirmation";
	choices?: Array<{ label: string; value: string; description?: string }>;
	fields?: Array<Record<string, unknown>>;
	formResponse?: Record<string, unknown>;
	subagentTaskId?: string;
	subagentName?: string;
	metadata?: Record<string, unknown>;
	resultSummary?: string;
	userResponse?: string;
	callbackUrl?: string;
	completedAt?: Date;
	expiresAt?: Date;
	createdAt?: Date;
	updatedAt?: Date;
	__v?: number;
}

// ---------------------------------------------------------------------------
// Resolved principal (used internally by ACL queries)
// ---------------------------------------------------------------------------

export interface Principal {
	principalType: PrincipalType;
	principalId?: import("mongoose").Types.ObjectId;
}

// ---------------------------------------------------------------------------
// Skill credential contract (skillcredentials collection)
// ---------------------------------------------------------------------------

export type CredentialResourceType = "skill" | "mcp";
export type CredentialStatus = "active" | "invalid";

/**
 * Sentinel ObjectId (all zeros) used as `userId` on credentials bound by the
 * dmp administrator ("admin-managed" credentials shared across users).
 */
export const ADMIN_CREDENTIAL_USER_ID = "000000000000000000000000";

/** One declared secret field of a skill/MCP server (declaration only, never the value). */
export interface CredentialSchemaField {
	/** Key inside the encrypted credential JSON, e.g. `app_secret` */
	secretKey: string;
	/** UI label, e.g. `App Secret` */
	displayName?: string;
	/** true = render as password input everywhere */
	sensitive?: boolean;
	description?: string;
}

/** How resolved credential values are mapped into outbound requests (skills) or MCP connections. */
export interface CredentialBinding {
	/** secretKey → HTTP header name, e.g. `{ app_secret: "X-App-Secret" }` */
	headerMap?: Record<string, string>;
	/** `bearer` = first sensitive field becomes `Authorization: Bearer <value>` */
	authType?: "headers" | "bearer";
}

/** Backwards-compatible alias: credential binding on `mcpservers` documents. */
export type McpCredentialBinding = CredentialBinding;

export interface SkillCredentialDoc {
	_id: import("mongoose").Types.ObjectId;
	/** Owning user; ADMIN_CREDENTIAL_USER_ID for admin-managed credentials */
	userId: import("mongoose").Types.ObjectId;
	resourceType: CredentialResourceType;
	/** skill.name or mcpservers.serverName */
	resourceName: string;
	cipher: string;
	/** base64 IV */
	iv: string;
	/** base64 GCM auth tag */
	authTag: string;
	/** base64 ciphertext of the JSON `{ secretKey: value }` object */
	data: string;
	/** Master-key version for rotation support */
	keyVersion?: number;
	lastVerifiedAt?: Date | null;
	status?: CredentialStatus;
	createdAt?: Date;
	updatedAt?: Date;
	_class?: string;
}

// ---------------------------------------------------------------------------
// McpServer document (mcpservers collection, written by arp/dmp)
// ---------------------------------------------------------------------------

export interface McpServerDoc {
	_id: import("mongoose").Types.ObjectId;
	serverName: string;
	/** LibreChat/arp MCP config blob (url, transport, headers, customUserVars, ...) */
	config?: Record<string, unknown>;
	author?: import("mongoose").Types.ObjectId;
	/** true = registered as a pi skill source */
	isPiSkill?: boolean;
	requiresCredentials?: boolean;
	userManaged?: boolean;
	credentialSchema?: CredentialSchemaField[];
	credentialBinding?: McpCredentialBinding;
	createdAt?: Date;
	updatedAt?: Date;
	__v?: number;
	_class?: string;
}
