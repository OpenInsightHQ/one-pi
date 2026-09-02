import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getDb, isMongoEnabled } from "./db.js";
import { getSkillCredentialModel } from "./models.js";
import { ADMIN_CREDENTIAL_USER_ID, type CredentialResourceType, type SkillCredentialDoc } from "./types.js";

/**
 * Skill/MCP credential service.
 *
 * Credentials live in the `credentials` collection, encrypted with
 * AES-256-GCM under a master key from the `PI_CREDENTIAL_MASTER_KEY` env var
 * (base64, 32 bytes). The same cipher spec is implemented by dmp (Java) and
 * arp (Node) — keep the three implementations in sync when changing anything
 * here (see docs/credential-skill-dev-plan.md §3.3).
 *
 * Plaintext values only ever exist in this process, behind a short-lived
 * in-memory cache. No API of this service returns cipher material.
 *
 * Resolution rule (docs/credential-skill-dev-plan.md §3.4):
 *   - requiresCredentials=false          → no credentials needed
 *   - userManaged=true  → user binding first, admin binding as fallback
 *   - userManaged=false → admin binding only
 */

const CIPHER = "aes-256-gcm";
const CACHE_TTL_MS = 5 * 60 * 1000;

const MASTER_KEY_ENV = "PI_CREDENTIAL_MASTER_KEY";

interface CacheEntry {
	values: Record<string, string>;
	expiresAt: number;
}

const plaintextCache = new Map<string, CacheEntry>();
let warnedAboutKey = false;

// ---------------------------------------------------------------------------
// Encryption primitives (pure — exported for tests)
// ---------------------------------------------------------------------------

/** Parses and validates the base64 32-byte master key; null when unset/invalid. */
export function getMasterKey(): Buffer | null {
	const raw = process.env[MASTER_KEY_ENV];
	if (!raw) return null;
	const key = Buffer.from(raw, "base64");
	if (key.length !== 32) {
		if (!warnedAboutKey) {
			console.error(
				`[Credentials] ${MASTER_KEY_ENV} must be a base64-encoded 32-byte key (got ${key.length} bytes); credential store disabled`,
			);
			warnedAboutKey = true;
		}
		return null;
	}
	return key;
}

/** Whether credentials can be written/decrypted in this process. */
export function isCredentialStoreConfigured(): boolean {
	return getMasterKey() !== null;
}

export interface EncryptedCredential {
	iv: string;
	authTag: string;
	data: string;
}

/** Encrypts a `{ secretKey: value }` JSON object with AES-256-GCM. */
export function encryptCredentialValues(values: Record<string, string>, key: Buffer): EncryptedCredential {
	const iv = randomBytes(12);
	const cipher = createCipheriv(CIPHER, key, iv);
	const plaintext = Buffer.from(JSON.stringify(values), "utf-8");
	const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return {
		iv: iv.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
}

/** Decrypts a credential document back into its `{ secretKey: value }` object. */
export function decryptCredentialValues(encrypted: EncryptedCredential, key: Buffer): Record<string, string> {
	const decipher = createDecipheriv(CIPHER, key, Buffer.from(encrypted.iv, "base64"));
	decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
	const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]);
	return JSON.parse(plaintext.toString("utf-8")) as Record<string, string>;
}

/**
 * Exact-value scrubbing: replaces every occurrence of the given secret values
 * in `text` with `***`. Used before skill output is returned to the model.
 * Values are replaced longest-first so overlapping prefixes collapse fully.
 */
export function maskSecretValues(text: string, values: Record<string, string>): string {
	const sorted = Object.values(values)
		.filter((v) => typeof v === "string" && v.length >= 4)
		.sort((a, b) => b.length - a.length);
	let result = text;
	for (const value of sorted) {
		if (result.includes(value)) result = result.split(value).join("***");
	}
	return result;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheKey(userId: string, resourceType: CredentialResourceType, resourceName: string): string {
	return `${userId}:${resourceType}:${resourceName}`;
}

function readCache(userId: string, resourceType: CredentialResourceType, resourceName: string) {
	const entry = plaintextCache.get(cacheKey(userId, resourceType, resourceName));
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		plaintextCache.delete(cacheKey(userId, resourceType, resourceName));
		return null;
	}
	return entry.values;
}

