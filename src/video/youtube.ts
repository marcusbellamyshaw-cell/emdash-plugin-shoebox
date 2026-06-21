import { contentRangeHeader } from "./chunking.js";

export type FetchFn = typeof fetch;

export interface YoutubeCreds {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

// 60-second timeout for all YouTube/OAuth fetches. Chunk pushes are large, so
// this is generous, but it ensures a hung socket can't strand a cron tick.
const YT_FETCH_TIMEOUT_MS = 60_000;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Exchange a stored refresh token for a short-lived access token. */
export async function getAccessToken(creds: YoutubeCreds, fetchFn: FetchFn): Promise<string> {
	const body = new URLSearchParams({
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		refresh_token: creds.refreshToken,
		grant_type: "refresh_token",
	});
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), YT_FETCH_TIMEOUT_MS);
	const res = await fetchFn(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		signal: ctrl.signal,
	}).finally(() => clearTimeout(tid));
	if (!res.ok) {
		throw new Error(`oauth token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
	}
	const json = (await res.json()) as { access_token?: string };
	if (!json.access_token) throw new Error("oauth response missing access_token");
	return json.access_token;
}

const RESUMABLE_URL =
	"https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

export interface VideoMeta {
	title: string;
	description: string;
	privacyStatus: "private" | "unlisted" | "public";
}

/** Open a resumable upload session; returns the session URI from the Location header. */
export async function startResumableSession(
	accessToken: string,
	meta: VideoMeta,
	totalBytes: number,
	contentType: string,
	fetchFn: FetchFn,
): Promise<string> {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), YT_FETCH_TIMEOUT_MS);
	const res = await fetchFn(RESUMABLE_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Length": String(totalBytes),
			"X-Upload-Content-Type": contentType,
		},
		body: JSON.stringify({
			snippet: { title: meta.title.slice(0, 100), description: meta.description.slice(0, 5000) },
			status: { privacyStatus: meta.privacyStatus, selfDeclaredMadeForKids: false },
		}),
		signal: ctrl.signal,
	}).finally(() => clearTimeout(tid));
	if (!res.ok) {
		throw new Error(`failed to start resumable session: ${res.status} ${await res.text().catch(() => "")}`);
	}
	const uri = res.headers.get("Location");
	if (!uri) throw new Error("resumable session response missing Location header");
	return uri;
}

export type ChunkResult =
	| { status: "incomplete"; bytesReceived: number }
	| { status: "complete"; videoId: string };

/** Upload one chunk. `range.end` is inclusive. */
export async function pushChunk(
	sessionUri: string,
	chunk: Uint8Array,
	range: { start: number; end: number },
	totalBytes: number,
	fetchFn: FetchFn,
): Promise<ChunkResult> {
	const body = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), YT_FETCH_TIMEOUT_MS);
	const res = await fetchFn(sessionUri, {
		method: "PUT",
		headers: {
			"Content-Length": String(chunk.byteLength),
			"Content-Range": contentRangeHeader(range.start, range.end, totalBytes),
		},
		body,
		signal: ctrl.signal,
	}).finally(() => clearTimeout(tid));
	if (res.status === 308) {
		// "bytes=0-N" → N+1 bytes received so far. Fall back to range.end+1.
		const r = res.headers.get("Range");
		const m = r?.match(/bytes=0-(\d+)/);
		const bytesReceived = m ? parseInt(m[1]!, 10) + 1 : range.end + 1;
		return { status: "incomplete", bytesReceived };
	}
	if (res.status === 200 || res.status === 201) {
		const json = (await res.json()) as { id?: string };
		if (!json.id) throw new Error("completed upload response missing video id");
		return { status: "complete", videoId: json.id };
	}
	throw new Error(`chunk upload failed: ${res.status} ${await res.text().catch(() => "")}`);
}
