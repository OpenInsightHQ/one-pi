export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface AggregatedUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

export function aggregateUsage(current: AggregatedUsage | undefined, usage: PiUsage): AggregatedUsage {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const output = usage.output;
	const previous =
	current ??
	{
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
	};

	return {
		prompt_tokens: previous.prompt_tokens + input,
		completion_tokens: previous.completion_tokens + output,
		total_tokens: previous.total_tokens + input + output,
		cache_read_tokens: previous.cache_read_tokens + usage.cacheRead,
		cache_write_tokens: previous.cache_write_tokens + usage.cacheWrite,
	};
}
