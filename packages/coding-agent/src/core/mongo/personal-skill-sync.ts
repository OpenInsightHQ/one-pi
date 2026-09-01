import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Types } from "mongoose";
import { getSessionsDir } from "../../config.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { getDb, isMongoEnabled } from "./db.js";
import { getSkillModel } from "./models.js";
import type { CredentialSchemaField, SkillDoc } from "./types.js";

/**
 * Personal skill sync (docs/credential-skill-dev-plan.md §5.6).
 *
 * skill-creator (and manual uploads) write skill folders straight to the
 * user's personal skills directory — pure filesystem output with no code
 * hook. This service lazily upserts their metadata into the `skills`
 * collection (idempotent on `(name, author)`), which makes them visible to
 * the credential binding, ACL sharing, and the arp "my skills" page.
 *
 * Triggers: session catalog assembly, `POST /skills/sync`, and
 * `POST /skills/register-personal` (best-effort registration from the
 * skill-creator instructions). A per-user TTL (60s) throttles repeat scans.
 */

const SYNC_TTL_MS = 60 * 1000;

interface SyncThrottle {
	lastRun: number;
}

const syncThrottles = new Map<string, SyncThrottle>();

export interface PersonalSkillSyncResult {
	/** true when the call was throttled and nothing was scanned */
	skipped: boolean;
	/** number of upserted skills */
	synced: number;
	/** number of records soft-disabled (directory no longer exists) */
	disabled: number;
}

interface ParsedPersonalSkill {
	name: string;
	description?: string;
	savePath: string;
	requiresCredentials: boolean;
	credentialSchema?: CredentialSchemaField[];
}

/** Parses `requiresSecrets`/`requires-secrets` frontmatter into a credential schema. */
export function parseCredentialSchema(value: unknown): CredentialSchemaField[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const fields: CredentialSchemaField[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			fields.push({ secretKey: item, displayName: item, sensitive: true });
		} else if (item && typeof item === "object" && typeof (item as { secretKey?: unknown }).secretKey === "string") {
			const obj = item as { secretKey: string; displayName?: unknown; sensitive?: unknown; description?: unknown };
			fields.push({
				secretKey: obj.secretKey,
				displayName: typeof obj.displayName === "string" ? obj.displayName : obj.secretKey,
				sensitive: obj.sensitive !== false,
				description: typeof obj.description === "string" ? obj.description : undefined,
			});
		}
	}
	return fields.length > 0 ? fields : undefined;
}

/** Scans the user's personal skills directory into parsed entries. */
function scanPersonalSkillsDir(userId: string): ParsedPersonalSkill[] {
	const skillsDir = join(getSessionsDir(), userId, "skills");
	if (!existsSync(skillsDir)) return [];

	const results: ParsedPersonalSkill[] = [];
	for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
		if (!existsSync(skillMdPath)) continue;
		try {
			const content = readFileSync(skillMdPath, "utf-8");
			const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
			const name = (typeof frontmatter.name === "string" && frontmatter.name.trim()) || entry.name;
			const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
			const rawSecrets = frontmatter.requiresSecrets ?? frontmatter["requires-secrets"];
			const credentialSchema = parseCredentialSchema(rawSecrets);
			results.push({
				name,
				description,
				savePath: join(skillsDir, entry.name),
				requiresCredentials: credentialSchema !== undefined,
				credentialSchema,
			});
		} catch {
			// Unreadable SKILL.md — skip; the disable pass keeps the old record.
		}
	}
	return results;
}

async function upsertPersonalSkill(userId: string, parsed: ParsedPersonalSkill): Promise<void> {
	await getDb();
	const Skill = getSkillModel();
	await Skill.updateOne(
		{ name: parsed.name, author: new Types.ObjectId(userId) },
		{
			$set: {
				skillType: "repo",
				name: parsed.name,
				description: parsed.description ?? "",
				savePath: parsed.savePath,
				author: new Types.ObjectId(userId),
				status: 1,
				userManaged: true,
				requiresCredentials: parsed.requiresCredentials,
				...(parsed.credentialSchema ? { credentialSchema: parsed.credentialSchema } : {}),
				source: "skill-creator",
				updatedAt: new Date(),
			},
		},
		{ upsert: true },
	).exec();
}

/**
 * Syncs the user's personal skills directory into the `skills` collection.
 * Throttled per user (60s) unless `force: true`; returns `{skipped: true}`
 * when throttled.
 */
export async function syncPersonalSkills(userId: string, opts?: { force?: boolean }): Promise<PersonalSkillSyncResult> {
	if (!isMongoEnabled()) return { skipped: true, synced: 0, disabled: 0 };

	const now = Date.now();
	if (!opts?.force) {
		const throttle = syncThrottles.get(userId);
		if (throttle && now - throttle.lastRun < SYNC_TTL_MS) {
			return { skipped: true, synced: 0, disabled: 0 };
		}
	}
	syncThrottles.set(userId, { lastRun: now });

	let synced = 0;
	for (const parsed of scanPersonalSkillsDir(userId)) {
		try {
			await upsertPersonalSkill(userId, parsed);
			synced++;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[SkillSync] Failed to upsert personal skill "${parsed.name}" for ${userId}: ${msg}`);
		}
	}

	// Soft-disable stale records: synced-by-us skills whose savePath is gone.
	let disabled = 0;
	try {
		await getDb();
		const Skill = getSkillModel();
		const docs: SkillDoc[] = await Skill.find({
			author: new Types.ObjectId(userId),
			source: "skill-creator",
			status: 1,
		})
			.select("name savePath")
			.lean()
			.exec();
		for (const doc of docs) {
			if (doc.savePath && existsSync(doc.savePath)) continue;
			await Skill.updateOne({ _id: doc._id }, { $set: { status: 0, updatedAt: new Date() } }).exec();
			disabled++;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[SkillSync] Disable pass failed for ${userId}: ${msg}`);
	}

	if (synced > 0 || disabled > 0) {
		console.log(`[SkillSync] user ${userId}: synced=${synced} disabled=${disabled}`);
	}
	return { skipped: false, synced, disabled };
}

/**
 * Registers ONE personal skill by name (best-effort path used by the
 * skill-creator instructions). Returns false when the folder doesn't exist.
 */
export async function registerPersonalSkill(userId: string, skillName: string): Promise<boolean> {
	if (!isMongoEnabled()) return false;
	const parsed = scanPersonalSkillsDir(userId).find((s) => s.name === skillName);
	if (!parsed) return false;
	await upsertPersonalSkill(userId, parsed);
	syncThrottles.set(userId, { lastRun: Date.now() });
	return true;
}
