import { describe, expect, it } from "vitest";
import { AGENT_ID_PREFIX, isAgentPrincipalId } from "../src/core/mongo/skill-catalog.js";

describe("isAgentPrincipalId: agent principal routing", () => {
	it("recognizes arp agent ids (agent_ prefix)", () => {
		expect(isAgentPrincipalId("agent_s917T8qpLYVrXzDxIpu4j")).toBe(true);
		expect(isAgentPrincipalId("agent_")).toBe(true);
	});

	it("rejects non-agent ids (fall back to user ACL)", () => {
		expect(isAgentPrincipalId("pi__one-pi___one-pi")).toBe(false);
		expect(isAgentPrincipalId("default")).toBe(false);
		expect(isAgentPrincipalId("agent")).toBe(false);
		expect(isAgentPrincipalId("agents_foo")).toBe(false);
		expect(isAgentPrincipalId("")).toBe(false);
	});

	it("rejects nullish values", () => {
		expect(isAgentPrincipalId(null)).toBe(false);
		expect(isAgentPrincipalId(undefined)).toBe(false);
	});

	it("prefix constant matches arp agent id format", () => {
		expect(AGENT_ID_PREFIX).toBe("agent_");
		expect(`agent_s917T8qpLYVrXzDxIpu4j`.startsWith(AGENT_ID_PREFIX)).toBe(true);
	});
});
