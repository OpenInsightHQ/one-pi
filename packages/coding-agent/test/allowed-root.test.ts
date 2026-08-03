import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCommandSandbox } from "../src/core/tools/bash-sandbox.js";
import { resolveReadPath, resolveToCwd, resolveToCwdStrict } from "../src/core/tools/path-utils.js";

const sep = "/";
function slash(p: string): string {
	return p.replace(/\\/g, sep);
}

describe("allowedRoot: user-session-directory access", () => {
	// Mirror the HTTP API layout:
	//   <userRoot>/<agentId>/<sessionId>/      <- cwd (session working dir)
	//   <userRoot>/skills/                     <- user skills dir
	const userRoot = slash(resolve("/home/codeuser/.pi/agent/sessions/user-1"));
	const cwd = slash(resolve(`${userRoot}/agent-1/session-1`));
	const userSkillsDir = slash(resolve(`${userRoot}/skills`));

	describe("validateCommandSandbox with allowedRoot", () => {
		it("allows reading a file under the user root (query own files)", () => {
			const cmd = `ls -la ${userRoot}`;
			const err = validateCommandSandbox(cmd, cwd, userRoot);
			expect(err).toBeNull();
		});

		it("allows reading another session's files under the user root", () => {
			const other = slash(resolve(`${userRoot}/agent-1/session-2/data.txt`));
			const err = validateCommandSandbox(`cat ${other}`, cwd, userRoot);
			expect(err).toBeNull();
		});

		it("allows a script writing to the user skills dir by absolute path (no cd)", () => {
			const cmd = `python scripts/main.py init name --path "${userSkillsDir}"`;
			const err = validateCommandSandbox(cmd, cwd, userRoot);
			expect(err).toBeNull();
		});

		it("still blocks 'cd' into the user skills dir (outputs must stay in cwd)", () => {
			const cmd = `cd ${userSkillsDir} && python scripts/main.py init name`;
			const err = validateCommandSandbox(cmd, cwd, userRoot);
			expect(err).not.toBeNull();
			expect(err).toContain("'cd");
		});

		it("still blocks paths outside the user root", () => {
			const err = validateCommandSandbox("cat /etc/shadow", cwd, userRoot);
			expect(err).not.toBeNull();
			expect(err).toContain("outside the allowed area");
		});

		it("still blocks the skill-repo from being written via cwd change", () => {
			const err = validateCommandSandbox("cd /app/skill-repo/x && touch y", cwd, userRoot);
			expect(err).not.toBeNull();
			expect(err).toContain("'cd /app/skill-repo/x'");
		});
	});

	describe("path-utils with allowedRoot", () => {
		it("resolveToCwd returns the user-root path as-is (no clamping)", () => {
			const target = slash(resolve(`${userRoot}/skills/my-skill/SKILL.md`));
			const resolved = resolveToCwd(target, cwd, userRoot);
			expect(slash(resolved)).toBe(target);
		});

		it("resolveToCwd allows relative .. escape into the user root", () => {
			// ../../skills from cwd (session-1 -> agent-1 -> user-1) = user skills dir
			const resolved = resolveToCwd("../../skills", cwd, userRoot);
			expect(slash(resolved)).toBe(userSkillsDir);
		});

		it("resolveToCwd clamps escapes beyond the user root", () => {
			// ../../.. escapes above the user root -> basename ("sessions") clamped into cwd
			const resolved = resolveToCwd("../../..", cwd, userRoot);
			expect(slash(resolved)).toBe(slash(resolve(cwd, "sessions")));
		});

		it("resolveToCwdStrict allows writing under the user skills dir", () => {
			const target = slash(resolve(`${userRoot}/skills/my-skill/SKILL.md`));
			const resolved = resolveToCwdStrict(target, cwd, userRoot);
			expect(slash(resolved)).toBe(target);
		});

		it("resolveToCwdStrict rejects paths outside the user root", () => {
			expect(() => resolveToCwdStrict("/etc/shadow", cwd, userRoot)).toThrow(/outside the allowed area/);
		});

		it("resolveReadPath resolves a user-root absolute path", () => {
			const target = slash(resolve(`${userRoot}/skills/my-skill/SKILL.md`));
			const resolved = resolveReadPath(target, cwd, userRoot);
			expect(slash(resolved)).toBe(target);
		});

		it("without allowedRoot, defaults to cwd (backwards compatible)", () => {
			expect(() => resolveToCwdStrict(`${userRoot}/skills/x`, cwd)).toThrow(/outside the allowed area/);
			const clamped = resolveToCwd(`${userRoot}/skills/x`, cwd);
			// Clamped to cwd/basename
			expect(slash(clamped)).toBe(slash(resolve(cwd, "x")));
		});
	});
});
