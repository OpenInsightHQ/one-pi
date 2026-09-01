import { describe, expect, it } from "vitest";
import {
	extractMcpConnection,
	formatHttpSkillsPrompt,
	formatMcpSkillsPrompt,
	type HttpSkillCatalogEntry,
	type McpSkillCatalogEntry,
} from "../src/core/mongo/catalog-service.js";

const httpEntry = (overrides: Partial<HttpSkillCatalogEntry> = {}): HttpSkillCatalogEntry => ({
	name: "feishu",
	description: "飞书消息与文档",
	apiCount: 8,
	requiresCredentials: true,
	credentialConfigured: true,
	skill: {
		id: "6640aaaaaaaaaaaaaaaaaa",
		name: "feishu",
		savePath: "",
		skillType: "http",
	},
	...overrides,
});

describe("formatHttpSkillsPrompt", () => {
	it("renders one <skill> entry per skill with api count and credential status", () => {
		const text = formatHttpSkillsPrompt([httpEntry()]);
		expect(text).toContain("<available_http_skills>");
		expect(text).toContain("<name>feishu</name>");
		expect(text).toContain("<apis>8</apis>");
		expect(text).toContain("credentials: configured");
		expect(text).toContain("skill_execute");
	});

	it("marks unconfigured credentials", () => {
		const text = formatHttpSkillsPrompt([httpEntry({ credentialConfigured: false })]);
		expect(text).toContain("credentials: NOT configured");
	});

	it("escapes XML in descriptions", () => {
		const text = formatHttpSkillsPrompt([httpEntry({ description: "a <b>&\"'</b>" })]);
		expect(text).toContain("&lt;b&gt;&amp;&quot;&apos;&lt;/b&gt;");
	});

	it("returns empty string for no entries", () => {
		expect(formatHttpSkillsPrompt([])).toBe("");
	});
});

describe("formatMcpSkillsPrompt", () => {
	const entry = (overrides: Partial<McpSkillCatalogEntry> = {}): McpSkillCatalogEntry => ({
		name: "modelscope",
		serverUrl: "https://mcp.modelscope.cn/mcp",
		description: "模型服务",
		toolCount: 11,
		requiresCredentials: false,
		credentialConfigured: true,
		server: {
			_id: { toString: () => "6640bbbbbbbbbbbbbbbbbb" } as never,
			serverName: "modelscope",
		},
		...overrides,
	});

	it("renders one <server> entry per server", () => {
		const text = formatMcpSkillsPrompt([entry()]);
		expect(text).toContain("<available_mcp_skills>");
		expect(text).toContain("<name>modelscope</name>");
		expect(text).toContain("<tools>11</tools>");
		expect(text).not.toContain("credentials:");
	});

	it("returns empty string for no entries", () => {
		expect(formatMcpSkillsPrompt([])).toBe("");
	});
});

describe("extractMcpConnection", () => {
	it("extracts url and string headers from the arp config blob", () => {
		const { serverUrl, headers } = extractMcpConnection({
			_id: { toString: () => "x" } as never,
			serverName: "s",
			config: {
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer x", Count: 3 },
				other: true,
			},
		});
		expect(serverUrl).toBe("https://example.com/mcp");
		expect(headers).toEqual({ Authorization: "Bearer x" });
	});

	it("returns empty url when config is missing", () => {
		const { serverUrl, headers } = extractMcpConnection({
			_id: { toString: () => "x" } as never,
			serverName: "s",
		});
		expect(serverUrl).toBe("");
		expect(headers).toEqual({});
	});
});
