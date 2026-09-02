import { existsSync } from "node:fs";
import { checkPermission, findAccessibleResourceIds } from "./acl.js";
import { getDb, isMongoEnabled } from "./db.js";
import { getAgentModel, getSkillModel } from "./models.js";
import type { AgentDoc, SkillDoc } from "./types.js";
import { PermissionBits, type Principal, ResourceType } from "./types.js";

/**
 * Skill catalog service.
 *
 * Bridges the MongoDB `skills` collection (metadata + ACL) with pi's on-disk
 * skill loader. Authorized skills are fetched from MongoDB and filtered by
 * the user's ACL permissions; their `SKILL.md` files live on disk at the
 * `savePath` recorded in the database.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthorizedSkill {
	id: string;
	name: string;
	displayName?: string;
	description?: string;
	category?: string;
	savePath: string;
	skillType?: string;
	status?: number;
	/** http skills: inline API definitions (pi direct-read, no savePath install) */
	apiDefinitions?: Array<Record<string, unknown>>;
	requiresCredentials?: boolean;
	userManaged?: boolean;
	credentialBinding?: import("./types.js").CredentialBinding;
	credentialRef?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts a raw MongoDB skill document to the {@link AuthorizedSkill} shape.
 *
 * Repo-type skills require an existing `savePath` on disk. http-type skills
 * don't need one — their `apiDefinitions` live inline in the document, so pi
 * reads them directly without any install step.
 */
