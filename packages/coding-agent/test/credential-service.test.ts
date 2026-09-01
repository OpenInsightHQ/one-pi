import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decryptCredentialValues,
	encryptCredentialValues,
	maskSecretValues,
} from "../src/core/mongo/credential-service.js";

describe("credential encryption", () => {
	it("round-trips a values object", () => {
		const key = randomBytes(32);
		const values = { app_id: "cli_a1b2c3", app_secret: "sk-very-secret-value-123" };
		const encrypted = encryptCredentialValues(values, key);
		expect(encrypted.iv).not.toContain(values.app_secret);
		expect(encrypted.data).not.toContain(values.app_secret);
		expect(decryptCredentialValues(encrypted, key)).toEqual(values);
	});

	it("produces a different ciphertext per call (random IV)", () => {
		const key = randomBytes(32);
		const values = { app_secret: "sk-same-value" };
		const a = encryptCredentialValues(values, key);
		const b = encryptCredentialValues(values, key);
		expect(a.iv).not.toBe(b.iv);
		expect(a.data).not.toBe(b.data);
	});

	it("fails with a wrong key (GCM auth)", () => {
		const encrypted = encryptCredentialValues({ app_secret: "sk-value" }, randomBytes(32));
		expect(() => decryptCredentialValues(encrypted, randomBytes(32))).toThrow();
	});

	it("handles unicode values", () => {
		const key = randomBytes(32);
		const values = { note: "密码-🔑" };
		expect(decryptCredentialValues(encryptCredentialValues(values, key), key)).toEqual(values);
	});
});

describe("maskSecretValues", () => {
	it("replaces exact secret occurrences with ***", () => {
		const text = 'env: APP_SECRET=sk-abc123456 other="sk-abc123456"';
		const masked = maskSecretValues(text, { app_secret: "sk-abc123456" });
		expect(masked).toBe('env: APP_SECRET=*** other="***"');
		expect(masked).not.toContain("sk-abc123456");
	});

	it("replaces longest value first on overlaps", () => {
		const text = "token=prefix-token-long";
		const masked = maskSecretValues(text, {
			short: "prefix-token",
			long: "prefix-token-long",
		});
		expect(masked).toBe("token=***");
	});

	it("ignores short values (<4 chars) to avoid mangling common text", () => {
		expect(maskSecretValues("abc def", { a: "abc" })).toBe("abc def");
	});

	it("leaves text without secrets untouched", () => {
		expect(maskSecretValues("plain output", { app_secret: "sk-none-here" })).toBe("plain output");
	});
});