function writeCache(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
	values: Record<string, string>,
): void {
	plaintextCache.set(cacheKey(userId, resourceType, resourceName), {
		values,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
}

function invalidateCache(userId: string, resourceType: CredentialResourceType, resourceName: string): void {
	plaintextCache.delete(cacheKey(userId, resourceType, resourceName));
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

async function findCredentialDoc(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
): Promise<SkillCredentialDoc | null> {
	if (!isMongoEnabled()) return null;
	await getDb();
	const SkillCredential = getSkillCredentialModel();
	return SkillCredential.findOne({ userId, resourceType, resourceName }).lean<SkillCredentialDoc>().exec();
}

/** Loads, decrypts and caches the credential values for one principal. */
async function loadValues(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
): Promise<Record<string, string> | null> {
	const cached = readCache(userId, resourceType, resourceName);
	if (cached) return cached;

	const key = getMasterKey();
	if (!key) return null;

	const doc = await findCredentialDoc(userId, resourceType, resourceName);
	// Declaration-only docs (no cipher data) count as unbound.
	if (!doc || !doc.data) return null;

	let values: Record<string, string>;
	try {
		values = decryptCredentialValues({ iv: doc.iv, authTag: doc.authTag, data: doc.data }, key);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(
			`[Credentials] Failed to decrypt ${resourceType}/${resourceName} for user ${userId} (wrong master key or corrupted document): ${msg}`,
		);
		return null;
	}
	writeCache(userId, resourceType, resourceName, values);
	return values;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedCredential {
	/** Which binding satisfied the request */
	source: "user" | "admin";
	values: Record<string, string>;
}

export interface SetCredentialParams {
	resourceType: CredentialResourceType;
	resourceName: string;
	/** Plain values keyed by `credentialSchema[].secretKey` */
	values: Record<string, string>;
	/** Owning user; omit (or pass ADMIN_CREDENTIAL_USER_ID) for admin-managed bindings */
	userId?: string;
}

/**
 * Stores (upserts) an encrypted credential binding. Throws when MongoDB is
 * disabled or no valid master key is configured — never stores plaintext.
 */
export async function setCredentials(params: SetCredentialParams): Promise<void> {
	const { resourceType, resourceName, values } = params;
	const userId = params.userId ?? ADMIN_CREDENTIAL_USER_ID;
	if (!isMongoEnabled()) throw new Error("Credential store requires MongoDB (MONGO_URI unset)");
	const key = getMasterKey();
	if (!key) throw new Error(`Credential store requires a valid ${MASTER_KEY_ENV}`);

	const encrypted = encryptCredentialValues(values, key);
	await getDb();
	const SkillCredential = getSkillCredentialModel();
	await SkillCredential.updateOne(
		{ userId, resourceType, resourceName },
		{
			$set: {
				userId,
				resourceType,
				resourceName,
				cipher: CIPHER,
				...encrypted,
				keyVersion: 1,
				status: "active",
				updatedAt: new Date(),
			},
		},
		{ upsert: true },
	).exec();
	invalidateCache(userId, resourceType, resourceName);
}

/** Deletes a credential binding. */
export async function deleteCredentials(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
): Promise<void> {
	if (!isMongoEnabled()) return;
	await getDb();
	const SkillCredential = getSkillCredentialModel();
	await SkillCredential.deleteOne({ userId, resourceType, resourceName }).exec();
	invalidateCache(userId, resourceType, resourceName);
}

/** Admin-managed binding for one resource (shared across users). */
export async function getAdminCredentials(
	resourceType: CredentialResourceType,
	resourceName: string,
): Promise<Record<string, string> | null> {
	return loadValues(ADMIN_CREDENTIAL_USER_ID, resourceType, resourceName);
}

/** A specific user's own binding for one resource (no admin fallback). */
export async function getUserCredentials(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
): Promise<Record<string, string> | null> {
	return loadValues(userId, resourceType, resourceName);
}

/**
 * Resolves the effective credential for a user against the §3.4 rule.
 *
 * @param opts.userManaged `true` (default) = user binding first, admin
 *   fallback; `false` = admin binding only.
 */
export async function resolveCredentials(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
	opts?: { userManaged?: boolean },
): Promise<ResolvedCredential | null> {
	const userManaged = opts?.userManaged ?? true;
	if (userManaged) {
		const userValues = await loadValues(userId, resourceType, resourceName);
		if (userValues) return { source: "user", values: userValues };
	}
	const adminValues = await loadValues(ADMIN_CREDENTIAL_USER_ID, resourceType, resourceName);
	if (adminValues) return { source: "admin", values: adminValues };
	return null;
}

/**
 * Reference-based resolution (either/or, no fallback): when the referenced
 * credential has admin-configured values it is admin-managed (admin wins);
 * otherwise ONLY the user's own binding of that credential counts. Used by
 * the skill dispatch executors and catalog status markers.
 */
export async function resolveCredentialsWithRef(
	userId: string,
	_resourceType: CredentialResourceType,
	_resourceName: string,
	credentialRef?: string | null,
): Promise<ResolvedCredential | null> {
	if (!credentialRef) return null;
	const adminValues = await loadValues(ADMIN_CREDENTIAL_USER_ID, "credential", credentialRef);
	if (adminValues) return { source: "admin", values: adminValues };
	const userValues = await loadValues(userId, "credential", credentialRef);
	return userValues ? { source: "user", values: userValues } : null;
}

/**
 * Reference-aware existence check (no decryption): the referenced credential
 * counts as configured when the admin set values OR the user bound their own.
 */
export async function hasCredentialsWithRef(
	userId: string,
	_resourceType: CredentialResourceType,
	_resourceName: string,
	credentialRef?: string | null,
): Promise<boolean> {
	if (!credentialRef) return false;
	if (!isMongoEnabled()) return false;
	await getDb();
	const withValues = { resourceType: "credential" as const, resourceName: credentialRef, data: { $ne: null } };
	const SkillCredential = getSkillCredentialModel();
	const admin = await SkillCredential.exists({
		userId: ADMIN_CREDENTIAL_USER_ID,
		...withValues,
	}).exec();
	if (admin) return true;
	const own = await SkillCredential.exists({ userId, ...withValues }).exec();
	return own !== null;
}

/**
 * Whether an effective credential exists for a user (per the §3.4 rule).
 * Cheaper than {@link resolveCredentials}: checks document existence only,
 * never decrypts.
 */
export async function hasCredentials(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
	opts?: { userManaged?: boolean },
): Promise<boolean> {
	if (!isMongoEnabled()) return false;
	await getDb();
	const userManaged = opts?.userManaged ?? true;
	// Declaration-only docs (data == null) do not count as configured.
	const withValues = { resourceType, resourceName, data: { $ne: null } };
	const SkillCredential = getSkillCredentialModel();
	if (userManaged) {
		const own = await SkillCredential.exists({ userId, ...withValues }).exec();
		if (own) return true;
	}
	const admin = await SkillCredential.exists({
		userId: ADMIN_CREDENTIAL_USER_ID,
		...withValues,
	}).exec();
	return admin !== null;
}

/** Records a verification outcome on a binding (used by verify endpoints). */
export async function markCredentialStatus(
	userId: string,
	resourceType: CredentialResourceType,
	resourceName: string,
	status: "active" | "invalid",
): Promise<void> {
	if (!isMongoEnabled()) return;
	await getDb();
	const SkillCredential = getSkillCredentialModel();
	await SkillCredential.updateOne(
		{ userId, resourceType, resourceName },
		{ $set: { status, lastVerifiedAt: new Date() } },
	).exec();
}
