import type { AgentTool } from "@mariozechner/pi-agent-core";

/**
 * LibreChat 工具集（保留接口兼容性，返回空数组）
 * 所有工具已迁移到 MCP 动态注册机制
 */
export function createLibreChatTools(_outputDir?: string): AgentTool[] {
	return [];
}
