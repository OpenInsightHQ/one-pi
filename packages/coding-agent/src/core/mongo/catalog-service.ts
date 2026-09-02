import { checkPermission } from "./acl.js";
import { hasCredentialsWithRef } from "./credential-service.js";
import { getDb, isMongoEnabled } from "./db.js";
import { getMcpServerModel } from "./models.js";
import { type AuthorizedSkill, getAgentSkillNames, getAuthorizedSkills, isAgentPrincipalId } from "./skill-catalog.js";
import type { McpServerDoc } from "./types.js";
import { PermissionBits } from "./types.js";

/**
 * Two-stage skill catalog service.
 *
 * Renders the O(N) `<available_http_skills>` / `<available_mcp_skills>`
 * directory blocks injected into the system prompt (see
 * docs/credential-skill-dev-plan.md §5.3). The model picks a skill from the
 * list, then uses the `skill_describe` / `skill_execute` agent tools to
 * discover and invoke individual APIs — full schemas are never resident in
 * the prompt.
 *
 * http skills are read directly from the `skills` collection (inline
 * `apiDefinitions`, no install to the pi environment). MCP skills are read
 * from the `mcpservers` collection (author-owned or ACL-granted).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpSkillCatalogEntry {
	name: string;
	description?: string;
	apiCount: number;
	requiresCredentials: boolean;
	/** false when requiresCredentials but no effective binding exists yet */
	credentialConfigured: boolean;
	skill: AuthorizedSkill;
}

export interface McpSkillCatalogEntry {
	name: string;
	serverUrl: string;
	description?: string;
	toolCount?: number;
	requiresCredentials: boolean;
	credentialConfigured: boolean;
	server: McpServerDoc;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** MCP server URL + header config extracted from the arp config blob. */
export function extractMcpConnection(server: McpServerDoc): {
	serverUrl: string;
	headers: Record<string, string>;
} {
	const config = server.config ?? {};
	const url = typeof config.url === "string" ? config.url : "";
	const headers: Record<string, string> = {};
	const rawHeaders = config.headers;
	if (rawHeaders && typeof rawHeaders === "object") {
		for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
			if (typeof value === "string") headers[key] = value;
		}
	}
	return { serverUrl: url, headers };
}

/** http-type skills visible to the principal (ACL / agent assignment). */
async function getHttpSkillEntries(userId: string, agentId?: string | null): Promise<HttpSkillCatalogEntry[]> {
	let skills: AuthorizedSkill[] = [];
	try {
		if (isAgentPrincipalId(agentId)) {
			const names = (await getAgentSkillNames(agentId)) ?? [];
			if (names.length === 0) return [];
			const authorized = await getAuthorizedSkills(userId);
			skills = authorized.filter((s) => names.includes(s.name));
		} else {
			skills = await getAuthorizedSkills(userId);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[Catalog] Failed to load http skills for user ${userId}: ${msg}`);
		return [];
	}

	const entries: HttpSkillCatalogEntry[] = [];
	for (const skill of skills) {
		if (skill.skillType !== "http") continue;
		const apiCount = Array.isArray(skill.apiDefinitions) ? skill.apiDefinitions.length : 0;
		if (apiCount === 0) continue;
		const requiresCredentials = skill.requiresCredentials === true;
		const credentialConfigured =
			!requiresCredentials || (await hasCredentialsWithRef(userId, "skill", skill.name, skill.credentialRef));
		entries.push({
			name: skill.name,
			description: skill.description ?? skill.displayName,
			apiCount,
			requiresCredentials,
			credentialConfigured,
			skill,
		});
	}
	return entries;
}

/** MCP servers visible to the user: own + ACL-granted (`resourceType: "mcp"`). */
async function getMcpSkillEntries(userId: string): Promise<McpSkillCatalogEntry[]> {
	if (!isMongoEnabled()) return [];
	await getDb();

	const McpServer = getMcpServerModel();
	const docs: McpServerDoc[] = await McpServer.find({}).lean<McpServerDoc[]>().exec();

	const visible: McpServerDoc[] = [];
	for (const doc of docs) {
		if (doc.author && doc.author.toString() === userId) {
			visible.push(doc);
			continue;
		}
		const granted = await checkPermission(userId, "mcp", String(doc._id), PermissionBits.VIEW);
		if (granted) visible.push(doc);
	}

	const entries: McpSkillCatalogEntry[] = [];
	for (const server of visible) {
		const { serverUrl } = extractMcpConnection(server);
		if (!serverUrl) continue;
		const requiresCredentials = server.requiresCredentials === true;
		const credentialConfigured =
			!requiresCredentials || (await hasCredentialsWithRef(userId, "mcp", server.serverName, server.credentialRef));
		entries.push({
			name: server.serverName,
			serverUrl,
			description: typeof server.config?.description === "string" ? server.config.description : undefined,
			toolCount: countCachedMcpTools(server),
			requiresCredentials,
			credentialConfigured,
			server,
		});
	}
	return entries;
}

/** arp caches discovered tools on the server doc (`config.tools`/`tools`); best-effort count. */
function countCachedMcpTools(server: McpServerDoc): number | undefined {
	const candidate = server.config?.tools ?? (server as { tools?: unknown }).tools;
	if (Array.isArray(candidate)) return candidate.length;
	return undefined;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function credentialMarker(entry: { requiresCredentials: boolean; credentialConfigured: boolean }): string {
	if (!entry.requiresCredentials) return "";
	return entry.credentialConfigured ? " | credentials: configured" : " | credentials: NOT configured";
}

export function formatHttpSkillsPrompt(entries: HttpSkillCatalogEntry[]): string {
	if (entries.length === 0) return "";
	const lines = [
		"\n\nThe following HTTP API skills are available.",
		'Use skill_describe(skill) to list their APIs, then skill_execute(kind="http", skill, api, params) to call one.',
		"",
		"<available_http_skills>",
	];
	for (const entry of entries) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(entry.name)}</name>`);
		if (entry.description) lines.push(`    <description>${escapeXml(entry.description)}</description>`);
		lines.push(`    <apis>${entry.apiCount}</apis>`);
		lines.push(`    <status>http${credentialMarker(entry)}</status>`);
		lines.push("  </skill>");
	}
	lines.push("</available_http_skills>");
	return lines.join("\n");
}

