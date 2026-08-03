import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCommandSandbox } from "../src/core/tools/bash-sandbox.js";

describe("validateCommandSandbox", () => {
	const cwd = resolve("/home/codeuser/.pi/agent/sessions/session-1/work");

	describe("cd restrictions", () => {
		it("should block 'cd' into a skill-repo directory outside cwd", () => {
			const cmd = "cd /app/skill-repo/data-analysis/dmp-mcp && python scripts/main.py query_data --id 2";
			const err = validateCommandSandbox(cmd, cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("'cd /app/skill-repo/data-analysis/dmp-mcp'");
			expect(err).toContain("outside the working directory");
			expect(err).toContain("absolute path");
		});

		it("should block 'cd' into a general skill directory outside cwd", () => {
			const cmd = 'cd /app/skill-repo/general/skill-creator && python scripts/init_skill.py name --path "/tmp/out"';
			const err = validateCommandSandbox(cmd, cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("'cd /app/skill-repo/general/skill-creator'");
		});

		it("should suggest the absolute script path in the error", () => {
			const cmd = "cd /app/skill-repo/general/skill-creator && python scripts/init_skill.py name";
			const err = validateCommandSandbox(cmd, cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("/app/skill-repo/general/skill-creator/scripts/main.py");
		});

		it("should allow 'cd' into a subdirectory inside cwd", () => {
			const cmd = "cd src && npm test";
			const err = validateCommandSandbox(cmd, cwd);
			expect(err).toBeNull();
		});

		it("should allow 'cd .' and 'cd' to cwd itself", () => {
			expect(validateCommandSandbox("cd . && ls", cwd)).toBeNull();
			expect(validateCommandSandbox(`cd ${cwd} && ls`, cwd)).toBeNull();
		});

		it("should not trigger the cd check for a command without 'cd'", () => {
			const cmd = "cat /app/skill-repo/general/skill-creator/SKILL.md";
			const err = validateCommandSandbox(cmd, cwd);
			// May be blocked by the general path check on some platforms (allowed-read
			// prefixes are Unix-only), but must never be blocked by the cd rule.
			if (err !== null) {
				expect(err).not.toContain("'cd");
			}
		});

		it("should block 'cd' with a semicolon separator", () => {
			const cmd = "cd /app/skill-repo/general/skill-creator; python scripts/main.py";
			const err = validateCommandSandbox(cmd, cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("'cd /app/skill-repo/general/skill-creator'");
		});
	});

	describe("non-cd paths (unchanged behavior)", () => {
		it("should block absolute paths outside cwd (non-readable)", () => {
			const err = validateCommandSandbox("cat /etc/shadow", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("outside the allowed area");
		});

		it("should allow paths inside cwd", () => {
			expect(validateCommandSandbox("ls src", cwd)).toBeNull();
			expect(validateCommandSandbox("cat ./README.md", cwd)).toBeNull();
		});

		it("should block root path", () => {
			const err = validateCommandSandbox("ls /", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("root path");
		});

		it("should block home directory paths", () => {
			const err = validateCommandSandbox("cat ~/.bashrc", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("home directory");
		});
	});
});
