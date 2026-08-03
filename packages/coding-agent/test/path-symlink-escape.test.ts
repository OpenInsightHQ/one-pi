import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToCwdStrict } from "../src/core/tools/path-utils.js";

// Symlink-escape protection for resolveToCwdStrict. A symlink inside the allowed
// area that points outside it must be rejected, otherwise a user could write to
// arbitrary locations by writing through the symlink.
describe("resolveToCwdStrict symlink-escape protection", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-root-"));
		outside = mkdtempSync(join(tmpdir(), "pi-outside-"));
	});

	afterEach(() => {
		for (const dir of [root, outside]) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	it("rejects writing through a symlink that escapes the allowed area", () => {
		// Create a real file outside the sandbox.
		writeFileSync(join(outside, "secret.txt"), "top secret");
		// Create a symlink inside cwd pointing to the outside directory.
		const linkPath = join(root, "escape-link");
		try {
			symlinkSync(outside, linkPath);
		} catch {
			// Symlinks unavailable (e.g. Windows without developer mode). Skip gracefully.
			return;
		}
		// Writing to <cwd>/escape-link/secret.txt must be rejected: its real path is
		// outside the allowed area.
		expect(() => resolveToCwdStrict("escape-link/secret.txt", root)).toThrow(/via symlink/);
	});

	it("still allows writing to a normal file inside the allowed area", () => {
		mkdirSync(join(root, "sub"), { recursive: true });
		// Path does not exist yet; parent does. Must resolve fine.
		const resolved = resolveToCwdStrict("sub/new-file.txt", root);
		expect(resolved).toBe(join(root, "sub", "new-file.txt"));
	});

	it("rejects a symlink whose target is outside even when the file does not exist yet", () => {
		const linkPath = join(root, "out-link");
		try {
			symlinkSync(outside, linkPath);
		} catch {
			return; // symlinks unsupported
		}
		// new-file.txt does not exist; parent (the symlink) resolves outside.
		expect(() => resolveToCwdStrict("out-link/new-file.txt", root)).toThrow(/via symlink/);
	});
});
