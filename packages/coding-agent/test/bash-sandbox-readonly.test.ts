import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { validateCommandSandbox } from "../src/core/tools/bash-sandbox.js";
import { addAllowedReadPrefix } from "../src/core/tools/path-utils.js";

// Register the read-only directories the way the HTTP API does on startup.
// These directories may be read (and their scripts executed) but never written.
const SKILL_REPO = "/app/skill-repo";
const SKILLS_DIR = "/home/testuser/.pi/agent/skills";
const PROMPTS_DIR = "/home/testuser/.pi/agent/prompts";

describe("validateCommandSandbox: read-only directory protection", () => {
	const cwd = resolve("/home/testuser/.pi/agent/sessions/session-1");

	beforeEach(() => {
		// Register the platform-resolved form so prefix matching agrees with how
		// validateCommandSandbox resolves command paths on every platform.
		addAllowedReadPrefix(resolve(SKILL_REPO));
		addAllowedReadPrefix(resolve(SKILLS_DIR));
		addAllowedReadPrefix(resolve(PROMPTS_DIR));
	});

	describe("reads and script execution are allowed", () => {
		it("allows reading a file in /app/skill-repo", () => {
			expect(validateCommandSandbox("cat /app/skill-repo/general/skill-creator/SKILL.md", cwd)).toBeNull();
		});

		it("allows listing a read-only directory", () => {
			expect(validateCommandSandbox("ls -la /app/skill-repo", cwd)).toBeNull();
		});

		it("allows executing a script from /app/skill-repo by absolute path", () => {
			const cmd = "python /app/skill-repo/data-analysis/dmp-mcp/scripts/main.py query_data --id 2";
			expect(validateCommandSandbox(cmd, cwd)).toBeNull();
		});

		it("allows copying a read-only file into the working directory (read source, write dest)", () => {
			const cmd = "cp /app/skill-repo/general/skill-creator/SKILL.md ./copied.md";
			expect(validateCommandSandbox(cmd, cwd)).toBeNull();
		});
	});

	describe("writes/deletes to read-only directories are blocked", () => {
		it("blocks 'rm' on a file in /app/skill-repo", () => {
			const err = validateCommandSandbox("rm /app/skill-repo/general/skill-creator/SKILL.md", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'rm -rf' on a read-only directory", () => {
			const err = validateCommandSandbox("rm -rf /app/skill-repo/general", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks output redirect into a read-only directory", () => {
			const err = validateCommandSandbox("echo hi > /app/skill-repo/general/new.txt", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks append redirect into a read-only directory", () => {
			const err = validateCommandSandbox("echo hi >> /app/skill-repo/general/new.txt", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'mkdir' inside a read-only directory", () => {
			const err = validateCommandSandbox("mkdir /app/skill-repo/general/new-skill", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'touch' inside a read-only directory", () => {
			const err = validateCommandSandbox("touch /app/skill-repo/general/new.txt", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'mv' involving a read-only source (removing from it)", () => {
			const err = validateCommandSandbox("mv /app/skill-repo/general/skill-creator/SKILL.md ./out.md", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'mv' targeting a read-only destination", () => {
			const err = validateCommandSandbox("mv ./local.txt /app/skill-repo/general/moved.txt", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'cp' targeting a read-only destination", () => {
			const err = validateCommandSandbox("cp ./local.txt /app/skill-repo/general/copied.txt", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'chmod' on a read-only file", () => {
			const err = validateCommandSandbox("chmod 755 /app/skill-repo/general/skill-creator/scripts/main.py", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'sed -i' (in-place edit) on a read-only file", () => {
			const err = validateCommandSandbox("sed -i 's/a/b/' /app/skill-repo/general/skill-creator/SKILL.md", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks 'tee' writing into a read-only directory", () => {
			const err = validateCommandSandbox("echo hi | tee /app/skill-repo/general/out.txt", cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks writes to the user skills directory (~/.pi/agent/skills)", () => {
			const err = validateCommandSandbox(`echo x > ${SKILLS_DIR}/my-skill/out.txt`, cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});

		it("blocks writes to the user prompts directory (~/.pi/agent/prompts)", () => {
			const err = validateCommandSandbox(`rm ${PROMPTS_DIR}/greeting.md`, cwd);
			expect(err).not.toBeNull();
			expect(err).toContain("read-only");
		});
	});

	describe("writes inside the working directory are still allowed", () => {
		it("allows 'rm' on a file inside cwd", () => {
			expect(validateCommandSandbox("rm ./local.txt", cwd)).toBeNull();
		});

		it("allows output redirect inside cwd", () => {
			expect(validateCommandSandbox("echo hi > ./out.txt", cwd)).toBeNull();
		});

		it("allows 'mkdir' inside cwd", () => {
			expect(validateCommandSandbox("mkdir ./new-dir", cwd)).toBeNull();
		});
	});
});
