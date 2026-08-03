export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	editToolDefinition,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	findToolDefinition,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	grepToolDefinition,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	lsToolDefinition,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
	writeToolDefinition,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import {
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
} from "./bash.js";
import { createEditTool, createEditToolDefinition, editTool, editToolDefinition } from "./edit.js";
import { createFindTool, createFindToolDefinition, findTool, findToolDefinition } from "./find.js";
import { createGrepTool, createGrepToolDefinition, grepTool, grepToolDefinition } from "./grep.js";
import { createLsTool, createLsToolDefinition, lsTool, lsToolDefinition } from "./ls.js";
import {
	createReadTool,
	createReadToolDefinition,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
import { createWriteTool, createWriteToolDefinition, writeTool, writeToolDefinition } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
};

export const allToolDefinitions = {
	read: readToolDefinition,
	bash: bashToolDefinition,
	edit: editToolDefinition,
	write: writeToolDefinition,
	grep: grepToolDefinition,
	find: findToolDefinition,
	ls: lsToolDefinition,
};

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	/**
	 * Root directory all file tools may access (absolute paths or `..` escapes up
	 * to this boundary are permitted). Defaults to `cwd`. `cd` (bash sandbox) is
	 * still restricted to `cwd` so script outputs stay there.
	 */
	allowedRoot?: string;
}

function withAllowedRoot<T extends { allowedRoot?: string } | undefined>(base: T, allowedRoot: string | undefined): T {
	if (!allowedRoot) return base;
	return { ...(base as object), allowedRoot } as T;
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const root = options?.allowedRoot;
	return [
		createReadToolDefinition(cwd, withAllowedRoot(options?.read, root)),
		createBashToolDefinition(cwd, withAllowedRoot(options?.bash, root)),
		createEditToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		createWriteToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const root = options?.allowedRoot;
	return [
		createReadToolDefinition(cwd, withAllowedRoot(options?.read, root)),
		createGrepToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		createFindToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		createLsToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const root = options?.allowedRoot;
	return {
		read: createReadToolDefinition(cwd, withAllowedRoot(options?.read, root)),
		bash: createBashToolDefinition(cwd, withAllowedRoot(options?.bash, root)),
		edit: createEditToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		write: createWriteToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		grep: createGrepToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		find: createFindToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
		ls: createLsToolDefinition(cwd, root ? { allowedRoot: root } : undefined),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const root = options?.allowedRoot;
	return [
		createReadTool(cwd, withAllowedRoot(options?.read, root)),
		createBashTool(cwd, withAllowedRoot(options?.bash, root)),
		createEditTool(cwd, root ? { allowedRoot: root } : undefined),
		createWriteTool(cwd, root ? { allowedRoot: root } : undefined),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const root = options?.allowedRoot;
	return [
		createReadTool(cwd, withAllowedRoot(options?.read, root)),
		createGrepTool(cwd, root ? { allowedRoot: root } : undefined),
		createFindTool(cwd, root ? { allowedRoot: root } : undefined),
		createLsTool(cwd, root ? { allowedRoot: root } : undefined),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const root = options?.allowedRoot;
	return {
		read: createReadTool(cwd, withAllowedRoot(options?.read, root)),
		bash: createBashTool(cwd, withAllowedRoot(options?.bash, root)),
		edit: createEditTool(cwd, root ? { allowedRoot: root } : undefined),
		write: createWriteTool(cwd, root ? { allowedRoot: root } : undefined),
		grep: createGrepTool(cwd, root ? { allowedRoot: root } : undefined),
		find: createFindTool(cwd, root ? { allowedRoot: root } : undefined),
		ls: createLsTool(cwd, root ? { allowedRoot: root } : undefined),
	};
}
