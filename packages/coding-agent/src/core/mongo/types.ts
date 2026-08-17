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
	// Future: MESSAGE, CONVERSATION, SYSTEMPROMPT, AGENT, ...
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
	createdAt?: Date;
	updatedAt?: Date;
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
	tokenCount?: number;
	inputTokenCount?: number;
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