function toAuthorizedSkill(doc: SkillDoc): AuthorizedSkill | null {
	const isHttpType = doc.skillType === "http";
	const savePath = doc.savePath;
	if (!isHttpType && (!savePath || !existsSync(savePath))) {
		return null;
	}
	return {
		id: doc._id.toString(),
		name: doc.name,
		displayName: doc.displayName,
		description: doc.description,
		category: doc.category,
		savePath: savePath ?? "",
		skillType: doc.skillType,
		status: doc.status,
		apiDefinitions: doc.apiDefinitions,
		requiresCredentials: doc.requiresCredentials,
		userManaged: doc.userManaged,
		credentialBinding: doc.credentialBinding,
		credentialRef: doc.credentialRef,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the on-disk skill directories (`savePath`) that `userId` is
 * authorized to use. These paths can be passed directly to pi's
 * `DefaultResourceLoader` as `additionalSkillPaths`.
 *
 * Authorization is checked via ACL: only skills the user has VIEW permission
 * on are included.
 */
export async function getAuthorizedSkillDirs(userId: string): Promise<string[]> {
	if (!isMongoEnabled()) return [];

	const skills = await getAuthorizedSkills(userId);
	return skills.filter((s) => s.savePath).map((s) => s.savePath);
}

/**
 * Returns full metadata for all skills the user is authorized to use.
 * Only active (status=1) skills with an existing `savePath` are returned.
 */
export async function getAuthorizedSkills(userId: string): Promise<AuthorizedSkill[]> {
	if (!isMongoEnabled()) return [];
	await getDb();

	// 1. Find all skill resourceIds the user can access
	const accessibleIds = await findAccessibleResourceIds(userId, ResourceType.SKILL, PermissionBits.VIEW);
	if (accessibleIds.length === 0) return [];

	// 2. Load skill metadata, filter by status and disk existence
	const Skill = getSkillModel();
	const docs: SkillDoc[] = await Skill.find({
		_id: { $in: accessibleIds },
		status: 1,
	})
		.lean()
		.exec();

	const results: AuthorizedSkill[] = [];
	for (const doc of docs) {
		const skill = toAuthorizedSkill(doc);
		if (skill) results.push(skill);
	}
	return results;
}

/**
 * Returns ALL active skills from MongoDB (without ACL filtering).
 * Used for admin/listing endpoints that show all skills regardless of permission.
 */
export async function getAllActiveSkills(): Promise<AuthorizedSkill[]> {
	if (!isMongoEnabled()) return [];
	await getDb();

	const Skill = getSkillModel();
	const docs: SkillDoc[] = await Skill.find({ status: 1 }).lean().exec();

	const results: AuthorizedSkill[] = [];
	for (const doc of docs) {
		const skill = toAuthorizedSkill(doc);
		if (skill) results.push(skill);
	}
	return results;
}

/**
 * Returns the skill _id (as a hex string) for a given skill name, or null
 * if the skill is not found in the MongoDB catalog.
 *
 * Used by execution-endpoint guards to resolve skill name → resourceId
 * before checking permissions.
 */
export async function getSkillIdByName(skillName: string): Promise<string | null> {
	if (!isMongoEnabled()) return null;
	await getDb();

	const Skill = getSkillModel();
	const doc = await Skill.findOne({ name: skillName, status: 1 }).select("_id").lean().exec();
	return doc ? doc._id.toString() : null;
}

/**
 * Checks whether `userId` has VIEW permission on the named skill.
 *
 * This is the **mandatory permission gate** called before any authorized
 * skill execution. Returns true if:
 *   - MongoDB is not configured (personal-skills-only mode — no ACL), OR
 *   - The skill is not in the MongoDB catalog (it's a personal/local skill), OR
 *   - The user has an ACL grant with VIEW permission on the skill.
 *
 * Returns false only when the skill IS in the catalog AND the user lacks
 * permission.
 */
export async function checkSkillPermission(userId: string, skillName: string): Promise<boolean> {
	if (!isMongoEnabled()) return true;

	const skillId = await getSkillIdByName(skillName);
	if (!skillId) return true; // Not a MongoDB-cataloged skill → no ACL check

	return checkPermission(userId, ResourceType.SKILL, skillId, PermissionBits.VIEW);
}

// ---------------------------------------------------------------------------
// Agent-based skill authorization (arp agent principals)
// ---------------------------------------------------------------------------

/** Prefix that marks an agentId as an arp agent principal (e.g. `agent_s917T8qpLYVrXzDxIpu4j`). */
export const AGENT_ID_PREFIX = "agent_";

/**
 * Type guard: true when `agentId` identifies an arp agent (starts with
 * `agent_`). Agent principals authorize skills via the agent document's
 * `skills` field instead of the user ACL.
 */
export function isAgentPrincipalId(agentId: string | null | undefined): agentId is string {
	return typeof agentId === "string" && agentId.startsWith(AGENT_ID_PREFIX);
}

/**
 * Returns the skill names assigned to the given arp agent (the `skills` field
 * of the `agents` collection), or null when the agent document does not exist.
 */
export async function getAgentSkillNames(agentId: string): Promise<string[] | null> {
	if (!isMongoEnabled()) return null;
	await getDb();

	const Agent = getAgentModel();
	const doc: AgentDoc | null = await Agent.findOne({ id: agentId }).select("skills").lean().exec();
	if (!doc) return null;

	const skills = doc.skills ?? [];
	return skills.map((s) => s?.name).filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Returns the on-disk skill directories (`savePath`) for the skills assigned
 * to the given arp agent. Skill names are resolved against the `skills`
 * collection; only active skills with an existing `savePath` are included.
 */
export async function getAgentSkillDirs(agentId: string): Promise<string[]> {
	const names = await getAgentSkillNames(agentId);
	if (!names || names.length === 0) return [];

	await getDb();
	const Skill = getSkillModel();
	const docs: SkillDoc[] = await Skill.find({ name: { $in: names }, status: 1 })
		.lean()
		.exec();

	const dirs = new Set<string>();
	for (const doc of docs) {
		const skill = toAuthorizedSkill(doc);
		if (skill?.savePath) dirs.add(skill.savePath);
	}
	return [...dirs];
}

/**
 * Checks whether the given arp agent has the named skill assigned in its
 * `skills` field. Returns true if:
 *   - MongoDB is not configured (personal-skills-only mode — no ACL), OR
 *   - The agent document lists the skill name.
 *
 * Returns false when the agent document is missing or does not include the
 * skill — the caller must treat this as "skill does not exist or no
 * permission" and fail fast without fallback.
 */
export async function checkAgentSkillPermission(agentId: string, skillName: string): Promise<boolean> {
	if (!isMongoEnabled()) return true;

	const names = await getAgentSkillNames(agentId);
	if (names === null) return false; // Agent document not found → deny

	return names.includes(skillName);
}

/**
 * Filters a list of skill names, keeping only those the user is authorized to
 * access. Non-catalog skills (personal/local) are always kept. Uses a single
 * batch query to avoid N individual permission checks.
 *
 * @param userId    MongoDB User ObjectId hex string (null → no filtering)
 * @param skillNames  List of skill names to filter
 * @returns Set of skill names that should be visible to the user
 */
export async function filterAuthorizedSkillNames(userId: string | null, skillNames: string[]): Promise<Set<string>> {
	if (!isMongoEnabled() || skillNames.length === 0) {
		return new Set(skillNames);
	}

	// Batch-load all catalog skill names + the user's authorized skill names
	const Skill = getSkillModel();
	await getDb();

	const catalogDocs = await Skill.find({ name: { $in: skillNames }, status: 1 })
		.select("name")
		.lean()
		.exec();
	const catalogNames = new Set(catalogDocs.map((d) => d.name));

	if (userId) {
		const authorized = await getAuthorizedSkills(userId);
		const authorizedNames = new Set(authorized.map((s) => s.name));

		const result = new Set<string>();
		for (const name of skillNames) {
			// Keep if NOT in catalog (personal skill) OR in authorized set
			if (!catalogNames.has(name) || authorizedNames.has(name)) {
				result.add(name);
			}
		}
		return result;
	}

	// No userId but MongoDB enabled — only show non-catalog skills
	const result = new Set<string>();
	for (const name of skillNames) {
		if (!catalogNames.has(name)) {
			result.add(name);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Principal re-exports (convenience for callers that need both)
// ---------------------------------------------------------------------------

export type { Principal };
