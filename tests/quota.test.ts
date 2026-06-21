import { describe, expect, it } from "vitest";
import { quotaKey, getUsed, incrementUsed, hasQuota } from "../src/video/quota.js";

function memKv() {
	const m = new Map<string, unknown>();
	return {
		get: async <T>(k: string): Promise<T | null> => (m.has(k) ? (m.get(k) as T) : null),
		set: async (k: string, v: unknown): Promise<void> => void m.set(k, v),
	};
}

describe("youtube quota", () => {
	it("builds a date-scoped key", () => {
		expect(quotaKey("2026-06-20")).toBe("youtube:quota:2026-06-20");
	});

	it("starts at zero", async () => {
		const kv = memKv();
		expect(await getUsed(kv, "2026-06-20")).toBe(0);
	});

	it("increments and reports remaining capacity", async () => {
		const kv = memKv();
		expect(await incrementUsed(kv, "2026-06-20")).toBe(1);
		expect(await incrementUsed(kv, "2026-06-20")).toBe(2);
		expect(await getUsed(kv, "2026-06-20")).toBe(2);
		expect(await hasQuota(kv, "2026-06-20", 3)).toBe(true);
		await incrementUsed(kv, "2026-06-20");
		expect(await hasQuota(kv, "2026-06-20", 3)).toBe(false);
	});

	it("scopes counts per day", async () => {
		const kv = memKv();
		await incrementUsed(kv, "2026-06-20");
		expect(await getUsed(kv, "2026-06-21")).toBe(0);
	});
});
