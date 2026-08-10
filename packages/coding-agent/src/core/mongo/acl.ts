import { Types } from "mongoose";
import { getDb, isMongoEnabled } from "./db.js";
import { getAclEntryModel, getRoleModel, getUserRoleModel } from "./models.js";
import { type AclEntryDoc, PermissionBits, type Principal, PrincipalType, type ResourceType } from "./types.js";

/**
 * ACL (Access Control List) service.
 *
 * Implements the permission model shared with the arp/LibreChat system:
 *
 * 1. Resolve a user to a list of principals: [USER, ROLE..., PUBLIC]
 * 2. Build a MongoDB `$or` query from those principals
 * 3. Query `aclentries` for matching grants with the required permission bits
 *
 * Every call is self-contained (connect → resolve → query) so callers don't
 * need to manage connection state.
 */

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a userId into the full list of principals that represent the user
 * for ACL matching: the user themself, every role they belong to, and the
 * implicit `public` principal.
 *
 * Role resolution follows the arp pattern:
 *   - Query `userroles` collection for `{ userId }` → `roleNames`
 *   - Resolve role names to `roles._id` (ObjectId) via the `roles` collection
 *
 * If either collection is missing or the lookup fails, the user still gets
 * USER + PUBLIC principals (graceful degradation).
 */
export async function resolveUserPrincipals(userId: string): Promise<Principal[]> {
	const userObjectId = new Types.ObjectId(userId);
	const principals: Principal[] = [{ principalType: PrincipalType.USER, principalId: userObjectId }];

	try {
		const UserRole = getUserRoleModel();
		const Role = getRoleModel();

		const userRoleDoc = await UserRole.findOne({ userId: userObjectId }).lean().exec();
		const roleNames = userRoleDoc?.roleNames ?? [];

		if (roleNames.length > 0) {
			const roleDocs = await Role.find({ name: { $in: roleNames } })
				.select("_id")
				.lean()
				.exec();
			for (const doc of roleDocs) {
				principals.push({ principalType: PrincipalType.ROLE, principalId: doc._id });
			}
		}
	} catch (error) {
		console.warn("[MongoDB] Failed to resolve user roles, continuing with USER+PUBLIC:", error);
	}

	principals.push({ principalType: PrincipalType.PUBLIC });
	return principals;
}

/**
 * Builds the MongoDB `$or` clause for a list of principals.
 * PUBLIC principals have no `principalId`.
 */
function buildPrincipalQuery(principals: Principal[]): Record<string, unknown>[] {
	return principals.map((p) => {
		if (p.principalType === PrincipalType.PUBLIC) {
			return { principalType: PrincipalType.PUBLIC };
		}
		return { principalType: p.principalType, principalId: p.principalId };
	});
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

/**
 * Returns true if `userId` has `requiredPermission` on the given resource.
 *
 * @param userId        MongoDB User ObjectId as a hex string
 * @param resourceType  e.g. `"skill"`
 * @param resourceId    The resource _id (ObjectId or hex string)
 * @param requiredPermission  Bitmask from {@link PermissionBits} (default VIEW)
 */
export async function checkPermission(
	userId: string,
	resourceType: ResourceType | string,
	resourceId: Types.ObjectId | string,
	requiredPermission: number = PermissionBits.VIEW,
): Promise<boolean> {
	if (!isMongoEnabled()) return false;
	await getDb();

	const resourceObjectId = typeof resourceId === "string" ? new Types.ObjectId(resourceId) : resourceId;

	const principals = await resolveUserPrincipals(userId);
	const AclEntry = getAclEntryModel();

	const entry = await AclEntry.findOne({
		$or: buildPrincipalQuery(principals),
		resourceType,
		resourceId: resourceObjectId,
		permBits: { $bitsAllSet: requiredPermission },
	})
		.lean()
		.exec();

	return Boolean(entry);
}

/**
 * Returns the set of resourceIds of the given type that `userId` can access
 * with at least `requiredPermission`.
 */
export async function findAccessibleResourceIds(
	userId: string,
	resourceType: ResourceType | string,
	requiredPermission: number = PermissionBits.VIEW,
): Promise<Types.ObjectId[]> {
	if (!isMongoEnabled()) return [];
	await getDb();

	const principals = await resolveUserPrincipals(userId);
	const AclEntry = getAclEntryModel();

	const ids = (await AclEntry.find({
		$or: buildPrincipalQuery(principals),
		resourceType,
		permBits: { $bitsAllSet: requiredPermission },
	})
		.distinct("resourceId")
		.exec()) as unknown as Types.ObjectId[];

	return ids;
}

/**
 * Returns the union of permission bits the user has on a given resource
 * (OR-merged across all matching ACL entries).
 */
export async function getEffectivePermissions(
	userId: string,
	resourceType: ResourceType | string,
	resourceId: Types.ObjectId | string,
): Promise<number> {
	if (!isMongoEnabled()) return 0;
	await getDb();

	const resourceObjectId = typeof resourceId === "string" ? new Types.ObjectId(resourceId) : resourceId;

	const principals = await resolveUserPrincipals(userId);
	const AclEntry = getAclEntryModel();

	const entries: AclEntryDoc[] = await AclEntry.find({
		$or: buildPrincipalQuery(principals),
		resourceType,
		resourceId: resourceObjectId,
	})
		.lean()
		.exec();

	return entries.reduce((bits, entry) => bits | (entry.permBits ?? 0), 0);
}
