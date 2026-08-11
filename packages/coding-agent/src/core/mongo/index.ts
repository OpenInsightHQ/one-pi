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
	NO_PARENT,
	saveConversationToMongo,
	saveMessageToMongo,
	updateToolCallOutputInMongo,
} from "./conversation-service.js";
// Connection management
export { connectMongo, disconnectMongo, getCachedConnection, getDb, isMongoEnabled } from "./db.js";

// Models
export {
	type AccessRoleModel,
	type AclEntryModel,
	type ConversationModel,
	getAccessRoleModel,
	getAclEntryModel,
	getConversationModel,
	getMessageModel,
	getRoleModel,
	getSkillModel,
	getUserRoleModel,
	type MessageModel,
	type RoleModel,
	type SkillModel,
	type UserRoleModel,
} from "./models.js";
// Schemas (for advanced/custom usage)
export {
	accessRoleSchema,
	aclEntrySchema,
	conversationSchema,
	messageSchema,
	roleSchema,
	skillSchema,
	userRoleSchema,
} from "./schemas.js";

// Skill catalog service
export {
	type AuthorizedSkill,
	checkSkillPermission,
	filterAuthorizedSkillNames,
	getAllActiveSkills,
	getAuthorizedSkillDirs,
	getAuthorizedSkills,
	getSkillIdByName,
} from "./skill-catalog.js";

// Shared types and constants
export {
	type AccessRoleDoc,
	type AclEntryDoc,
	type ConversationDoc,
	hasPermissions,
	type MessageDoc,
	PermissionBits,
	type Principal,
	PrincipalModel,
	PrincipalType,
	ResourceType,
	RoleBits,
	type RoleDoc,
	type SkillDoc,
	type UserRoleDoc,
} from "./types.js";
