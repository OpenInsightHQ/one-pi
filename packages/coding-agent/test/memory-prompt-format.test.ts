import { Types } from "mongoose";
import { describe, expect, test } from "vitest";
import { formatMemoriesPrompt } from "../src/core/mongo/memory-service.js";
import { formatAvailablePromptsPrompt } from "../src/core/mongo/prompt-service.js";
import type { MemoryEntryDoc } from "../src/core/mongo/types.js";

function memory(fields: Partial<MemoryEntryDoc> & Pick<MemoryEntryDoc, "key" | "value">): MemoryEntryDoc {
	return {
		_id: new Types.ObjectId(),
		userId: new Types.ObjectId(),
		type: "knowledge",
		...fields,
	} as MemoryEntryDoc;
}

describe("formatMemoriesPrompt", () => {
	test("returns empty string for no memories", () => {
		expect(formatMemoriesPrompt([])).toBe("");
	});

	test("groups memories by type in fixed order with empty-group placeholders", () => {
		const text = formatMemoriesPrompt([
			memory({ key: "home", value: "用户家在上海", type: "profile" }),
			memory({ key: "limit", value: "必须使用中文回复", type: "constraint" }),
		]);

		expect(text.startsWith("[用户长期记忆]")).toBe(true);
		expect(text).toContain("以下是关于用户的长期记忆摘要");
		const constraintIdx = text.indexOf("【强约束 | constraint】");
		const profileIdx = text.indexOf("【身份信息 | profile】");
		const preferenceIdx = text.indexOf("【偏好 | preference】");
		const knowledgeIdx = text.indexOf("【知识 | knowledge】");
		expect(constraintIdx).toBeGreaterThan(-1);
		expect(constraintIdx).toBeLessThan(profileIdx);
		expect(profileIdx).toBeLessThan(preferenceIdx);
		expect(preferenceIdx).toBeLessThan(knowledgeIdx);
		// Empty groups show the placeholder
		expect(text).toContain("【偏好 | preference】\n（暂无）");
	});

	test("lists key/value and memory ID per entry", () => {
		const mem = memory({ key: "user_preferences", value: "用户关注黑龙江农产品电商品类" });
		const text = formatMemoriesPrompt([mem]);
		expect(text).toContain("• user_preferences: 用户关注黑龙江农产品电商品类");
		expect(text).toContain(`  记忆ID: ${mem._id.toString()}`);
	});

	test("falls back to knowledge group for unknown types and missing type", () => {
		const text = formatMemoriesPrompt([
			memory({ key: "a", value: "va", type: "weird" as MemoryEntryDoc["type"] }),
			memory({ key: "b", value: "vb", type: undefined }),
		]);
		const knowledgeIdx = text.indexOf("【知识 | knowledge】");
		expect(knowledgeIdx).toBeGreaterThan(-1);
		const knowledgeSection = text.slice(knowledgeIdx);
		expect(knowledgeSection).toContain("• a: va");
		expect(knowledgeSection).toContain("• b: vb");
	});

	test("mentions the memory detail tools", () => {
		const text = formatMemoriesPrompt([memory({ key: "k", value: "v" })]);
		expect(text).toContain("read_memory_detail");
		expect(text).toContain("read_memory_conversation");
	});
});

describe("formatAvailablePromptsPrompt", () => {
	test("returns empty string for no prompts", () => {
		expect(formatAvailablePromptsPrompt([])).toBe("");
	});

	test("lists name, description, and location per prompt", () => {
		const text = formatAvailablePromptsPrompt([
			{
				key: "visualization.echarts",
				description: "ECharts visualization generation guide",
				piSavePath: "/home/codeuser/.pi/agent/prompts/visualization.echarts.md",
			},
		]);
		expect(text).toContain("<available_prompts>");
		expect(text).toContain("<name>visualization.echarts</name>");
		expect(text).toContain("<description>ECharts visualization generation guide</description>");
		expect(text).toContain("<location>/home/codeuser/.pi/agent/prompts/visualization.echarts.md</location>");
		expect(text).toContain("</available_prompts>");
	});

	test("escapes XML special characters", () => {
		const text = formatAvailablePromptsPrompt([{ key: "a<b", description: "d&d", piSavePath: "/p" }]);
		expect(text).toContain("<name>a&lt;b</name>");
		expect(text).toContain("<description>d&amp;d</description>");
	});
});
