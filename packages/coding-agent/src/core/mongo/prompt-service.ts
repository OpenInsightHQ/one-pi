import { findAccessibleResourceIds } from "./acl.js";
import { getDb, isMongoEnabled } from "./db.js";
import { getSystemPromptModel } from "./models.js";
import { PermissionBits, ResourceType, type SystemPromptDoc } from "./types.js";

/**
 * System-prompt catalog service (shared with arp/LibreChat).
 *
 * Reads the `systemprompts` collection and lists the prompts flagged for pi
 * (`piPrompt: true` with a valid `piSavePath`) that the given user has VIEW
 * permission on (ACL `resourceType: "systemPrompt"`). Mirrors the
 * `<available_prompts>` injection that arp previously appended to the
 * `pi.system` prompt.
 */

export interface AvailablePrompt {
	key: string;
	description?: string;
	/** Absolute path of the prompt file on this server, readable via the read tool */
	piSavePath?: string;
}

/**
 * Returns the pi-flagged system prompts within the user's permission scope
 * (ACL VIEW on `resourceType: "systemPrompt"`), sorted by key.
 *
 * Returns an empty array when MongoDB is disabled or the user has no grants.
 */
export async function getAccessiblePiPrompts(userId: string): Promise<AvailablePrompt[]> {
	if (!isMongoEnabled()) return [];
	await getDb();

	const resourceIds = await findAccessibleResourceIds(userId, ResourceType.SYSTEM_PROMPT, PermissionBits.VIEW);
	if (resourceIds.length === 0) return [];

	const SystemPrompt = getSystemPromptModel();
	const docs: SystemPromptDoc[] = await SystemPrompt.find({
		_id: { $in: resourceIds },
		piPrompt: true,
		piSavePath: { $ne: "", $exists: true },
	})
		.sort({ key: 1 })
		.lean()
		.exec();

	return docs.map((doc) => ({
		key: doc.key,
		description: doc.description,
		piSavePath: doc.piSavePath,
	}));
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Formats the `<available_prompts>` section appended to the system prompt.
 *
 * Each entry lists the prompt key, description, and the server-local file
 * location; the model loads the full prompt content with the read tool when
 * a task matches the description.
 *
 * Returns an empty string when no prompts are available.
 */
export function formatAvailablePromptsPrompt(prompts: AvailablePrompt[]): string {
	if (prompts.length === 0) return "";
	const lines = [
		"The following system prompts provide specialized instructions for specific tasks.",
		"Use the read tool to load the prompt file at its <location> when the task matches its description.",
		"<available_prompts>",
	];
	for (const prompt of prompts) {
		lines.push("  <prompt>");
		lines.push(`    <name>${escapeXml(prompt.key)}</name>`);
		lines.push(`    <description>${escapeXml(prompt.description ?? "")}</description>`);
		lines.push(`    <location>${escapeXml(prompt.piSavePath ?? "")}</location>`);
		lines.push("  </prompt>");
	}
	lines.push("</available_prompts>");
	return lines.join("\n");
}
