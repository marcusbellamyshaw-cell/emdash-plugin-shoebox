import { definePlugin, PluginRouteError, ulid } from "emdash";
import type { PluginContext, RouteContext } from "emdash";
import type {
	Session,
	SubmissionRecord,
	InferredTaxonomy,
	PluginSettings,
} from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";
import { R2_PART_SIZE, partCount, nextYoutubeChunk } from "./video/chunking.js";
import { isAllowedVideoType, withinSizeCap, sniffVideoMagic } from "./video/validation.js";
import { videoKey, readRange } from "./video/r2.js";
import type { R2MultipartBinding } from "./video/r2.js";
import type { VideoUpload } from "./video/types.js";
import { getAccessToken, startResumableSession, pushChunk } from "./video/youtube.js";
import type { VideoMeta } from "./video/youtube.js";
import { hasQuota, incrementUsed } from "./video/quota.js";
import { assertTransition } from "./video/state.js";
import type { YoutubeTransfer } from "./video/types.js";

// ─── R2 media helpers ─────────────────────────────────────────────────────────
// ctx.media.upload() is unavailable for native plugins using R2 Worker binding —
// emdash gates MediaAccessWithWrite behind getUploadUrl which R2 binding doesn't
// provide (presigned URLs are unsupported). We replicate bridge.mediaUpload directly.

const FILE_EXT_REGEX = /^\.[a-z0-9]{1,10}$/i;

type R2BucketMinimal = {
	put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
	delete(key: string): Promise<void>;
};

// Indirection prevents Vite from statically analyzing this import at build time
// (sandbox-entry.ts is loaded in Node.js during config; cloudflare:workers is
// Workers-runtime-only). Using a variable instead of a string literal bypasses
// Vite's static import resolver — the module is only imported at request time.
const _CF_WORKERS = "cloudflare:workers";

// One resumable chunk per cron tick keeps each tick short and within limits.
const CRON_CHUNK_PER_TICK = 1;
const YT_MAX_ATTEMPTS = 5;

async function getWorkerEnv(): Promise<Record<string, unknown> | null> {
	try {
		const { env } = (await import(/* @vite-ignore */ _CF_WORKERS)) as { env: Record<string, unknown> };
		return env ?? null;
	} catch {
		return null;
	}
}

async function getMediaBucket(): Promise<R2BucketMinimal | null> {
	try {
		const { env } = await import(/* @vite-ignore */ _CF_WORKERS) as { env: Record<string, unknown> };
		return (env["MEDIA"] as R2BucketMinimal | undefined) ?? null;
	} catch {
		return null;
	}
}

async function getMediaMultipart(): Promise<R2MultipartBinding | null> {
	const bucket = await getMediaBucket();
	return (bucket as unknown as R2MultipartBinding | null) ?? null;
}

const VIDEO_EXT_BY_TYPE: Record<string, string> = {
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
};

async function uploadPhotoToR2(
	filename: string,
	contentType: string,
	bytes: ArrayBuffer,
): Promise<{ storageKey: string; url: string }> {
	const bucket = await getMediaBucket();
	if (!bucket) throw new PluginRouteError("CONFIG_ERROR", "Photo storage is not available. Please contact support.", 503);
	const basename = filename.split("/").pop() ?? filename;
	const rawExt = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")).toLowerCase() : "";
	const ext = FILE_EXT_REGEX.test(rawExt) ? rawExt : "";
	const storageKey = `${ulid()}${ext}`;
	await bucket.put(storageKey, new Uint8Array(bytes), { httpMetadata: { contentType } });
	return { storageKey, url: `/_emdash/api/media/file/${storageKey}` };
}

