import { describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../src/video/youtube.js";

const creds = { clientId: "cid", clientSecret: "secret", refreshToken: "rtoken" };

describe("getAccessToken", () => {
	it("exchanges the refresh token and returns the access token", async () => {
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).toBe("https://oauth2.googleapis.com/token");
			expect(init?.method).toBe("POST");
			const body = String(init?.body);
			expect(body).toContain("grant_type=refresh_token");
			expect(body).toContain("refresh_token=rtoken");
			return new Response(JSON.stringify({ access_token: "at-123", expires_in: 3600 }), { status: 200 });
		});
		const token = await getAccessToken(creds, fetchFn as unknown as typeof fetch);
		expect(token).toBe("at-123");
	});

	it("throws on a non-OK response", async () => {
		const fetchFn = vi.fn(async () => new Response("nope", { status: 400 }));
		await expect(getAccessToken(creds, fetchFn as unknown as typeof fetch)).rejects.toThrow(/oauth/i);
	});

	it("throws when access_token is missing", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
		await expect(getAccessToken(creds, fetchFn as unknown as typeof fetch)).rejects.toThrow(/access_token/i);
	});
});
