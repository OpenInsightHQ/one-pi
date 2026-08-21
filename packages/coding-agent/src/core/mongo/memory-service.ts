import { Types } from "mongoose";
import { getDb, isMongoEnabled } from "./db.js";
import { getMemoryEntryModel, getMessageModel, getRoleModel, getUserModel, getUserRoleModel } from "./models.js";
import type { MemoryEntryDoc, MessageDoc, RoleDoc, UserDoc } from "./types.js";

/**
 * Long-term memory service (shared with arp/LibreChat).
 *
 * Reads the `memoryentries` collection for the session user and formats the
 * `[用户长期记忆]` block appended to the system prompt — mirroring the
 * injection arp previously performed on the pi chat path.
 *
 * Access follows the arp model:
 *   1. Role permission check: every role of the user (`users.roles` /
 *      `users.role`, plus `userroles.roleNames`) must collectively grant
 *      `MEMORIES.USE` AND `MEMORIES.READ` (OR-merged across roles).
 *   2. Personalization opt-out: `users.personalization.memories === false`
 *      disables injection.
 *
 * The memory-detail readers (`readMemoryDetail`, `readConversationByMemory`)
 * replace arp's `/api/memories/details` and `/api/memories/conversation-by-memory`
 * endpoints, scoped to the owning user.
 */

const MEMORY_PERMISSION_TYPE = "MEMORIES";
const MEMORY_PERMISSION_USE = "USE";
const MEMORY_PERMISSION_READ = "READ";

/**
 * Merges role permission objects with OR semantics (any role granting a
 * permission wins), mirroring arp's `checkAccess` merge behavior.
 */
function mergeRolePermissions(roleDocs: RoleDoc[]): Record<string, Record<string, boolean>> {
	const merged: Record<string, Record<string, boolean>> = {};
	for (const role of roleDocs) {
		if (!role.permissions) continue;
		for (const [permType, permValue] of Object.entries(role.permissions)) {
			if (!permValue || typeof permValue !== "object") continue;
			merged[permType] ??= {};
			for (const [perm, value] of Object.entries(permValue)) {
				if (value === true) {
					merged[permType][perm] = true;
				}
			}
		}
	}
	return merged;
}

/**
 * Returns true when the user's roles grant MEMORIES USE+READ.
 *
 * Role names come from the user document (`roles` array, falling back to
 * `role`) plus the `userroles` collection, matching how arp populates
 * `user.roles` at auth time. A user without any role is denied.
 */
export async function hasMemoryReadPermission(userId: string): Promise<boolean> {
	if (!isMongoEnabled()) return false;
	await getDb();

	if (!Types.ObjectId.isValid(userId)) return false;
	const userObjectId = new Types.ObjectId(userId);

	const User = getUserModel();
	const userDoc: UserDoc | null = await User.findOne({ _id: userObjectId })
		.select("role roles personalization")
		.lean()
		.exec();
	if (!userDoc) return false;

	const roleNames = new Set<string>();
	for (const name of userDoc.roles ?? (userDoc.role ? [userDoc.role] : [])) {
		if (name) roleNames.add(name);
	}
	try {
		const UserRole = getUserRoleModel();
		const userRoleDoc = await UserRole.findOne({ userId: userObjectId }).lean().exec();
		for (const name of userRoleDoc?.roleNames ?? []) {
			if (name) roleNames.add(name);
		}
	} catch (error) {
		console.warn("[MongoDB] Failed to resolve userroles for memory permission, continuing with user roles:", error);
	}
	if (roleNames.size === 0) return false;

	const Role = getRoleModel();
	const roleDocs: RoleDoc[] = await Role.find({ name: { $in: [...roleNames] } })
		.select("permissions")
		.lean()
		.exec();
	if (roleDocs.length === 0) return false;

	const merged = mergeRolePermissions(roleDocs);
	const memoryPermissions = merged[MEMORY_PERMISSION_TYPE];
	if (!memoryPermissions) return false;
	return memoryPermissions[MEMORY_PERMISSION_USE] === true && memoryPermissions[MEMORY_PERMISSION_READ] === true;
}

/**
 * Returns the user's memory entries when memory injection applies
 * (MEMORIES USE+READ granted, not opted out, and at least one entry),
 * otherwise null.
 */
export async function getUserMemoriesWithAccess(userId: string): Promise<MemoryEntryDoc[] | null> {
	if (!isMongoEnabled()) return null;
	if (!userId || userId === "system") return null;
	await getDb();

	if (!(await hasMemoryReadPermission(userId))) return null;

	if (!Types.ObjectId.isValid(userId)) return null;
	const User = getUserModel();
	const userObjectId = new Types.ObjectId(userId);
	const userDoc: UserDoc | null = await User.findOne({ _id: userObjectId }).select("personalization").lean().exec();
	if (userDoc?.personalization?.memories === false) return null;

	const MemoryEntry = getMemoryEntryModel();
	const memories: MemoryEntryDoc[] = await MemoryEntry.find({ userId: userObjectId }).lean().exec();
	if (memories.length === 0) return null;
	return memories;
}

const MEMORY_TYPE_LABELS: Record<string, string> = {
	constraint: "【强约束 | constraint】",
	profile: "【身份信息 | profile】",
	preference: "【偏好 | preference】",
	knowledge: "【知识 | knowledge】",
};

const MEMORY_TYPE_ORDER = ["constraint", "profile", "preference", "knowledge"] as const;

