import mongoose from "mongoose";
import {
	accessRoleSchema,
	aclEntrySchema,
	agentSchema,
	conversationSchema,
	memoryEntrySchema,
	messageSchema,
	roleSchema,
	skillSchema,
	systemPromptSchema,
	taskQueueSchema,
	userRoleSchema,
	userSchema,
} from "./schemas.js";
import type {
	AccessRoleDoc,
	AclEntryDoc,
	AgentDoc,
	ConversationDoc,
	MemoryEntryDoc,
	MessageDoc,
	RoleDoc,
	SkillDoc,
	SystemPromptDoc,
	TaskQueueDoc,
	UserDoc,
	UserRoleDoc,
} from "./types.js";

/**
 * Model accessor functions.
 *
 * Mongoose caches models by name on the default connection, so calling
 * `mongoose.model(name, schema, collection)` repeatedly is safe — the schema
 * is only compiled once. These accessors wrap that pattern to provide typed
 * models while keeping the connection lazy (models are usable only after
 * `getDb()` has connected, but Mongoose buffers operations until then).
 *
 * To add a future collection (e.g. `messages`):
 *   1. Add a schema in `schemas.ts`
 *   2. Add a `get<Message>Model()` function here
 *   3. Add any business logic in a dedicated service file
 */

export type SkillModel = mongoose.Model<SkillDoc>;
export type AccessRoleModel = mongoose.Model<AccessRoleDoc>;
export type AclEntryModel = mongoose.Model<AclEntryDoc>;
export type UserRoleModel = mongoose.Model<UserRoleDoc>;
export type RoleModel = mongoose.Model<RoleDoc>;
export type MessageModel = mongoose.Model<MessageDoc>;
export type ConversationModel = mongoose.Model<ConversationDoc>;

export function getSkillModel(): SkillModel {
	return mongoose.model<SkillDoc>("Skill", skillSchema, "skills");
}

export function getAccessRoleModel(): AccessRoleModel {
	return mongoose.model<AccessRoleDoc>("AccessRole", accessRoleSchema, "accessroles");
}

export function getAclEntryModel(): AclEntryModel {
	return mongoose.model<AclEntryDoc>("AclEntry", aclEntrySchema, "aclentries");
}

export function getUserRoleModel(): UserRoleModel {
	return mongoose.model<UserRoleDoc>("UserRole", userRoleSchema, "userroles");
}

export function getRoleModel(): RoleModel {
	return mongoose.model<RoleDoc>("Role", roleSchema, "roles");
}

export type AgentModel = mongoose.Model<AgentDoc>;

export function getAgentModel(): AgentModel {
	return mongoose.model<AgentDoc>("Agent", agentSchema, "agents");
}

export function getMessageModel(): MessageModel {
	return mongoose.model<MessageDoc>("Message", messageSchema, "messages");
}

export function getConversationModel(): ConversationModel {
	return mongoose.model<ConversationDoc>("Conversation", conversationSchema, "conversations");
}

export type TaskQueueModel = mongoose.Model<TaskQueueDoc>;

export function getTaskQueueModel(): TaskQueueModel {
	return mongoose.model<TaskQueueDoc>("TaskQueue", taskQueueSchema, "taskqueues");
}

export type UserModel = mongoose.Model<UserDoc>;

export function getUserModel(): UserModel {
	return mongoose.model<UserDoc>("PiUser", userSchema, "users");
}

export type SystemPromptModel = mongoose.Model<SystemPromptDoc>;

export function getSystemPromptModel(): SystemPromptModel {
	return mongoose.model<SystemPromptDoc>("SystemPrompt", systemPromptSchema, "systemprompts");
}

export type MemoryEntryModel = mongoose.Model<MemoryEntryDoc>;

export function getMemoryEntryModel(): MemoryEntryModel {
	return mongoose.model<MemoryEntryDoc>("MemoryEntry", memoryEntrySchema, "memoryentries");
}

/**
 * Build the declared indexes on the messages collection at startup.
 *
 * Returns false (with a clear error log) instead of throwing so the server
 * still starts — e.g. when pre-existing duplicate documents block the unique
 * { messageId, user } index. Remove the duplicates (keep one document per
 * messageId) and restart to let the index build.
 */
export async function ensureMessageIndexes(): Promise<boolean> {
	try {
		await getMessageModel().createIndexes();
		return true;
	} catch (err) {
		console.error(
			"[MongoDB] Failed to build messages indexes (duplicate messageId documents must be removed before the unique index can be created):",
			err,
		);
		return false;
	}
}
