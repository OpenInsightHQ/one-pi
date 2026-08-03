#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

process.on("unhandledRejection", (reason) => {
	console.error("[FATAL] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (error) => {
	console.error("[FATAL] Uncaught Exception:", error);
	process.exit(1);
});

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
