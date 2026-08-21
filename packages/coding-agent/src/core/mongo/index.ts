/**
 * MongoDB data layer for pi coding agent.
 *
 * Provides a connection manager, Mongoose schemas/models, an ACL service,
 * and a skill catalog service for authorized (MongoDB-backed) skills.
 *
 * ## Quick usage
 *
 * ```ts
 * import { connectMongo, getAuthorizedSkillDirs, checkSkillPermission } from "./mongo/index.js";
 *
 * // On server startup:
 * await connectMongo();
 *
 * // Load authorized skills for a user:
 * const dirs = await getAuthorizedSkillDirs(userId);
 *
 * // Check permission before executing a skill:
 * const allowed = await checkSkillPermission(userId, skillName);
 * ```
 *
 * ## Extending with new collections
 *
 * To add a new MongoDB collection (e.g. `messages`, `conversations`):
 *
 * 1. Add a document interface + schema in `types.ts` / `schemas.ts`
 * 2. Add a `get<Name>Model()` accessor in `models.ts`
 * 3. Add a service file (e.g. `message-service.ts`) with business logic
 * 4. Re-export the public API here
 *
 * All collections share the same connection (see `db.ts`).
 */

// ACL service
export {
	checkPermission,
	findAccessibleResourceIds,
	getEffectivePermissions,
	resolveUserPrincipals,
} from "./acl.js";
// Conversation & message persistence service
export {
	type ConversationPersistenceContext,
	deriveTitle,
	getConversationFromMongo,
	getLastMessageId,
	loadConversationMessages,
	mergeAssistantMessageInMongo,
	NO_PARENT,
	saveConversationToMongo,
	saveMessageToMongo,
	updateToolCallOutputInMongo,
} from "./conversation-service.js";
// Connection management
export { connectMongo, disconnectMongo, getCachedConnection, getDb, isMongoEnabled } from "./db.js";
// Long-term memory service
export {
	formatMemoriesPrompt,
	getUserMemoriesWithAccess,
	hasMemoryReadPermission,
	type MemoryConversation,
	type MemoryDetail,
	readConversationByMemory,
	readMemoryDetail,
} from "./memory-service.js";
// Models
export {
	type AccessRoleModel,
	type AclEntryModel,
	type AgentModel,
	type ConversationModel,
	ensureMessageIndexes,
	getAccessRoleModel,
	getAclEntryModel,
	getAgentModel,
	getConversationModel,
	getMemoryEntryModel,
	getMessageModel,
	getRoleModel,
	getSkillModel,
	getSystemPromptModel,
	getTaskQueueModel,
	getUserModel,
	getUserRoleModel,
	type MemoryEntryModel,
	type MessageModel,
	type RoleModel,
	type SkillModel,
	type SystemPromptModel,
	type TaskQueueModel,
	type UserModel,
	type UserRoleModel,
} from "./models.js";
// System-prompt catalog service
export {
	type AvailablePrompt,
	formatAvailablePromptsPrompt,
	getAccessiblePiPrompts,
} from "./prompt-service.js";
// Schemas (for advanced/custom usage)
export {
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
// Skill catalog service
export {
	AGENT_ID_PREFIX,
	type AuthorizedSkill,
	checkAgentSkillPermission,
	checkSkillPermission,
	filterAuthorizedSkillNames,
	getAgentSkillDirs,
	getAgentSkillNames,
	getAllActiveSkills,
	getAuthorizedSkillDirs,
	getAuthorizedSkills,
	getSkillIdByName,
	isAgentPrincipalId,
} from "./skill-catalog.js";
// TaskQueue persistence service
export {
	type AiTaskPickup,
	type CreateTaskData,
	createTaskInMongo,
	findTasksByConversation,
	findTasksForAiPickup,
	findWaitingAgentTasks,
	markTaskAiNotified,
	updateTaskStatusInMongo,
} from "./task-queue-service.js";

// Shared types and constants
export {
	type AccessRoleDoc,
	type AclEntryDoc,
	type AgentDoc,
	type AgentSkillRef,
	type ConversationDoc,
	hasPermissions,
	type MemoryEntryDoc,
	type MemorySourceDoc,
	type MemoryType,
	type MessageDoc,
	PermissionBits,
	type Principal,
	PrincipalModel,
	PrincipalType,
	ResourceType,
	RoleBits,
	type RoleDoc,
	type SkillDoc,
	type SystemPromptDoc,
	type TaskQueueDoc,
	type UserDoc,
	type UserRoleDoc,
} from "./types.js";
