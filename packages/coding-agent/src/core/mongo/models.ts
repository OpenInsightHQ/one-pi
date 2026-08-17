import mongoose from "mongoose";
import {
	accessRoleSchema,
	aclEntrySchema,
	conversationSchema,
	messageSchema,
	roleSchema,
	skillSchema,
	taskQueueSchema,
	userRoleSchema,
} from "./schemas.js";
import type {
	AccessRoleDoc,
	AclEntryDoc,
	ConversationDoc,
	MessageDoc,
	RoleDoc,
	SkillDoc,
	TaskQueueDoc,
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
