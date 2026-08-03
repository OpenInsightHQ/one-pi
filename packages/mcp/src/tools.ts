import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { MCPClient } from "./client.js";
import type { MCPContent, MCPProperty, MCPTool } from "./types.js";

export function mcpToolToAgentTool(mcpTool: MCPTool, client: MCPClient): AgentTool {
	const parameters = convertInputSchema(mcpTool.inputSchema);

	return {
		name: mcpTool.name,
		label: mcpTool.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
		description: mcpTool.description ?? "",
		parameters,
		execute: async (_toolCallId, params) => {
			const result = await client.callTool({
				name: mcpTool.name,
				arguments: params as Record<string, unknown>,
			});

			const content = convertContent(result.content);
			const isError = result.isError ?? false;

			return {
				content,
				details: { toolName: mcpTool.name, isError },
			};
		},
	};
}

export function convertInputSchema(schema: MCPTool["inputSchema"]): TSchema {
	if (!schema.properties || Object.keys(schema.properties).length === 0) {
		return Type.Object({}, { additionalProperties: true });
	}

	const properties: Record<string, TSchema> = {};

	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		properties[key] = schemaPropertyToTypebox(prop);
	}

	return Type.Object(properties, {
		additionalProperties: schema.additionalProperties ?? true,
	});
}

function schemaPropertyToTypebox(prop: MCPProperty): TSchema {
	switch (prop.type) {
		case "string":
			return Type.String({ description: prop.description });
		case "number":
			return Type.Number({ description: prop.description });
		case "integer":
			return Type.Integer({ description: prop.description });
		case "boolean":
			return Type.Boolean({ description: prop.description });
		case "array":
			return Type.Array(Type.String(), { description: prop.description });
		case "object":
			return Type.Object({}, { description: prop.description });
		default:
			return Type.String({ description: prop.description });
	}
}

function convertContent(contents: MCPContent[]): { type: "text"; text: string }[] {
	return contents.map((content) => {
		if (content.type === "text") {
			return { type: "text" as const, text: content.text ?? "" };
		}
		if (content.type === "image") {
			return { type: "text" as const, text: `[Image: ${content.mimeType ?? "image"}]` };
		}
		return { type: "text" as const, text: JSON.stringify(content) };
	});
}

export async function loadToolsFromServer(url: string, headers?: Record<string, string>): Promise<AgentTool[]> {
	const client = new MCPClient({ url, headers });
	await client.connect();
	const mcpTools = await client.listTools();
	return mcpTools.map((tool) => mcpToolToAgentTool(tool, client));
}
