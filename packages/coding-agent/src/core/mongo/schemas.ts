import { Schema } from "mongoose";
import type { AccessRoleDoc, AclEntryDoc, RoleDoc, SkillDoc, UserRoleDoc } from "./types.js";

/**
 * Mongoose schemas for the ACL / skill collections.
 *
 * These mirror the on-disk shape written by the Java/yudao backend that shares
 * the MongoDB instance with arp (LibreChat). We use `{ strict: false }` so
 * extra Java-specific fields (like `_class`, `__v`) are preserved on read and
 * never stripped on write.
 *
 * Collection names are set explicitly to match the existing collections.
 */

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

export const skillSchema = new Schema<SkillDoc>(
	{
		skillType: { type: String },
		name: { type: String, required: true },
		displayName: { type: String },
		description: { type: String },
		category: { type: String },
		savePath: { type: String },
		author: { type: Schema.Types.ObjectId },
		creatorUserId: { type: Number },
		tenantId: { type: Number },
		status: { type: Number, default: 1 },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "skills" },
);

// ---------------------------------------------------------------------------
// accessroles
// ---------------------------------------------------------------------------

export const accessRoleSchema = new Schema<AccessRoleDoc>(
	{
		accessRoleId: { type: String, required: true },
		name: { type: String, required: true },
		description: { type: String },
		permBits: { type: Number, required: true },
		resourceType: { type: String, required: true },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "accessroles" },
);

// ---------------------------------------------------------------------------
// aclentries
// ---------------------------------------------------------------------------

export const aclEntrySchema = new Schema<AclEntryDoc>(
	{
		principalType: { type: String, required: true },
		principalId: { type: Schema.Types.Mixed },
		principalModel: { type: String },
		resourceType: { type: String, required: true },
		resourceId: { type: Schema.Types.ObjectId, required: true },
		permBits: { type: Number, default: 1 },
		roleId: { type: Schema.Types.ObjectId },
		grantedBy: { type: Schema.Types.ObjectId },
		grantedAt: { type: Date, default: Date.now },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "aclentries" },
);

aclEntrySchema.index({ resourceType: 1, resourceId: 1 });
aclEntrySchema.index({ principalType: 1, principalId: 1 });
aclEntrySchema.index({ principalType: 1, resourceType: 1, permBits: 1 });

// ---------------------------------------------------------------------------
// userroles  (maps userId → role names, same pattern as arp)
// ---------------------------------------------------------------------------

export const userRoleSchema = new Schema<UserRoleDoc>(
	{
		userId: { type: Schema.Types.ObjectId },
		roleNames: { type: [String], default: [] },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "userroles" },
);

// ---------------------------------------------------------------------------
// roles  (role name → ObjectId lookup)
// ---------------------------------------------------------------------------

export const roleSchema = new Schema<RoleDoc>(
	{
		name: { type: String },
		description: { type: String },
		_class: { type: String },
	},
	{ strict: false, timestamps: true, collection: "roles" },
);
roleSchema.index({ name: 1 });