async function deletePhotoFromR2(storageKey: string): Promise<void> {
	const bucket = await getMediaBucket();
	if (bucket) await bucket.delete(storageKey).catch(() => {});
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings(ctx: PluginContext): Promise<PluginSettings> {
	const keys = Object.keys(DEFAULT_SETTINGS) as (keyof PluginSettings)[];
	const settings = { ...DEFAULT_SETTINGS };
	await Promise.all(
		keys.map(async (key) => {
			const val = await ctx.kv.get<unknown>(`settings:${key}`);
			if (val !== null) (settings as Record<string, unknown>)[key] = val;
		}),
	);
	return settings;
}

// ─── Session token ────────────────────────────────────────────────────────────

async function signSessionToken(sessionId: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const expires = Date.now() + 4 * 60 * 60 * 1000;
	const payload = `${sessionId}.${expires}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret || "shoebox-dev-secret"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const sigHex = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${payload}.${sigHex}`;
}

async function verifySessionToken(token: string, secret: string): Promise<string | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [sessionId, expiresStr, sigHex] = parts;
	if (!sessionId || !expiresStr || !sigHex) return null;
	const expires = parseInt(expiresStr, 10);
	if (isNaN(expires) || Date.now() > expires) return null;
	const encoder = new TextEncoder();
	const payload = `${sessionId}.${expiresStr}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret || "shoebox-dev-secret"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const sigBytes = new Uint8Array(
		sigHex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)),
	);
	const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
	return valid ? sessionId : null;
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

async function computeHash(text: string): Promise<string> {
	const encoder = new TextEncoder();
	const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
	const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(normalized));
	return Array.from(new Uint8Array(hashBuf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

// ─── Rate limit ───────────────────────────────────────────────────────────────

async function checkSubmissionRateLimit(ip: string, settings: PluginSettings, ctx: PluginContext): Promise<boolean> {
	const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const max = settings.maxSubmissionsPerIp ?? 3;
	// Fetch only (max + 1) records ordered newest-first so the compound
	// ["ip","createdAt"] index is used efficiently, instead of fetching 100
	// records and filtering in memory. We only need to know whether the user
	// has already hit the limit, so (max + 1) is always sufficient.
	const result = await ctx.storage.submissions.query({
		where: { ip },
		orderBy: { createdAt: "desc" },
		limit: max + 1,
	});
	const recent = result.items.filter((item) => (item.data as SubmissionRecord).createdAt > dayAgo);
	return recent.length < max;
}

// ─── Newsletter ───────────────────────────────────────────────────────────────

async function signUpForNewsletter(email: string, name: string, phone: string | undefined, settings: PluginSettings): Promise<void> {
	if (!settings.brevoApiKey || !settings.newsletterEnabled) return;
	const attributes: Record<string, string> = { FIRSTNAME: name.split(" ")[0] ?? "" };
	if (phone) attributes.SMS = phone;
	try {
		// 6-second timeout — newsletter signup is non-fatal; we must not let a
		// slow Brevo API hold the form/submit response hostage.
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), 6_000);
		await globalThis.fetch("https://api.brevo.com/v3/contacts", {
			method: "POST",
			headers: { "api-key": settings.brevoApiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ email, attributes, listIds: [settings.brevoListId ?? 3], updateEnabled: true }),
			signal: ctrl.signal,
		}).finally(() => clearTimeout(tid));
	} catch { /* non-fatal */ }
}

function textToPortableText(text: string): unknown[] {
	const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
	if (paragraphs.length === 0) paragraphs.push(text.trim());
	return paragraphs.map((p) => ({
		_type: "block",
		_key: Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join(""),
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join(""), text: p, marks: [] }],
	}));
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendApprovalEmail(name: string, email: string, storyUrl: string, settings: PluginSettings): Promise<void> {
	if (!settings.brevoApiKey || !email) return;
	const firstName = escapeHtml(name.split(" ")[0] || name);
	const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#faf9f6;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#faf9f6"><tr><td align="center" style="padding:40px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:100%;">
<tr><td bgcolor="#1a1a1a" style="padding:26px 32px;text-align:center;">
  <div style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#ffffff;">Every Bit <span style="color:#b45309;">Texas</span></div>
  <div style="font-size:11px;color:#999999;letter-spacing:0.14em;text-transform:uppercase;margin-top:6px;font-family:Arial,sans-serif;">From the Shoebox · Community Archive</div>
</td></tr>
<tr><td bgcolor="#ffffff" style="padding:40px 32px 32px;">
  <p style="font-size:52px;margin:0 0 12px;text-align:center;">🤠</p>
  <h1 style="font-family:Georgia,serif;font-size:28px;font-style:italic;font-weight:900;line-height:1.2;margin:0 0 6px;color:#1a1a1a;">Howdy, ${firstName}!</h1>
  <p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#999999;margin:0 0 28px;">A message from Bo Brisket — Every Bit Texas mascot</p>
  <p style="font-family:Georgia,serif;font-size:17px;line-height:1.75;color:#333333;margin:0 0 20px;">Well I'll be darned — your story has been reviewed and approved by our team. It'll be published to the Every Bit Texas community archive shortly. Thank you for taking the time to share your Texas memory. Stories like yours are exactly what this place is all about.</p>
  <table cellpadding="0" cellspacing="0" style="margin:32px 0;"><tr>
    <td bgcolor="#b45309"><a href="${storyUrl}" style="display:block;padding:15px 32px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Read Your Story →</a></td>
  </tr></table>
  <p style="font-family:Georgia,serif;font-size:17px;line-height:1.75;color:#333333;margin:0 0 24px;">If you enjoyed being part of the archive, we'd be mighty grateful if you followed along on social — we share Texas history, community stories, and a whole lot more every week.</p>
  <table cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:10px;padding-bottom:10px;"><a href="https://www.youtube.com/@EveryBitTexas" style="display:inline-block;text-decoration:none;background-color:#ff0000;padding:11px 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.04em;">&#9654; YouTube</a></td>
    <td style="padding-right:10px;padding-bottom:10px;"><a href="https://www.tiktok.com/@EveryBitTexas" style="display:inline-block;text-decoration:none;background-color:#010101;padding:11px 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.04em;">&#9835; TikTok</a></td>
    <td style="padding-bottom:10px;"><a href="https://www.facebook.com/EveryBitTexas" style="display:inline-block;text-decoration:none;background-color:#1877f2;padding:11px 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.04em;">f Facebook</a></td>
  </tr></table>
</td></tr>
<tr><td bgcolor="#f5f4f1" style="padding:20px 32px;border-top:1px solid #e8e6e0;">
  <p style="font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#888888;margin:0;">You're receiving this because you submitted a story to the Every Bit Texas community archive. Questions? Write to <a href="mailto:hello@everybittexas.com" style="color:#b45309;text-decoration:none;">hello@everybittexas.com</a>.</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
	try {
		// 10-second timeout — approval email is triggered by an admin publish action;
		// a slow Brevo API should not stall the content:afterPublish hook indefinitely.
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), 10_000);
		const res = await globalThis.fetch("https://api.brevo.com/v3/smtp/email", {
			method: "POST",
			headers: { "api-key": settings.brevoApiKey, "Content-Type": "application/json" },
			body: JSON.stringify({
				sender: { name: "Every Bit Texas", email: "hello@everybittexas.com" },
				to: [{ email, name }],
				subject: "Your Texas story has been approved! 🤠",
				htmlContent: html,
			}),
			signal: ctrl.signal,
		}).finally(() => clearTimeout(tid));
		if (!res.ok) console.warn(`[ebt-shoebox] Approval email failed ${res.status}: ${await res.text().catch(() => "")}`);
	} catch (err) {
		console.warn(`[ebt-shoebox] Approval email error: ${err}`);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getIP(ctx: RouteContext): string {
	return (
		ctx.requestMeta?.ip ??
		ctx.request.headers.get("CF-Connecting-IP") ??
		ctx.request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
		"unknown"
	);
}

// Exact-host allowlist for the public, state-changing routes (init/upload/
// removePhoto/submit). Browsers always send an Origin header on cross-origin
// POST fetches, so we require it and parse the host instead of substring-
// matching (which accepted everybittexas.com.evil.com). A missing Origin is no
// longer treated as valid — that previously let any non-browser client through.
const ALLOWED_ORIGIN_HOSTS = new Set(["everybittexas.com", "www.everybittexas.com"]);

function hostAllowed(value: string): boolean {
	try {
		const host = new URL(value).host.toLowerCase();
		return (
			ALLOWED_ORIGIN_HOSTS.has(host) ||
			host === "localhost" ||
			host.startsWith("localhost:") ||
			host.endsWith(".localhost")
		);
	} catch {
		return false;
	}
}

function validateOrigin(request: Request): boolean {
	const origin = request.headers.get("Origin");
	if (origin) return hostAllowed(origin);
	// No Origin header (rare for a POST fetch): fall back to Referer, parsed the
	// same way. Never treat a missing Origin as automatically valid.
	const referer = request.headers.get("Referer");
	if (referer) return hostAllowed(referer);
	return false;
}

async function trackAnalytic(
	event: "widget_opened" | "submission_completed",
	ip: string,
	sessionId: string | undefined,
	ctx: PluginContext,
): Promise<void> {
	try {
		await ctx.storage.analytics.put(crypto.randomUUID(), {
			event,
			date: new Date().toISOString().slice(0, 10),
			ip,
			sessionId,
		});
	} catch { /* non-fatal */ }
}

// ─── page:fragments enabled cache ────────────────────────────────────────────
// The page:fragments hook fires on every page load. Reading KV on every request
// to check the "enabled" flag adds an unnecessary round-trip. Cloudflare Worker
// instances are reused across many requests, so a module-level cache with a
// 60-second TTL eliminates that KV read for the lifetime of each instance.
let _fragmentsEnabled: boolean | null = null;
let _fragmentsEnabledExpiry = 0;

// ─── YouTube transfer helper ──────────────────────────────────────────────────

async function advanceTransfer(submissionId: string, ctx: PluginContext): Promise<void> {
	const submission = (await ctx.storage.submissions.get(submissionId)) as SubmissionRecord | null;
	if (!submission?.video || !submission.youtube) return;
	const yt = submission.youtube;
	if (yt.state !== "pending_upload" && yt.state !== "uploading") return;

	const settings = await getSettings(ctx);
	const env = await getWorkerEnv();
	const creds = {
		clientId: String(env?.["YOUTUBE_CLIENT_ID"] ?? ""),
		clientSecret: String(env?.["YOUTUBE_CLIENT_SECRET"] ?? ""),
		refreshToken: String(env?.["YOUTUBE_REFRESH_TOKEN"] ?? ""),
	};
	if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
		ctx.log.warn("[ebt-shoebox] YouTube secrets missing; skipping transfer");
		return;
	}
	const bucket = (await getMediaMultipart());
	if (!bucket) return;

	const save = async (patch: Partial<YoutubeTransfer>) => {
		const fresh = (await ctx.storage.submissions.get(submissionId)) as SubmissionRecord | null;
		if (!fresh) return;
		await ctx.storage.submissions.put(submissionId, { ...fresh, youtube: { ...fresh.youtube!, ...patch }, updatedAt: new Date().toISOString() });
	};

	try {
		const accessToken = await getAccessToken(creds, globalThis.fetch);
		let resumableUri = yt.resumableUri;
		if (!resumableUri) {
			const meta: VideoMeta = {
				title: `${settings.youtubeTitlePrefix}: ${submission.title}`.slice(0, 100),
				description: `Submitted to the Every Bit Texas community archive.`,
				privacyStatus: "private", // forced private until Google audit clears
			};
			resumableUri = await startResumableSession(accessToken, meta, submission.video.sizeBytes, submission.video.contentType, globalThis.fetch);
			if (yt.state === "pending_upload") assertTransition("pending_upload", "uploading");
			await save({ state: "uploading", resumableUri, error: undefined });
		}

		const chunk = nextYoutubeChunk(yt.bytesSent, submission.video.sizeBytes);
		const bytes = await readRange(bucket, submission.video.r2Key, chunk.start, chunk.length);
		const result = await pushChunk(resumableUri, bytes, { start: chunk.start, end: chunk.end }, submission.video.sizeBytes, globalThis.fetch);

		if (result.status === "incomplete") {
			await save({ bytesSent: result.bytesReceived });
			return;
		}

		// Complete: count quota, record id, flip state, write to the content entry.
		assertTransition("uploading", "uploaded");
		await incrementUsed(ctx.kv, new Date().toISOString().slice(0, 10));
		await save({ state: "uploaded", videoId: result.videoId, bytesSent: submission.video.sizeBytes });
		if (submission.emdashContentId && ctx.content?.update) {
			try {
				await ctx.content.update("community_submissions", submission.emdashContentId, {
					youtube_video_id: result.videoId,
				});
			} catch (err) {
				ctx.log.warn(`[ebt-shoebox] failed to write youtube_video_id: ${err}`);
			}
		}
	} catch (err) {
		const attempts = (yt.attempts ?? 0) + 1;
		const giveUp = attempts >= YT_MAX_ATTEMPTS;
		ctx.log.error(`[ebt-shoebox] transfer error (attempt ${attempts}): ${String(err)}`);
		await save({
			state: giveUp ? "failed" : "pending_upload",
			attempts,
			error: String(err).slice(0, 500),
			// Drop the session URI on hard failure so a retry re-opens one.
			resumableUri: giveUp ? undefined : yt.resumableUri,
		});
	}
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function createPlugin() {
	return definePlugin({
		id: "ebt-shoebox",
		version: "1.1.0",
		capabilities: [
			"content:read",
			"content:write",
			"media:read",
			"media:write",
			// Only api.brevo.com is ever fetched (R2 is reached via the MEDIA
			// Worker binding, not HTTP), so an explicit allowlist replaces the
			// previous network:request:unrestricted grant.
			"network:request",
			"email:send",
			"hooks.page-fragments:register",
		],
		allowedHosts: ["api.brevo.com", "oauth2.googleapis.com", "www.googleapis.com", "upload.googleapis.com"],

		storage: {
			sessions: { indexes: ["ip", "status", "createdAt", ["ip", "status"]] },
			submissions: { indexes: ["ip", "status", "createdAt", "textHash", ["ip", "createdAt"]] },
			analytics: { indexes: ["event", "date", ["event", "date"]] },
		},

		admin: {
			entry: "ebt-plugin-shoebox/admin",
			pages: [
				{ path: "/settings", label: "Shoebox Settings", icon: "gear" },
				{ path: "/submissions", label: "Review Submissions", icon: "inbox" },
			],
			widgets: [{ id: "shoebox-stats", title: "Shoebox Submissions", size: "third" }],
			settingsSchema: {
				enabled: { type: "boolean", label: "Enable Plugin", default: true },
				brevoApiKey: { type: "secret", label: "Brevo API Key", description: "Brevo dashboard → Settings → API Keys" },
				newsletterEnabled: { type: "boolean", label: "Enable Newsletter Opt-in", default: true },
				brevoListId: { type: "number", label: "Brevo Newsletter List ID", default: 3, min: 1 },
				maxFileSize: { type: "number", label: "Max File Size (MB)", default: 10, min: 1, max: 50 },
				maxPhotos: { type: "number", label: "Max Photos per Submission", default: 5, min: 1, max: 10 },
				maxSubmissionsPerIp: { type: "number", label: "Max Submissions per IP per 24h", default: 3, min: 1, max: 20 },
				maxStoryWords: { type: "number", label: "Max Story Word Count", default: 2000, min: 500, max: 5000 },
				youtubeEnabled: { type: "boolean", label: "Enable Video → YouTube", default: false },
				maxVideoSizeMb: { type: "number", label: "Max Video Size (MB)", default: 1024, min: 10, max: 4096 },
				youtubeDailyCap: { type: "number", label: "Max YouTube Uploads per Day", default: 5, min: 1, max: 50 },
				youtubeTitlePrefix: { type: "string", label: "YouTube Title Prefix", default: "From the Shoebox" },
				youtubePublicPlaceholder: { type: "boolean", label: "Show pre-audit video placeholder publicly", default: false },
			},
		},

		hooks: {
			"plugin:install": {
				handler: async (_event: unknown, ctx: PluginContext) => {
					await ctx.kv.set("settings:enabled", true);
					await ctx.kv.set("settings:newsletterEnabled", true);
					await ctx.kv.set("settings:maxFileSize", 10);
					await ctx.kv.set("settings:maxPhotos", 5);
					await ctx.kv.set("settings:maxSubmissionsPerIp", 3);
					await ctx.kv.set("settings:maxStoryWords", 2000);
					const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
						.map((b) => b.toString(16).padStart(2, "0"))
						.join("");
					await ctx.kv.set("settings:sessionSecret", secret);
					await ctx.kv.set("settings:youtubeEnabled", false);
					await ctx.kv.set("settings:maxVideoSizeMb", 1024);
					await ctx.kv.set("settings:youtubeDailyCap", 5);
					await ctx.kv.set("settings:youtubeTitlePrefix", "From the Shoebox");
					await ctx.kv.set("settings:youtubePublicPlaceholder", false);
					if (ctx.cron) {
						// Every 10 minutes.
						await ctx.cron.schedule("video-transfer", { schedule: "*/10 * * * *" });
						await ctx.cron.schedule("video-cleanup", { schedule: "0 * * * *" }); // hourly
					}
					ctx.log.info("[ebt-shoebox] Plugin installed");
				},
			},

			"content:afterPublish": {
				errorPolicy: "continue",
				handler: async (event: unknown, ctx: PluginContext) => {
					const e = event as { content?: { id?: string; data?: Record<string, unknown> }; collection?: string };
					if (e.collection !== "community_submissions") return;
					const data = e.content?.data ?? {};
					const name = data.submitter_name as string | undefined;
					const email = data.submitter_email as string | undefined;
					const location = (data.location as string | undefined) ?? "";
					const settings = await getSettings(ctx);
					const storyUrl = e.content?.id
						? `https://everybittexas.com/from-the-shoebox/${e.content.id}`
						: "https://everybittexas.com/from-the-shoebox";

					// Back-fill SEO if not already set (catches submissions made before this fix)
					if (e.content?.id && ctx.content?.update) {
						try {
							const existingSeo = (e.content as unknown as { seo?: { title?: string } })?.seo;
							if (!existingSeo?.title) {
								const creditPref = data.credit_preference as string | undefined;
								const isNamed = creditPref === "named";
								const ptBlocks = (data.story_original as Array<{ children?: Array<{ text?: string }> }> | undefined) ?? [];
								const plainStory = ptBlocks
									.flatMap((b) => b.children ?? [])
									.map((s) => s.text ?? "")
									.join(" ")
									.replace(/\s+/g, " ")
									.trim();
								const seoDescription = plainStory.length > 160
									? plainStory.slice(0, 160).replace(/\s+\S*$/, "") + "…"
									: plainStory;
								const photos = (data.photos as Array<{ url?: string }> | undefined) ?? [];
								const locSuffix = location ? `: ${location}` : "";
								const locDash = location ? ` — ${location}` : "";
								const seoTitle = isNamed && name
									? `${name}'s Texas Memory${locSuffix}`
									: `A Texas Memory${locDash}`;
								await ctx.content.update("community_submissions", e.content.id, {
									seo: {
										title: seoTitle,
										description: seoDescription || undefined,
										image: photos[0]?.url ?? null,
									},
								});
							}
						} catch (err) {
							ctx.log.warn(`[ebt-shoebox] SEO back-fill failed: ${err}`);
						}
					}

					if (!name || !email) return;
					await sendApprovalEmail(name, email, storyUrl, settings);
				},
			},

			"page:fragments": {
				errorPolicy: "continue",
				handler: async (_event: unknown, ctx: PluginContext) => {
					// Use module-level cache so the KV read fires at most once per
					// minute per Worker instance, not once per page request.
					const now = Date.now();
					if (_fragmentsEnabled === null || now > _fragmentsEnabledExpiry) {
						const val = await ctx.kv.get<boolean>("settings:enabled");
						_fragmentsEnabled = val !== false; // null means not set → default enabled
						_fragmentsEnabledExpiry = now + 60_000; // 60-second TTL
					}
					if (!_fragmentsEnabled) return null;
					return [
						{
							kind: "inline-script",
							placement: "head",
							code: `window.__SHOEBOX_API="/_emdash/api/plugins/ebt-shoebox";`,
							key: "shoebox-config",
						},
					];
				},
			},

			cron: {
				errorPolicy: "continue",
				handler: async (event: unknown, ctx: PluginContext) => {
					const name = (event as { name?: string }).name;
					if (name === "video-cleanup") {
						const done = await ctx.storage.submissions.query({
							where: { status: "approved" },
							orderBy: { createdAt: "asc" },
							limit: 50,
						});
						const bucket = await getMediaMultipart();
						if (!bucket) return;
						for (const item of done.items) {
							const rec = item.data as SubmissionRecord;
							// Delete the staged R2 object once the video is safely on YouTube.
							if (rec.youtube?.state === "uploaded" && rec.video?.r2Key && !rec.video.uploadId) {
								try {
									await bucket.delete(rec.video.r2Key);
									await ctx.storage.submissions.put(item.id, { ...rec, video: { ...rec.video, r2Key: "" } });
								} catch (err) {
									ctx.log.warn(`[ebt-shoebox] cleanup delete failed: ${err}`);
								}
							}
						}
						return;
					}
					if (name !== "video-transfer") return;
					const settings = await getSettings(ctx);
					if (!settings.youtubeEnabled) return;

					const today = new Date().toISOString().slice(0, 10);
					if (!(await hasQuota(ctx.kv, today, settings.youtubeDailyCap ?? 5))) {
						ctx.log.info("[ebt-shoebox] daily YouTube quota reached; deferring");
						return;
					}

					// Oldest in-flight first: uploading (resume) then pending_upload.
					const inflight = await ctx.storage.submissions.query({
						where: { status: "approved" },
						orderBy: { createdAt: "asc" },
						limit: 50,
					});
					const candidate = inflight.items
						.map((i) => ({ id: i.id, rec: i.data as SubmissionRecord }))
						.find((x) => x.rec.youtube && (x.rec.youtube.state === "uploading" || x.rec.youtube.state === "pending_upload"));
					if (!candidate) return;

					for (let i = 0; i < CRON_CHUNK_PER_TICK; i++) {
						await advanceTransfer(candidate.id, ctx);
					}
				},
			},
		},

		routes: {
			// ── Public: Initialize session ──────────────────────────────
			"form/init": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const settings = await getSettings(ctx);
					if (!settings.enabled) throw new PluginRouteError("SERVICE_UNAVAILABLE", "Submissions are temporarily closed.", 503);

					const ip = getIP(ctx);
					const sessionId = crypto.randomUUID();
					const now = new Date().toISOString();
					await ctx.storage.sessions.put(sessionId, {
						id: sessionId, ip, createdAt: now, lastActivity: now,
						turnCount: 0, status: "active",
						collected: {},
					});
					await trackAnalytic("widget_opened", ip, sessionId, ctx);
					const token = await signSessionToken(sessionId, settings.sessionSecret);
					return { ok: true, sessionToken: token, maxPhotos: settings.maxPhotos ?? 5 };
				},
			},

			// ── Public: Upload photo to R2 ──────────────────────────────
			"chat/upload": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const body = ctx.input as {
						sessionToken?: string;
						filename?: string;
						contentType?: string;
						data?: string;
					};

					if (!body.data) throw PluginRouteError.badRequest("No file data provided");
					if (!body.filename) throw PluginRouteError.badRequest("No filename provided");

					const contentType = body.contentType ?? "image/jpeg";
					if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
						throw PluginRouteError.badRequest("Only JPG, PNG, and WebP images are accepted.");
					}

					const settings = await getSettings(ctx);
					const sessionId = await verifySessionToken(body.sessionToken ?? "", settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired. Please refresh the page and try again.");

					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session || session.status !== "active") {
						throw PluginRouteError.notFound("Session not found.");
					}

					const maxBytes = (settings.maxFileSize ?? 10) * 1024 * 1024;
					// Reject oversized uploads from the encoded length BEFORE decoding,
					// so a malicious client can't force atob() over an arbitrarily large
					// base64 payload on this public route. (~3/4 of the base64 length.)
					if (Math.floor((body.data.length * 3) / 4) > maxBytes) {
						throw PluginRouteError.badRequest(`File too large. Maximum size is ${settings.maxFileSize ?? 10}MB.`);
					}

					let bytes: Uint8Array;
					try {
						bytes = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0));
					} catch {
						throw PluginRouteError.badRequest("Invalid image data. Please try uploading the photo again.");
					}
					const arrayBuffer = bytes.buffer as ArrayBuffer;

					if (arrayBuffer.byteLength > maxBytes) {
						throw PluginRouteError.badRequest(`File too large. Maximum size is ${settings.maxFileSize ?? 10}MB.`);
					}

					const currentPhotos = session.collected.photos ?? [];
					if (currentPhotos.length >= (settings.maxPhotos ?? 5)) {
						throw PluginRouteError.badRequest(`Maximum ${settings.maxPhotos ?? 5} photos per submission.`);
					}

					const { storageKey: mediaId, url: photoUrl } = await uploadPhotoToR2(body.filename, contentType, arrayBuffer);

					const photoData = {
						mediaId,
						url: photoUrl,
						altTextFinal: "",
						filename: body.filename,
						contentType,
						sizeBytes: arrayBuffer.byteLength,
					};

					session.collected.photos = [...currentPhotos, photoData];
					await ctx.storage.sessions.put(sessionId, session);

					const newToken = await signSessionToken(sessionId, settings.sessionSecret);
					return { ok: true, photo: photoData, sessionToken: newToken };
				},
			},

			// ── Public: Remove uploaded photo from session ─────────────
			"chat/removePhoto": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const body = ctx.input as { sessionToken?: string; mediaId?: string };

					const settings = await getSettings(ctx);
					const sessionId = await verifySessionToken(body.sessionToken ?? "", settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired. Please refresh the page and try again.");

					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session || session.status !== "active") {
						throw PluginRouteError.notFound("Session not found.");
					}

					if (body.mediaId) {
						session.collected.photos = (session.collected.photos ?? []).filter((p) => p.mediaId !== body.mediaId);
						await ctx.storage.sessions.put(sessionId, session);
						await deletePhotoFromR2(body.mediaId);
					}

					const newToken = await signSessionToken(sessionId, settings.sessionSecret);
					return { ok: true, sessionToken: newToken };
				},
			},

			// ── Public: Begin a chunked video upload ────────────────────
			"video/init": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const settings = await getSettings(ctx);
					if (!settings.enabled) throw new PluginRouteError("SERVICE_UNAVAILABLE", "Submissions are temporarily closed.", 503);
					if (!settings.youtubeEnabled) throw new PluginRouteError("SERVICE_UNAVAILABLE", "Video uploads are not currently enabled.", 503);

					const body = ctx.input as { sessionToken?: string; filename?: string; contentType?: string; sizeBytes?: number };
					const sessionId = await verifySessionToken(body.sessionToken ?? "", settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired. Please refresh the page and try again.");
					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session || session.status !== "active") throw PluginRouteError.notFound("Session not found.");

					const ip = getIP(ctx);
					if (!(await checkSubmissionRateLimit(ip, settings, ctx))) {
						throw new PluginRouteError("RATE_LIMITED", "You've reached the daily submission limit. Please try again tomorrow.", 429);
					}

					const contentType = (body.contentType ?? "").toLowerCase();
					if (!isAllowedVideoType(contentType)) throw PluginRouteError.badRequest("Only MP4, MOV, and WebM videos are accepted.");
					const capBytes = (settings.maxVideoSizeMb ?? 1024) * 1024 * 1024;
					if (typeof body.sizeBytes !== "number" || !withinSizeCap(body.sizeBytes, capBytes)) {
						throw PluginRouteError.badRequest(`Video too large. Maximum size is ${settings.maxVideoSizeMb ?? 1024}MB.`);
					}

					const bucket = await getMediaMultipart();
					if (!bucket) throw new PluginRouteError("CONFIG_ERROR", "Video storage is not available.", 503);

					const ext = VIDEO_EXT_BY_TYPE[contentType] ?? "";
					const submissionId = crypto.randomUUID();
					const key = videoKey(submissionId, ext);
					const mp = await bucket.createMultipartUpload(key);

					const video: VideoUpload = {
						r2Key: key,
						uploadId: mp.uploadId,
						sizeBytes: body.sizeBytes,
						contentType,
						originalFilename: body.filename ?? `video${ext}`,
						parts: [],
					};
					// Stash on the session until the form is submitted (mirrors photos).
					session.collected.videoUpload = video;
					session.collected.videoSubmissionId = submissionId;
					await ctx.storage.sessions.put(sessionId, session);

					const newToken = await signSessionToken(sessionId, settings.sessionSecret);
					return {
						ok: true,
						submissionId,
						key,
						uploadId: mp.uploadId,
						partSize: R2_PART_SIZE,
						partCount: partCount(body.sizeBytes),
						sessionToken: newToken,
					};
				},
			},

			// ── Public: Upload one part (raw binary body) ───────────────
			"video/part": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const url = new URL(ctx.request.url);
					const token = url.searchParams.get("sessionToken") ?? "";
					const submissionId = url.searchParams.get("submissionId") ?? "";
					const partNumber = parseInt(url.searchParams.get("partNumber") ?? "", 10);
					if (!submissionId || !Number.isInteger(partNumber) || partNumber < 1) {
						throw PluginRouteError.badRequest("Missing or invalid part parameters.");
					}

					const settings = await getSettings(ctx);
					const sessionId = await verifySessionToken(token, settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired. Please refresh the page and try again.");
					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session || session.collected.videoSubmissionId !== submissionId) throw PluginRouteError.notFound("Upload session not found.");
					const video = session.collected.videoUpload;
					if (!video?.uploadId) throw PluginRouteError.conflict("Upload already finalized.");

					const bytes = new Uint8Array(await ctx.request.arrayBuffer());
					if (bytes.byteLength === 0) throw PluginRouteError.badRequest("Empty part.");
					if (bytes.byteLength > R2_PART_SIZE) throw PluginRouteError.badRequest("Part exceeds maximum size.");

					// Sniff magic bytes on the first part only.
					if (partNumber === 1 && !sniffVideoMagic(bytes.subarray(0, 16))) {
						throw PluginRouteError.badRequest("File does not look like a supported video.");
					}

					const bucket = await getMediaMultipart();
					if (!bucket) throw new PluginRouteError("CONFIG_ERROR", "Video storage is not available.", 503);
					const handle = bucket.resumeMultipartUpload(video.r2Key, video.uploadId);
					const uploaded = await handle.uploadPart(partNumber, bytes);

					video.parts = [...video.parts.filter((p) => p.partNumber !== partNumber), { partNumber: uploaded.partNumber, etag: uploaded.etag }];
					session.collected.videoUpload = video;
					await ctx.storage.sessions.put(sessionId, session);

					return { ok: true, partNumber: uploaded.partNumber, etag: uploaded.etag };
				},
			},

			// ── Public: Finalize the multipart upload ───────────────────
			"video/complete": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const body = ctx.input as { sessionToken?: string; submissionId?: string };
					const settings = await getSettings(ctx);
					const sessionId = await verifySessionToken(body.sessionToken ?? "", settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired. Please refresh the page and try again.");
					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session || session.collected.videoSubmissionId !== body.submissionId) throw PluginRouteError.notFound("Upload session not found.");
					const video = session.collected.videoUpload;
					if (!video?.uploadId) throw PluginRouteError.conflict("Upload already finalized.");
					if (video.parts.length === 0) throw PluginRouteError.badRequest("No parts uploaded.");

					const bucket = await getMediaMultipart();
					if (!bucket) throw new PluginRouteError("CONFIG_ERROR", "Video storage is not available.", 503);
					const handle = bucket.resumeMultipartUpload(video.r2Key, video.uploadId);
					const ordered = [...video.parts].sort((a, b) => a.partNumber - b.partNumber);
					await handle.complete(ordered);

					video.uploadId = undefined; // mark finalized
					video.parts = ordered;
					session.collected.videoUpload = video;
					await ctx.storage.sessions.put(sessionId, session);

					const newToken = await signSessionToken(sessionId, settings.sessionSecret);
					return { ok: true, key: video.r2Key, sessionToken: newToken };
				},
			},

			// ── Public: Abort an in-progress upload ─────────────────────
			"video/abort": {
				public: true,
				handler: async (ctx: RouteContext) => {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const body = ctx.input as { sessionToken?: string; submissionId?: string };
					const settings = await getSettings(ctx);
					const sessionId = await verifySessionToken(body.sessionToken ?? "", settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired.");
					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session || session.collected.videoSubmissionId !== body.submissionId) return { ok: true };
					const video = session.collected.videoUpload;
					if (video?.uploadId) {
						const bucket = await getMediaMultipart();
						if (bucket) {
							try { await bucket.resumeMultipartUpload(video.r2Key, video.uploadId).abort(); } catch { /* best effort */ }
						}
					}
					session.collected.videoUpload = undefined;
					session.collected.videoSubmissionId = undefined;
					await ctx.storage.sessions.put(sessionId, session);
					return { ok: true };
				},
			},

			// ── Public: Submit form ─────────────────────────────────────
			"form/submit": {
				public: true,
				handler: async (ctx: RouteContext) => {
					try {
					if (!validateOrigin(ctx.request)) throw PluginRouteError.forbidden("Invalid origin");
					const body = ctx.input as {
						sessionToken?: string;
						story?: string;
						name?: string;
						email?: string;
						phone?: string;
						location?: string;
						creditPreference?: "named" | "anonymous";
						newsletterSignup?: boolean;
						consentCopyright?: boolean;
						consentAge?: boolean;
					};

					const settings = await getSettings(ctx);
					const ip = getIP(ctx);

					const sessionId = await verifySessionToken(body.sessionToken ?? "", settings.sessionSecret);
					if (!sessionId) throw PluginRouteError.unauthorized("Session expired. Please refresh the page and try again.");

					const session = await ctx.storage.sessions.get(sessionId) as Session | null;
					if (!session) throw PluginRouteError.notFound("Session not found.");
					if (session.status === "completed") throw PluginRouteError.conflict("This story has already been submitted. Refresh the page to start a new submission.");

					const story = (body.story ?? "").trim();
					const name = (body.name ?? "").trim();
					const location = (body.location ?? "").trim();
					if (!story) throw PluginRouteError.badRequest("Please tell us your story.");
					if (!name) throw PluginRouteError.badRequest("Please include your name.");
					if (!body.consentCopyright) throw PluginRouteError.badRequest("Please confirm you have rights to share these photos.");
					if (!body.consentAge) throw PluginRouteError.badRequest("Please confirm you are 18 or older.");

					const wordCount = story.split(/\s+/).filter(Boolean).length;
					if (wordCount > (settings.maxStoryWords ?? 2000)) {
						throw PluginRouteError.badRequest(`Story is too long. Please keep it under ${settings.maxStoryWords ?? 2000} words.`);
					}

					if (!(await checkSubmissionRateLimit(ip, settings, ctx))) {
						throw new PluginRouteError("RATE_LIMITED", "You've reached the daily submission limit. Please try again tomorrow.", 429);
					}

					const textHash = await computeHash(story);
					const dupeCheck = await ctx.storage.submissions.query({ where: { textHash }, limit: 1 });
					if (dupeCheck.items.length > 0) throw PluginRouteError.conflict("A very similar story has already been submitted.");

					const completedVideo = session.collected.videoUpload && !session.collected.videoUpload.uploadId
						? session.collected.videoUpload
						: undefined;

					const taxonomy: InferredTaxonomy = {
						categories: [], eras: [], tags: [], regions: [], people: [],
						content_types: [
							...((session.collected.photos?.length ?? 0) > 0 ? ["photo"] : []),
							...(completedVideo ? ["video"] : []),
							"story",
						],
						counties: [],
						confidence: 1.0,
					};

					const now = new Date().toISOString();

					const creditPref = body.creditPreference ?? "anonymous";
					const isNamed = creditPref === "named";

					// Build SEO from submission data so it's pre-populated in the admin
					const seoTitle = isNamed ? `${name}'s Texas Memory` : "A Texas Memory";
					const plainStory = story.replace(/\s+/g, " ").trim();
					const seoDescription = plainStory.length > 160
						? plainStory.slice(0, 160).replace(/\s+\S*$/, "") + "…"
						: plainStory;
					const firstPhotoUrl = (session.collected.photos ?? [])[0]?.url ?? null;
					const seo = { title: seoTitle, description: seoDescription, image: firstPhotoUrl };

					// Public title: omit submitter name for anonymous credits
					const entryTitle = isNamed ? name : "A Texas Memory";

					let emdashContentId: string | undefined;
					try {
						if (ctx.content?.create) {
							const entry = await ctx.content.create("community_submissions", {
								title: entryTitle,
								story_original: textToPortableText(story),
								submitter_name: name,
								submitter_email: body.email ?? "",
								location,
								credit_preference: creditPref,
								photos: session.collected.photos ?? [],
								review_status: "pending",
								consent_given: true,
								copyright_declared: true,
								age_confirmed: true,
								newsletter_signup: body.newsletterSignup ?? false,
								ip_address: ip,
								session_id: sessionId,
								consent_timestamp: new Date().toISOString(),
								copyright_timestamp: new Date().toISOString(),
								seo,
							});
							emdashContentId = entry.id;
						}
					} catch (err) {
						ctx.log.warn(`[ebt-shoebox] Failed to create content entry: ${err}`);
					}

					const submissionId = crypto.randomUUID();
					await ctx.storage.submissions.put(submissionId, {
						sessionId, ip, status: "pending", createdAt: now, updatedAt: now,
						textHash, imageHashes: [], emdashContentId,
						title: entryTitle,
						submitterName: name, submitterEmail: body.email ?? "",
						location,
						photoCount: session.collected.photos?.length ?? 0,
						photos: session.collected.photos ?? [],
						video: completedVideo,
						youtube: completedVideo ? { state: "staged", bytesSent: 0, attempts: 0 } : undefined,
						taxonomyConfidence: 1.0, taxonomyTags: taxonomy,
						eeatSignals: {}, funnelAnalytics: { submissionCompleted: now },
					} satisfies SubmissionRecord);

					// Store story in session.collected so the admin queue can display it
					session.collected.story = story;
					session.status = "completed";
					await ctx.storage.sessions.put(sessionId, session);
					await trackAnalytic("submission_completed", ip, sessionId, ctx);

					if (body.newsletterSignup && body.email) await signUpForNewsletter(body.email, name, body.phone, settings);

					return { ok: true, submissionId };
					} catch (err) {
						if (err instanceof PluginRouteError) throw err;
						// Log details server-side; never return raw error text to the
						// public caller (this was leaking internals via INTERNAL_DEBUG).
						ctx.log.error(`[ebt-shoebox] form/submit error: ${String(err)}`);
						throw new PluginRouteError("INTERNAL_ERROR", "Something went wrong submitting your story. Please try again.", 500);
					}
				},
			},

			// ── Admin: Settings ─────────────────────────────────────────
			"settings/get": {
				handler: async (ctx: RouteContext) => {
					const s = await getSettings(ctx);
					return {
						enabled: s.enabled,
						brevoApiKey: s.brevoApiKey ? "••••••••" : "",
						newsletterEnabled: s.newsletterEnabled,
						brevoListId: s.brevoListId ?? 3,
						maxFileSize: s.maxFileSize ?? 10,
						maxPhotos: s.maxPhotos ?? 5,
						maxSubmissionsPerIp: s.maxSubmissionsPerIp ?? 3,
						maxStoryWords: s.maxStoryWords ?? 2000,
						youtubeEnabled: s.youtubeEnabled ?? false,
						maxVideoSizeMb: s.maxVideoSizeMb ?? 1024,
						youtubeDailyCap: s.youtubeDailyCap ?? 5,
						youtubeTitlePrefix: s.youtubeTitlePrefix ?? "From the Shoebox",
						youtubePublicPlaceholder: s.youtubePublicPlaceholder ?? false,
					};
				},
			},

			"settings/update": {
				handler: async (ctx: RouteContext) => {
					const body = ctx.input as Record<string, unknown>;
					const PLACEHOLDER = "••••••••";
					const save = async (key: string, value: unknown) => {
						if (value === PLACEHOLDER || value === null || value === undefined) return;
						await ctx.kv.set(`settings:${key}`, value);
					};
					await Promise.all([
						save("enabled", body.enabled),
						save("brevoApiKey", body.brevoApiKey),
						save("newsletterEnabled", body.newsletterEnabled),
						body.brevoListId != null ? ctx.kv.set("settings:brevoListId", Number(body.brevoListId)) : Promise.resolve(),
						body.maxFileSize != null ? ctx.kv.set("settings:maxFileSize", Number(body.maxFileSize)) : Promise.resolve(),
						body.maxPhotos != null ? ctx.kv.set("settings:maxPhotos", Number(body.maxPhotos)) : Promise.resolve(),
						body.maxSubmissionsPerIp != null ? ctx.kv.set("settings:maxSubmissionsPerIp", Number(body.maxSubmissionsPerIp)) : Promise.resolve(),
						body.maxStoryWords != null ? ctx.kv.set("settings:maxStoryWords", Number(body.maxStoryWords)) : Promise.resolve(),
						save("youtubeEnabled", body.youtubeEnabled),
						body.maxVideoSizeMb != null ? ctx.kv.set("settings:maxVideoSizeMb", Number(body.maxVideoSizeMb)) : Promise.resolve(),
						body.youtubeDailyCap != null ? ctx.kv.set("settings:youtubeDailyCap", Number(body.youtubeDailyCap)) : Promise.resolve(),
						save("youtubeTitlePrefix", body.youtubeTitlePrefix),
						save("youtubePublicPlaceholder", body.youtubePublicPlaceholder),
					]);
					return { ok: true };
				},
			},

			// ── Admin: Submissions ──────────────────────────────────────
			"submissions/list": {
				handler: async (ctx: RouteContext) => {
					const params = new URL(ctx.request.url).searchParams;
					const status = params.get("status") ?? "pending";
					const cursor = params.get("cursor") ?? undefined;
					const limit = Math.min(parseInt(params.get("limit") ?? "20", 10), 100);
					const result = await ctx.storage.submissions.query({
						where: status !== "all" ? { status } : undefined,
						orderBy: { createdAt: "desc" },
						limit, cursor,
					});
					return {
						items: result.items.map((item) => ({ id: item.id, ...(item.data as SubmissionRecord) })),
						cursor: result.cursor,
						hasMore: result.hasMore,
					};
				},
			},

			"submissions/get": {
				handler: async (ctx: RouteContext) => {
					const id = new URL(ctx.request.url).searchParams.get("id");
					if (!id) throw PluginRouteError.badRequest("Missing submission id");
					const submission = await ctx.storage.submissions.get(id) as SubmissionRecord | null;
					if (!submission) throw PluginRouteError.notFound("Submission not found");
					const session = await ctx.storage.sessions.get(submission.sessionId) as Session | null;
					return { id, ...submission, collected: session?.collected ?? {} };
				},
			},

			"submissions/approve": {
				handler: async (ctx: RouteContext) => {
					const body = ctx.input as { id?: string; emdashContentId?: string };
					if (!body.id) throw PluginRouteError.badRequest("Missing submission id");
					const submission = await ctx.storage.submissions.get(body.id) as SubmissionRecord | null;
					if (!submission) throw PluginRouteError.notFound("Submission not found");
					const updated = { ...submission, status: "approved" as const, updatedAt: new Date().toISOString(), emdashContentId: body.emdashContentId ?? submission.emdashContentId };
					if (updated.video && updated.youtube && updated.youtube.state === "staged") {
						updated.youtube = { ...updated.youtube, state: "pending_upload" };
					}
					await ctx.storage.submissions.put(body.id, updated);
					if (updated.emdashContentId && ctx.content?.update) {
						try { await ctx.content.update("community_submissions", updated.emdashContentId, { review_status: "approved" }); }
						catch (err) { ctx.log.warn(`[ebt-shoebox] ${err}`); }
					}
					return { ok: true, id: body.id, status: "approved" };
				},
			},

			"submissions/reject": {
				handler: async (ctx: RouteContext) => {
					const body = ctx.input as { id?: string; reason?: string };
					if (!body.id) throw PluginRouteError.badRequest("Missing submission id");
					const submission = await ctx.storage.submissions.get(body.id) as SubmissionRecord | null;
					if (!submission) throw PluginRouteError.notFound("Submission not found");
					const updated = { ...submission, status: "rejected" as const, updatedAt: new Date().toISOString() };
					await ctx.storage.submissions.put(body.id, updated);
					if (updated.emdashContentId && ctx.content?.update) {
						try { await ctx.content.update("community_submissions", updated.emdashContentId, { review_status: "rejected", rejection_reason: body.reason ?? "" }); }
						catch (err) { ctx.log.warn(`[ebt-shoebox] ${err}`); }
					}
					if (submission.photos?.length) {
						await Promise.all(
							submission.photos
								.filter((p) => p.mediaId)
								.map((p) => deletePhotoFromR2(p.mediaId)),
						);
					}
					if (submission.video?.uploadId) {
						const bucket = await getMediaMultipart();
						if (bucket) {
							try { await bucket.resumeMultipartUpload(submission.video.r2Key, submission.video.uploadId).abort(); } catch { /* best effort */ }
						}
					} else if (submission.video?.r2Key) {
						await deletePhotoFromR2(submission.video.r2Key);
					}
					return { ok: true, id: body.id, status: "rejected" };
				},
			},

			"analytics/stats": {
				handler: async (ctx: RouteContext) => {
					const [opened, completed, pending] = await Promise.all([
						ctx.storage.analytics.count({ event: "widget_opened" }),
						ctx.storage.analytics.count({ event: "submission_completed" }),
						ctx.storage.submissions.count({ status: "pending" }),
					]);
					return { opened, completed, pending };
				},
			},
		},
	});
}

export default createPlugin;
