import { describe, expect, it } from "vitest";
import { parseCredentialSchema } from "../src/core/mongo/personal-skill-sync.js";

describe("parseCredentialSchema", () => {
	it("accepts a plain list of secret keys (sensitive by default)", () => {
		expect(parseCredentialSchema(["app_id", "app_secret"])).toEqual([
			{ secretKey: "app_id", displayName: "app_id", sensitive: true },
			{ secretKey: "app_secret", displayName: "app_secret", sensitive: true },
		]);
	});

	it("accepts objects with display metadata", () => {
		expect(
			parseCredentialSchema([
				{ secretKey: "app_secret", displayName: "App Secret", description: "from open platform" },
				{ secretKey: "token", sensitive: false },
			]),
		).toEqual([
			{ secretKey: "app_secret", displayName: "App Secret", sensitive: true, description: "from open platform" },
			{ secretKey: "token", displayName: "token", sensitive: false, description: undefined },
		]);
	});

	it("skips entries without a string secretKey", () => {
		expect(parseCredentialSchema(["ok", 42, null, { name: "no-key" }])).toEqual([
			{ secretKey: "ok", displayName: "ok", sensitive: true },
		]);
	});

	it("returns undefined for empty or non-list values", () => {
		expect(parseCredentialSchema(undefined)).toBeUndefined();
		expect(parseCredentialSchema("app_secret")).toBeUndefined();
		expect(parseCredentialSchema([])).toBeUndefined();
	});
});