export function formatMcpSkillsPrompt(entries: McpSkillCatalogEntry[]): string {
	if (entries.length === 0) return "";
	const lines = [
		"\n\nThe following MCP servers are available.",
		'Use skill_describe(skill) to list a server\'s tools, then skill_execute(kind="mcp", skill, api, params) to call one.',
		"",
		"<available_mcp_skills>",
	];
	for (const entry of entries) {
		lines.push("  <server>");
		lines.push(`    <name>${escapeXml(entry.name)}</name>`);
		if (entry.description) lines.push(`    <description>${escapeXml(entry.description)}</description>`);
		if (entry.toolCount !== undefined) lines.push(`    <tools>${entry.toolCount}</tools>`);
		lines.push(`    <status>mcp${credentialMarker(entry)}</status>`);
		lines.push("  </server>");
	}
	lines.push("</available_mcp_skills>");
	return lines.join("\n");
}

/**
 * Builds the combined catalog suffix appended to the system prompt.
 * Returns "" when neither section has entries or when MongoDB is disabled.
 */
export async function buildSkillCatalogSuffix(userId: string, agentId?: string | null): Promise<string> {
	if (!isMongoEnabled()) return "";
	try {
		const [httpEntries, mcpEntries] = await Promise.all([
			getHttpSkillEntries(userId, agentId),
			getMcpSkillEntries(userId),
		]);
		const parts = [formatHttpSkillsPrompt(httpEntries), formatMcpSkillsPrompt(mcpEntries)].filter(Boolean);
		return parts.join("\n");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[Catalog] Failed to build skill catalog for user ${userId}: ${msg}`);
		return "";
	}
}

// ---------------------------------------------------------------------------
// Single-entry lookups (used by the skill dispatch tools)
// ---------------------------------------------------------------------------

/** Finds one http-type skill visible to the principal, by name. */
export async function findHttpSkillEntry(
	userId: string,
	agentId: string | null | undefined,
	skillName: string,
): Promise<HttpSkillCatalogEntry | null> {
	const entries = await getHttpSkillEntries(userId, agentId);
	return entries.find((e) => e.name === skillName) ?? null;
}

/** Finds one repo-type (script) skill visible to the principal, by name. */
export async function findRepoSkillEntry(
	userId: string,
	agentId: string | null | undefined,
	skillName: string,
): Promise<AuthorizedSkill | null> {
	try {
		if (isAgentPrincipalId(agentId)) {
			const names = (await getAgentSkillNames(agentId)) ?? [];
			if (!names.includes(skillName)) return null;
		}
		const skills = await getAuthorizedSkills(userId);
		return skills.find((s) => s.name === skillName && s.skillType !== "http") ?? null;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[Catalog] Failed to load repo skill ${skillName} for user ${userId}: ${msg}`);
		return null;
	}
}

/** Finds one MCP server visible to the user, by serverName. */
export async function findMcpServerEntry(userId: string, serverName: string): Promise<McpSkillCatalogEntry | null> {
	const entries = await getMcpSkillEntries(userId);
	return entries.find((e) => e.name === serverName) ?? null;
}

// ---------------------------------------------------------------------------
// Machine-readable catalog items (public /skills/catalog endpoint)
// ---------------------------------------------------------------------------

export interface HttpCatalogItem {
	name: string;
	description?: string;
	apiCount: number;
	requiresCredentials: boolean;
	credentialConfigured: boolean;
}

export interface McpCatalogItem {
	name: string;
	description?: string;
	toolCount?: number;
	requiresCredentials: boolean;
	credentialConfigured: boolean;
}

function toHttpItem(entry: HttpSkillCatalogEntry): HttpCatalogItem {
	return {
		name: entry.name,
		description: entry.description,
		apiCount: entry.apiCount,
		requiresCredentials: entry.requiresCredentials,
		credentialConfigured: entry.credentialConfigured,
	};
}

function toMcpItem(entry: McpSkillCatalogEntry): McpCatalogItem {
	return {
		name: entry.name,
		description: entry.description,
		toolCount: entry.toolCount,
		requiresCredentials: entry.requiresCredentials,
		credentialConfigured: entry.credentialConfigured,
	};
}

export async function listHttpCatalogEntries(userId: string, agentId?: string | null): Promise<HttpCatalogItem[]> {
	const entries = await getHttpSkillEntries(userId, agentId);
	return entries.map(toHttpItem);
}

export async function listMcpCatalogEntries(userId: string): Promise<McpCatalogItem[]> {
	const entries = await getMcpSkillEntries(userId);
	return entries.map(toMcpItem);
}
