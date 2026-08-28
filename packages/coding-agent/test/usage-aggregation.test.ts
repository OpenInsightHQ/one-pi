import { describe, expect, it } from "vitest";
import { addUsageToTotals, aggregateUsage, emptyUsageTotals, type UsageTotals } from "../src/core/usage-aggregation.js";

describe("aggregateUsage", () => {
	it("accumulates all model calls and includes cached prompt tokens", () => {
		let usage = aggregateUsage(undefined, {
			input: 186,
			output: 378,
			cacheRead: 12_000,
			cacheWrite: 0,
		});
		usage = aggregateUsage(usage, {
			input: 250,
			output: 500,
			cacheRead: 15_000,
			cacheWrite: 100,
		});

		expect(usage).toEqual({
			prompt_tokens: 27_536,
			completion_tokens: 878,
			total_tokens: 28_414,
			cache_read_tokens: 27_000,
			cache_write_tokens: 100,
			totalInputTokens: 436,
			totalOutputTokens: 878,
			totalCacheReadTokens: 27_000,
			totalCacheWriteTokens: 100,
		});
	});

	it("returns zero-safe totals when a provider reports no usage", () => {
		expect(aggregateUsage(undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
		});
	});

	it("keeps totalInputTokens free of cache tokens (strict separation)", () => {
		const usage = aggregateUsage(undefined, {
			input: 100,
			output: 50,
			cacheRead: 9_000,
			cacheWrite: 1_000,
		});
		// prompt_tokens folds cache in (OpenAI-style), but the total* counters do not
		expect(usage.prompt_tokens).toBe(10_100);
		expect(usage.totalInputTokens).toBe(100);
		expect(usage.totalCacheReadTokens).toBe(9_000);
		expect(usage.totalCacheWriteTokens).toBe(1_000);
		expect(usage.totalOutputTokens).toBe(50);
	});
});

describe("UsageTotals", () => {
	it("emptyUsageTotals starts at zero", () => {
		expect(emptyUsageTotals()).toEqual({
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
		});
	});

	it("addUsageToTotals accumulates per-category without mixing", () => {
		const totals: UsageTotals = emptyUsageTotals();
		addUsageToTotals(totals, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
		addUsageToTotals(totals, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
		expect(totals).toEqual({
			totalInputTokens: 11,
			totalOutputTokens: 22,
			totalCacheReadTokens: 33,
			totalCacheWriteTokens: 44,
		});
	});
});
