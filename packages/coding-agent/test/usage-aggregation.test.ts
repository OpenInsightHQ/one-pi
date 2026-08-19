import { describe, expect, it } from "vitest";
import { aggregateUsage } from "../src/core/usage-aggregation.js";

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
		});
	});

	it("returns zero-safe totals when a provider reports no usage", () => {
		expect(aggregateUsage(undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		});
	});
});
