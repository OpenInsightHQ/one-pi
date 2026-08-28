export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Cumulative usage totals for metering and display (turn or session scope).
 * Each counter accumulates exactly one usage category; totals are never mixed
 * into per-message token counts.
 */
export interface UsageTotals {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
}

export function emptyUsageTotals(): UsageTotals {
	return {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: PiUsage): UsageTotals {
	totals.totalInputTokens += usage.input;
	totals.totalOutputTokens += usage.output;
	totals.totalCacheReadTokens += usage.cacheRead;
	totals.totalCacheWriteTokens += usage.cacheWrite;
	return totals;
}

export interface AggregatedUsage extends UsageTotals {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

export function aggregateUsage(current: AggregatedUsage | undefined, usage: PiUsage): AggregatedUsage {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const output = usage.output;
	const previous: AggregatedUsage = current ?? {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		...emptyUsageTotals(),
	};

	return {
		prompt_tokens: previous.prompt_tokens + input,
		completion_tokens: previous.completion_tokens + output,
		total_tokens: previous.total_tokens + input + output,
		cache_read_tokens: previous.cache_read_tokens + usage.cacheRead,
		cache_write_tokens: previous.cache_write_tokens + usage.cacheWrite,
		totalInputTokens: previous.totalInputTokens + usage.input,
		totalOutputTokens: previous.totalOutputTokens + usage.output,
		totalCacheReadTokens: previous.totalCacheReadTokens + usage.cacheRead,
		totalCacheWriteTokens: previous.totalCacheWriteTokens + usage.cacheWrite,
	};
}
