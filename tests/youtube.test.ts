import { describe, expect, it, vi } from "vitest";
import { getAccessToken, startResumableSession, pushChunk } from "../src/video/youtube.js";

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

describe("startResumableSession", () => {
	it("returns the Location header as the session URI", async () => {
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			expect(String(url)).toContain("/upload/youtube/v3/videos");
			expect(String(url)).toContain("uploadType=resumable");
			const h = new Headers(init?.headers);
			expect(h.get("Authorization")).toBe("Bearer at");
			expect(h.get("X-Upload-Content-Length")).toBe("1000");
			expect(h.get("X-Upload-Content-Type")).toBe("video/mp4");
			return new Response("", { status: 200, headers: { Location: "https://upload.example/session-1" } });
		});
		const uri = await startResumableSession(
			"at",
			{ title: "t", description: "d", privacyStatus: "private" },
			1000,
			"video/mp4",
			fetchFn as unknown as typeof fetch,
		);
		expect(uri).toBe("https://upload.example/session-1");
	});

	it("throws when no Location header is returned", async () => {
		const fetchFn = vi.fn(async () => new Response("", { status: 200 }));
		await expect(
			startResumableSession("at", { title: "t", description: "d", privacyStatus: "private" }, 1, "video/mp4", fetchFn as unknown as typeof fetch),
		).rejects.toThrow(/session/i);
	});
});

describe("pushChunk", () => {
	it("reports incomplete on 308 using the Range header", async () => {
		const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
			const h = new Headers(init?.headers);
			expect(h.get("Content-Range")).toBe("bytes 0-8388607/16777216");
			return new Response("", { status: 308, headers: { Range: "bytes=0-8388607" } });
		});
		const r = await pushChunk(
			"https://upload.example/s",
			new Uint8Array(8),
			{ start: 0, end: 8388607 },
			16777216,
			fetchFn as unknown as typeof fetch,
		);
		expect(r).toEqual({ status: "incomplete", bytesReceived: 8388608 });
	});

	it("reports complete with the video id on 200", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "vid-9" }), { status: 200 }));
		const r = await pushChunk(
			"https://upload.example/s",
			new Uint8Array(4),
			{ start: 8388608, end: 16777215 },
			16777216,
			fetchFn as unknown as typeof fetch,
		);
		expect(r).toEqual({ status: "complete", videoId: "vid-9" });
	});

	it("throws on an unexpected status", async () => {
		const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));
		await expect(
			pushChunk("https://upload.example/s", new Uint8Array(1), { start: 0, end: 0 }, 1, fetchFn as unknown as typeof fetch),
		).rejects.toThrow(/chunk upload/i);
	});
});