/**
 * Formats the `[用户长期记忆]` block appended to the system prompt,
 * grouped by memory type and listing each memory's ID so the model can drill
 * into details with the read_memory_detail / read_memory_conversation tools.
 */
export function formatMemoriesPrompt(memories: MemoryEntryDoc[]): string {
	if (memories.length === 0) return "";

	const groups: Record<string, MemoryEntryDoc[]> = {
		constraint: [],
		profile: [],
		preference: [],
		knowledge: [],
	};
	for (const memory of memories) {
		const type = memory.type ?? "knowledge";
		if (groups[type]) {
			groups[type].push(memory);
		} else {
			groups.knowledge.push(memory);
		}
	}

	const parts = ["[用户长期记忆]", "以下是关于用户的长期记忆摘要，每条记忆可能指向更详细的原始对话（需要时可追问）："];
	for (const type of MEMORY_TYPE_ORDER) {
		const items = groups[type];
		parts.push("");
		parts.push(MEMORY_TYPE_LABELS[type]);
		if (items.length === 0) {
			parts.push("（暂无）");
			continue;
		}
		for (const item of items) {
			const key = item.key || "unknown";
			const value = item.value || "";
			parts.push(`• ${key}: ${value}`);
			parts.push(`  记忆ID: ${item._id.toString()}`);
		}
	}
	parts.push("");
	parts.push(
		"（如需查看某条记忆的详情或产生该记忆的原始对话，可使用 read_memory_detail / read_memory_conversation 工具并传入对应的记忆ID。）",
	);

	return parts.join("\n");
}

/** Extracts the text of an arp message: `text` field or first text content part. */
function extractMessageText(message: MessageDoc): string {
	if (typeof message.text === "string" && message.text.length > 0) return message.text;
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const text = (part as { text?: unknown }).text;
				if (typeof text === "string" && text.length > 0) return text;
			}
		}
	}
	return "";
}

export interface MemoryDetail {
	memory: {
		id: string;
		key: string;
		value: string;
		type: string;
		updated_at?: Date;
	};
	messages: Array<{
		messageId: string;
		role: "user" | "assistant";
		text: string;
		createdAt?: Date;
	}>;
}

/**
 * Reads a memory and the original messages that produced it
 * (replaces arp's `GET /api/memories/details`).
 *
 * Scoped to `userId`: only the owning user's memories are readable.
 * Returns an error string when the memory does not exist for this user.
 */
export async function readMemoryDetail(userId: string, memoryId: string): Promise<MemoryDetail | string> {
	if (!isMongoEnabled()) return "Memory is not available";
	if (!Types.ObjectId.isValid(memoryId) || !Types.ObjectId.isValid(userId)) return "Invalid memory ID format";

	await getDb();
	const MemoryEntry = getMemoryEntryModel();
	const memory: MemoryEntryDoc | null = await MemoryEntry.findOne({
		_id: new Types.ObjectId(memoryId),
		userId: new Types.ObjectId(userId),
	})
		.lean()
		.exec();
	if (!memory) return "Memory not found";

	let messages: MemoryDetail["messages"] = [];
	const messageIds = memory.source?.messageIds;
	if (Array.isArray(messageIds) && messageIds.length > 0) {
		const Message = getMessageModel();
		const docs: MessageDoc[] = await Message.find({ messageId: { $in: messageIds } })
			.sort({ createdAt: 1 })
			.lean()
			.exec();
		messages = docs.map((doc) => ({
			messageId: doc.messageId,
			role: doc.isCreatedByUser ? "user" : "assistant",
			text: extractMessageText(doc),
			createdAt: doc.createdAt ?? undefined,
		}));
	}

	return {
		memory: {
			id: memory._id.toString(),
			key: memory.key,
			value: memory.value,
			type: memory.type ?? "knowledge",
			updated_at: memory.updated_at ?? undefined,
		},
		messages,
	};
}

export interface MemoryConversation {
	conversationId: string;
	memoryId: string;
	messageCount: number;
	messages: Array<{
		messageId: string;
		role: "user" | "assistant";
		text: string;
		createdAt?: Date;
	}>;
}

/**
 * Reads the full conversation a memory was produced in
 * (replaces arp's `GET /api/memories/conversation-by-memory`).
 *
 * Scoped to `userId`: only the owning user's memories are readable.
 */
export async function readConversationByMemory(userId: string, memoryId: string): Promise<MemoryConversation | string> {
	if (!isMongoEnabled()) return "Memory is not available";
	if (!Types.ObjectId.isValid(memoryId) || !Types.ObjectId.isValid(userId)) return "Invalid memory ID format";

	await getDb();
	const MemoryEntry = getMemoryEntryModel();
	const memory: MemoryEntryDoc | null = await MemoryEntry.findOne({
		_id: new Types.ObjectId(memoryId),
		userId: new Types.ObjectId(userId),
	})
		.lean()
		.exec();
	if (!memory) return "Memory not found";

	const conversationId = memory.source?.conversationId;
	if (!conversationId) return "No conversation is linked to this memory";

	const Message = getMessageModel();
	const docs: MessageDoc[] = await Message.find({ conversationId }).sort({ createdAt: 1 }).lean().exec();

	return {
		conversationId,
		memoryId: memory._id.toString(),
		messageCount: docs.length,
		messages: docs.map((doc) => ({
			messageId: doc.messageId,
			role: doc.isCreatedByUser ? "user" : "assistant",
			text: extractMessageText(doc),
			createdAt: doc.createdAt ?? undefined,
		})),
	};
}
