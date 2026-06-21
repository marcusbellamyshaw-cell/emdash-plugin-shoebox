# Shoebox Video Upload → Automatic YouTube Hosting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let community members upload large video files through the Shoebox flow; on admin approval, automatically transfer the video to EBT's YouTube channel via the YouTube Data API and embed it on the published entry.

**Architecture:** Browser uploads a large video to R2 in chunks through plugin routes that proxy to the `env.MEDIA` R2 Worker binding (R2 multipart). The operational state machine lives in the plugin's `submissions` storage record. On approval, the record moves to `pending_upload`; a recurring `cron` hook performs OAuth refresh and a **resumable** R2→YouTube transfer that advances a few MB per tick until complete, then writes the YouTube video id onto the `community_submissions` content entry for rendering.

**Tech Stack:** TypeScript, emdash native plugin API (`definePlugin`, `cron` hook, `ctx.cron`, `ctx.kv`, `ctx.storage`), Cloudflare R2 Worker binding (multipart), YouTube Data API v3 (OAuth2 + resumable upload), vitest.

**Spec:** `docs/superpowers/specs/2026-06-20-shoebox-video-youtube-design.md`

## Global Constraints

Copied verbatim from the spec and verified against the installed codebase. Every task's requirements implicitly include this section.

- **emdash version:** installed `0.17.2`; plugin `peerDependencies.emdash` is `>=0.16.0`. The `cron` hook, `ctx.cron` (`CronAccess`), and `CronEvent` exist in this version. **Do not** raise the peer floor unless a task requires a newer API.
- **No new emdash capability for cron.** `cron` is a *hook name* (declared in `hooks`), not a capability. `ctx.cron` is "always available". Capabilities array stays as-is except where a task adds one explicitly.
- **R2 reached via the `env.MEDIA` binding only**, never HTTP and never `ctx.media.upload()` (the binding has no presigned URLs — issue #1313). Reuse the existing `getMediaBucket()` indirection in `sandbox-entry.ts` (the `_CF_WORKERS = "cloudflare:workers"` dynamic import). This is why the feature is **not** blocked on emdash PR #1562.
- **Outbound HTTP uses `globalThis.fetch` + `AbortController` with a timeout**, mirroring the existing `signUpForNewsletter` / `sendApprovalEmail` Brevo helpers. This is a **native** (in-process) plugin, so `AbortController` is safe here — the "no AbortSignal" rule applies only to `ctx.http.fetch` inside the sandbox, which this plugin does not use.
- **`allowedHosts`** must list every outbound host. Add `oauth2.googleapis.com`, `www.googleapis.com`, `upload.googleapis.com` alongside the existing `api.brevo.com`.
- **Worker request body ≈ 100 MB.** Upload chunks (R2 part size) are **64 MB**. Resumable PUT chunks to YouTube are **8 MB** (must be a multiple of 256 KB per the resumable protocol; 8 MB = 32 × 256 KB).
- **YouTube created privacy is `private`** and stays private until Google's API audit passes (platform-enforced for unverified projects — do not fight it). Pre-audit public placeholder is **off by default**.
- **Default max video size: 1 GB.** Configurable via settings.
- **Cron cadence ≈ every 10 minutes.**
- **Secrets** (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`) are read from the Worker env (same `cloudflare:workers` import as `MEDIA`), set via `wrangler secret put`. Non-secret config lives in plugin settings.
- **Changeset prose** must be user-facing release notes (Fixes/Adds…), not commit summaries. **AI disclosure** string, where required by repo convention, reads "Claude Opus 4.8". Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Style:** tabs for indentation, double quotes, match the existing `sandbox-entry.ts` idiom. Keep new logic in focused `src/video/*.ts` modules (the existing `sandbox-entry.ts` is already ~820 lines — do not pile more pure logic into it; it only wires routes/hooks to the modules).

## Design Refinements vs. Spec (decided during planning — flag to user)

1. **Operational state lives in plugin storage, not the content collection.** The spec's B1 put the state machine on `community_submissions` fields. Churning a content entry every cron tick would spam revisions, so the state machine (`video`, `youtube` operational fields) is stored on the plugin's `submissions` record instead. Only the **final** result (`youtube_video_id`, embed visibility) is written to the `community_submissions` content entry, once, on completion. Architecture is otherwise exactly as approved.
2. **Public embed rendering is a site-side change**, not in this plugin repo. This plan writes the `youtube_video_id` field onto the content entry and documents the embed snippet; the actual `<iframe>` rendering in `from-the-shoebox/[id]` lives in the EBT site templates and is tracked as an integration follow-up (Task 16 note), not a plugin task.

---

## File Structure

**New files:**
- `vitest.config.ts` — test runner config.
- `src/video/chunking.ts` — pure chunk/range math (R2 part sizing; YouTube 256 KB-aligned ranges; `Content-Range` headers).
- `src/video/state.ts` — `VideoState` type, transition table, guard helpers.
- `src/video/quota.ts` — KV-backed daily YouTube upload counter (injectable kv).
- `src/video/validation.ts` — video content-type allowlist + magic-byte sniff + size cap.
- `src/video/youtube.ts` — YouTube client: OAuth refresh, resumable session init, chunk push, response parsing (injectable `fetch`).
- `src/video/r2.ts` — R2 multipart helpers over a minimal binding type (init/part/complete/abort/getRange).
- `src/video/types.ts` — shared `VideoUpload`, `YoutubeTransfer` record shapes.
- `tests/chunking.test.ts`, `tests/state.test.ts`, `tests/quota.test.ts`, `tests/validation.test.ts`, `tests/youtube.test.ts` — unit tests.
- `scripts/youtube-consent.mjs` — one-time local OAuth consent helper (prints a refresh token).

**Modified files:**
- `package.json` — add `vitest` devDep + `test` script.
- `src/types.ts` — extend `SubmissionRecord` with `video?` / `youtube?`; extend `PluginSettings` + `DEFAULT_SETTINGS`.
- `src/sandbox-entry.ts` — add `allowedHosts`, `settingsSchema` entries, install-hook cron schedule + secret defaults, `cron` hook handler, video routes, approve-route change, cleanup logic.
- `src/index.ts` — keep `allowedHosts` / descriptor in sync (mirror of sandbox-entry).
- `README.md` — YouTube setup + secrets docs.

---

## Task 1: Test harness + `src/video` scaffold

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/video/chunking.ts` (stub)
- Test: `tests/chunking.test.ts`

**Interfaces:**
- Produces: a working `pnpm test` command; the `src/video/` module dir; `partSize` constant consumed by Task 9.

- [ ] **Step 1: Add vitest devDependency and test script**

Edit `package.json` `devDependencies` to add `"vitest": "^2.0.0"`, and add a `scripts` block:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

Run: `pnpm install`
Expected: vitest added to `node_modules`.

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
```

- [ ] **Step 3: Write the failing test**

Create `tests/chunking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { R2_PART_SIZE } from "../src/video/chunking.js";

describe("chunking constants", () => {
	it("uses a 64 MB R2 part size", () => {
		expect(R2_PART_SIZE).toBe(64 * 1024 * 1024);
	});
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/video/chunking.js`.

- [ ] **Step 5: Create the module stub**

Create `src/video/chunking.ts`:

```ts
/** R2 multipart part size for browser → R2 video uploads (64 MB). */
export const R2_PART_SIZE = 64 * 1024 * 1024;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/video/chunking.ts tests/chunking.test.ts
git commit -m "test: add vitest harness and video module scaffold"
```

---

## Task 2: Chunk & range math (`src/video/chunking.ts`)

**Files:**
- Modify: `src/video/chunking.ts`
- Test: `tests/chunking.test.ts`

**Interfaces:**
- Consumes: `R2_PART_SIZE` (Task 1).
- Produces:
  - `YT_CHUNK_SIZE: number` (8 MB).
  - `partCount(totalBytes: number): number`
  - `partRange(partNumber: number, totalBytes: number): { start: number; end: number; length: number }` — `partNumber` is 1-based; `end` exclusive.
  - `nextYoutubeChunk(bytesSent: number, totalBytes: number): { start: number; end: number; length: number; isFinal: boolean }` — `end` inclusive (YouTube `Content-Range` style); `length` is always a multiple of 256 KB unless `isFinal`.
  - `contentRangeHeader(start: number, end: number, total: number): string` — `"bytes start-end/total"` with **inclusive** `end`.

- [ ] **Step 1: Write the failing tests**

Replace `tests/chunking.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
	R2_PART_SIZE,
	YT_CHUNK_SIZE,
	partCount,
	partRange,
	nextYoutubeChunk,
	contentRangeHeader,
} from "../src/video/chunking.js";

describe("R2 part math", () => {
	it("uses a 64 MB R2 part size", () => {
		expect(R2_PART_SIZE).toBe(64 * 1024 * 1024);
	});

	it("counts parts, rounding up", () => {
		expect(partCount(0)).toBe(0);
		expect(partCount(1)).toBe(1);
		expect(partCount(R2_PART_SIZE)).toBe(1);
		expect(partCount(R2_PART_SIZE + 1)).toBe(2);
		expect(partCount(R2_PART_SIZE * 3)).toBe(3);
	});

	it("computes a part range (1-based, end exclusive)", () => {
		expect(partRange(1, R2_PART_SIZE * 3)).toEqual({ start: 0, end: R2_PART_SIZE, length: R2_PART_SIZE });
		const total = R2_PART_SIZE + 10;
		expect(partRange(2, total)).toEqual({ start: R2_PART_SIZE, end: total, length: 10 });
	});
});

describe("YouTube resumable chunk math", () => {
	it("uses an 8 MB chunk that is a multiple of 256 KB", () => {
		expect(YT_CHUNK_SIZE).toBe(8 * 1024 * 1024);
		expect(YT_CHUNK_SIZE % (256 * 1024)).toBe(0);
	});

	it("returns a full aligned chunk when more than a chunk remains", () => {
		const total = YT_CHUNK_SIZE * 3 + 123;
		const c = nextYoutubeChunk(0, total);
		expect(c).toEqual({ start: 0, end: YT_CHUNK_SIZE - 1, length: YT_CHUNK_SIZE, isFinal: false });
	});

	it("returns the final (possibly unaligned) chunk at the tail", () => {
		const total = YT_CHUNK_SIZE + 100;
		const c = nextYoutubeChunk(YT_CHUNK_SIZE, total);
		expect(c).toEqual({ start: YT_CHUNK_SIZE, end: total - 1, length: 100, isFinal: true });
	});

	it("treats an exactly-aligned last chunk as final", () => {
		const total = YT_CHUNK_SIZE;
		const c = nextYoutubeChunk(0, total);
		expect(c.isFinal).toBe(true);
		expect(c.length).toBe(YT_CHUNK_SIZE);
	});

	it("formats Content-Range with an inclusive end", () => {
		expect(contentRangeHeader(0, 8388607, 16777216)).toBe("bytes 0-8388607/16777216");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `YT_CHUNK_SIZE`/`partCount`/etc. not exported.

- [ ] **Step 3: Implement the module**

Replace `src/video/chunking.ts` with:

```ts
/** R2 multipart part size for browser → R2 video uploads (64 MB). */
export const R2_PART_SIZE = 64 * 1024 * 1024;

/** YouTube resumable PUT chunk size (8 MB = 32 × 256 KB). Must stay a 256 KB multiple. */
export const YT_CHUNK_SIZE = 8 * 1024 * 1024;

const YT_ALIGN = 256 * 1024;

/** Number of R2 parts needed for a file of `totalBytes`, rounded up. */
export function partCount(totalBytes: number): number {
	return Math.ceil(totalBytes / R2_PART_SIZE);
}

/** Byte range for a 1-based R2 part. `end` is exclusive. */
export function partRange(
	partNumber: number,
	totalBytes: number,
): { start: number; end: number; length: number } {
	const start = (partNumber - 1) * R2_PART_SIZE;
	const end = Math.min(start + R2_PART_SIZE, totalBytes);
	return { start, end, length: end - start };
}

/**
 * Next resumable chunk to push to YouTube given how many bytes are already sent.
 * `end` is INCLUSIVE (YouTube Content-Range style). Non-final chunks are exactly
 * YT_CHUNK_SIZE (a 256 KB multiple); the final chunk carries the remainder.
 */
export function nextYoutubeChunk(
	bytesSent: number,
	totalBytes: number,
): { start: number; end: number; length: number; isFinal: boolean } {
	const remaining = totalBytes - bytesSent;
	if (remaining <= YT_CHUNK_SIZE) {
		return { start: bytesSent, end: totalBytes - 1, length: remaining, isFinal: true };
	}
	// Defensive: keep non-final chunks 256 KB-aligned even if YT_CHUNK_SIZE changes.
	const length = YT_CHUNK_SIZE - (YT_CHUNK_SIZE % YT_ALIGN);
	return { start: bytesSent, end: bytesSent + length - 1, length, isFinal: false };
}

/** "bytes start-end/total" with an inclusive `end`. */
export function contentRangeHeader(start: number, end: number, total: number): string {
	return `bytes ${start}-${end}/${total}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (all chunking tests).

- [ ] **Step 5: Commit**

```bash
git add src/video/chunking.ts tests/chunking.test.ts
git commit -m "feat: chunk and resumable-range math for video uploads"
```

---

## Task 3: Video state machine (`src/video/state.ts`)

**Files:**
- Create: `src/video/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Produces:
  - `type VideoState = "staged" | "pending_upload" | "uploading" | "uploaded" | "failed"`
  - `canTransition(from: VideoState, to: VideoState): boolean`
  - `assertTransition(from: VideoState, to: VideoState): void` — throws `Error` if illegal.
  - `RETRYABLE_FROM_FAILED: boolean` (failed → pending_upload allowed).

- [ ] **Step 1: Write the failing tests**

Create `tests/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canTransition, assertTransition } from "../src/video/state.js";

describe("video state machine", () => {
	it("allows the happy path", () => {
		expect(canTransition("staged", "pending_upload")).toBe(true);
		expect(canTransition("pending_upload", "uploading")).toBe(true);
		expect(canTransition("uploading", "uploaded")).toBe(true);
	});

	it("allows failure and retry", () => {
		expect(canTransition("uploading", "failed")).toBe(true);
		expect(canTransition("pending_upload", "failed")).toBe(true);
		expect(canTransition("failed", "pending_upload")).toBe(true);
	});

	it("forbids skipping and illegal moves", () => {
		expect(canTransition("staged", "uploading")).toBe(false);
		expect(canTransition("staged", "uploaded")).toBe(false);
		expect(canTransition("uploaded", "uploading")).toBe(false);
		expect(canTransition("uploaded", "pending_upload")).toBe(false);
	});

	it("assertTransition throws on illegal moves", () => {
		expect(() => assertTransition("staged", "uploaded")).toThrow(/illegal/i);
		expect(() => assertTransition("staged", "pending_upload")).not.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/video/state.js` not found.

- [ ] **Step 3: Implement the module**

Create `src/video/state.ts`:

```ts
export type VideoState =
	| "staged"
	| "pending_upload"
	| "uploading"
	| "uploaded"
	| "failed";

const TRANSITIONS: Record<VideoState, VideoState[]> = {
	staged: ["pending_upload"],
	pending_upload: ["uploading", "failed"],
	uploading: ["uploaded", "failed", "pending_upload"],
	uploaded: [],
	failed: ["pending_upload"],
};

/** failed → pending_upload is permitted so the cron can retry transient errors. */
export const RETRYABLE_FROM_FAILED = true;

export function canTransition(from: VideoState, to: VideoState): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: VideoState, to: VideoState): void {
	if (!canTransition(from, to)) {
		throw new Error(`illegal video state transition: ${from} → ${to}`);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/state.ts tests/state.test.ts
git commit -m "feat: video upload/transfer state machine"
```

---

## Task 4: Daily YouTube quota counter (`src/video/quota.ts`)

**Files:**
- Create: `src/video/quota.ts`
- Test: `tests/quota.test.ts`

**Interfaces:**
- Consumes: a minimal KV shape `{ get<T>(k): Promise<T|null>; set(k, v): Promise<void> }` (matches `ctx.kv`).
- Produces:
  - `quotaKey(date: string): string` → `"youtube:quota:<date>"`.
  - `getUsed(kv, date): Promise<number>`
  - `incrementUsed(kv, date): Promise<number>` — returns new count.
  - `hasQuota(kv, date, dailyCap): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `tests/quota.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module**

Create `src/video/quota.ts`:

```ts
export interface QuotaKv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
}

export function quotaKey(date: string): string {
	return `youtube:quota:${date}`;
}

export async function getUsed(kv: QuotaKv, date: string): Promise<number> {
	const v = await kv.get<number>(quotaKey(date));
	return typeof v === "number" && v > 0 ? v : 0;
}

/**
 * Read-modify-write increment. Safe because the cron hook is dispatched
 * single-flight per plugin, so there is no concurrent writer for this key.
 */
export async function incrementUsed(kv: QuotaKv, date: string): Promise<number> {
	const next = (await getUsed(kv, date)) + 1;
	await kv.set(quotaKey(date), next);
	return next;
}

export async function hasQuota(kv: QuotaKv, date: string, dailyCap: number): Promise<boolean> {
	return (await getUsed(kv, date)) < dailyCap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/quota.ts tests/quota.test.ts
git commit -m "feat: daily YouTube upload quota counter"
```

---

## Task 5: Video validation (`src/video/validation.ts`)

**Files:**
- Create: `src/video/validation.ts`
- Test: `tests/validation.test.ts`

**Interfaces:**
- Produces:
  - `ALLOWED_VIDEO_TYPES: readonly string[]` (`"video/mp4"`, `"video/quicktime"`, `"video/webm"`).
  - `isAllowedVideoType(contentType: string): boolean`
  - `withinSizeCap(sizeBytes: number, capBytes: number): boolean`
  - `sniffVideoMagic(head: Uint8Array): boolean` — true if first bytes look like mp4/mov (`ftyp` at offset 4) or webm/matroska (`0x1A45DFA3`).

- [ ] **Step 1: Write the failing tests**

Create `tests/validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	ALLOWED_VIDEO_TYPES,
	isAllowedVideoType,
	withinSizeCap,
	sniffVideoMagic,
} from "../src/video/validation.js";

describe("video validation", () => {
	it("allows mp4/mov/webm only", () => {
		expect(ALLOWED_VIDEO_TYPES).toContain("video/mp4");
		expect(isAllowedVideoType("video/mp4")).toBe(true);
		expect(isAllowedVideoType("video/quicktime")).toBe(true);
		expect(isAllowedVideoType("video/webm")).toBe(true);
		expect(isAllowedVideoType("video/avi")).toBe(false);
		expect(isAllowedVideoType("image/jpeg")).toBe(false);
		expect(isAllowedVideoType("VIDEO/MP4")).toBe(true);
	});

	it("enforces a size cap", () => {
		expect(withinSizeCap(100, 1000)).toBe(true);
		expect(withinSizeCap(1000, 1000)).toBe(true);
		expect(withinSizeCap(1001, 1000)).toBe(false);
		expect(withinSizeCap(0, 1000)).toBe(false);
	});

	it("sniffs mp4/mov ftyp boxes", () => {
		const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
		expect(sniffVideoMagic(mp4)).toBe(true);
	});

	it("sniffs webm/matroska EBML header", () => {
		const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
		expect(sniffVideoMagic(webm)).toBe(true);
	});

	it("rejects non-video heads", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
		expect(sniffVideoMagic(jpeg)).toBe(false);
		expect(sniffVideoMagic(new Uint8Array([0, 1, 2]))).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module**

Create `src/video/validation.ts`:

```ts
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export function isAllowedVideoType(contentType: string): boolean {
	return (ALLOWED_VIDEO_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

/** True when 0 < sizeBytes <= capBytes. */
export function withinSizeCap(sizeBytes: number, capBytes: number): boolean {
	return sizeBytes > 0 && sizeBytes <= capBytes;
}

/**
 * Heuristic magic-byte check on the first bytes of a file:
 * - mp4/mov: ASCII "ftyp" at offset 4
 * - webm/mkv: EBML header 0x1A45DFA3 at offset 0
 */
export function sniffVideoMagic(head: Uint8Array): boolean {
	if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
		return true; // "ftyp"
	}
	if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
		return true; // EBML
	}
	return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/validation.ts tests/validation.test.ts
git commit -m "feat: video content-type, size, and magic-byte validation"
```

---

## Task 6: YouTube OAuth refresh (`src/video/youtube.ts`)

**Files:**
- Create: `src/video/youtube.ts`
- Test: `tests/youtube.test.ts`

**Interfaces:**
- Produces:
  - `type FetchFn = typeof fetch` (injected for tests).
  - `interface YoutubeCreds { clientId: string; clientSecret: string; refreshToken: string }`
  - `getAccessToken(creds: YoutubeCreds, fetchFn: FetchFn): Promise<string>` — POSTs to `https://oauth2.googleapis.com/token`; throws on non-OK or missing `access_token`.

- [ ] **Step 1: Write the failing test**

Create `tests/youtube.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `../src/video/youtube.js` not found.

- [ ] **Step 3: Implement OAuth refresh**

Create `src/video/youtube.ts`:

```ts
export type FetchFn = typeof fetch;

export interface YoutubeCreds {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Exchange a stored refresh token for a short-lived access token. */
export async function getAccessToken(creds: YoutubeCreds, fetchFn: FetchFn): Promise<string> {
	const body = new URLSearchParams({
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		refresh_token: creds.refreshToken,
		grant_type: "refresh_token",
	});
	const res = await fetchFn(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!res.ok) {
		throw new Error(`oauth token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
	}
	const json = (await res.json()) as { access_token?: string };
	if (!json.access_token) throw new Error("oauth response missing access_token");
	return json.access_token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/youtube.ts tests/youtube.test.ts
git commit -m "feat: YouTube OAuth refresh-token exchange"
```

---

## Task 7: YouTube resumable session + chunk push (`src/video/youtube.ts`)

**Files:**
- Modify: `src/video/youtube.ts`
- Test: `tests/youtube.test.ts`

**Interfaces:**
- Consumes: `FetchFn`, `getAccessToken` (Task 6).
- Produces:
  - `interface VideoMeta { title: string; description: string; privacyStatus: "private" | "unlisted" | "public" }`
  - `startResumableSession(accessToken, meta, totalBytes, contentType, fetchFn): Promise<string>` — returns the resumable session URI (the `Location` header); throws if absent.
  - `type ChunkResult = { status: "incomplete"; bytesReceived: number } | { status: "complete"; videoId: string }`
  - `pushChunk(sessionUri, chunk, range, totalBytes, fetchFn): Promise<ChunkResult>` where `range = { start: number; end: number }` (inclusive `end`).

- [ ] **Step 1: Write the failing tests** (append to `tests/youtube.test.ts`)

```ts
import { startResumableSession, pushChunk } from "../src/video/youtube.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `startResumableSession`/`pushChunk` not exported.

- [ ] **Step 3: Implement resumable upload**

Append to `src/video/youtube.ts`:

```ts
import { contentRangeHeader } from "./chunking.js";

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
	});
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
	const res = await fetchFn(sessionUri, {
		method: "PUT",
		headers: {
			"Content-Length": String(chunk.byteLength),
			"Content-Range": contentRangeHeader(range.start, range.end, totalBytes),
		},
		body: chunk,
	});
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (all youtube tests).

- [ ] **Step 5: Commit**

```bash
git add src/video/youtube.ts tests/youtube.test.ts
git commit -m "feat: YouTube resumable session and chunk upload"
```

---

## Task 8: R2 multipart helpers (`src/video/r2.ts`)

**Files:**
- Create: `src/video/r2.ts`
- Create: `src/video/types.ts`

**Interfaces:**
- Produces (in `src/video/r2.ts`):
  - `interface R2MultipartBinding` — minimal subset of the `MEDIA` binding used here:
    - `createMultipartUpload(key): Promise<{ uploadId: string }>`
    - `resumeMultipartUpload(key, uploadId): { uploadPart(n, bytes): Promise<{ partNumber: number; etag: string }>; complete(parts): Promise<unknown>; abort(): Promise<void> }`
    - `get(key, opts?: { range?: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>`
    - `delete(key): Promise<void>`
    - `list(opts?): Promise<{ objects: { key: string }[] }>` (for cleanup; optional use)
  - `videoKey(submissionId, ext): string` → `"shoebox-video/<submissionId><ext>"`.
- Produces (in `src/video/types.ts`):
  - `interface VideoUpload { r2Key: string; uploadId?: string; sizeBytes: number; contentType: string; originalFilename: string; parts: { partNumber: number; etag: string }[] }`
  - `interface YoutubeTransfer { state: import("./state.js").VideoState; videoId?: string; resumableUri?: string; bytesSent: number; error?: string; attempts: number }`

These are type/constant modules — no separate test file (they are exercised by Task 9's route tests and Task 12). Verify via typecheck.

- [ ] **Step 1: Create the shared types**

Create `src/video/types.ts`:

```ts
import type { VideoState } from "./state.js";

export interface VideoUpload {
	r2Key: string;
	uploadId?: string;
	sizeBytes: number;
	contentType: string;
	originalFilename: string;
	parts: { partNumber: number; etag: string }[];
}

export interface YoutubeTransfer {
	state: VideoState;
	videoId?: string;
	resumableUri?: string;
	bytesSent: number;
	error?: string;
	attempts: number;
}
```

- [ ] **Step 2: Create the R2 helper module**

Create `src/video/r2.ts`:

```ts
export interface R2PartHandle {
	uploadPart(
		partNumber: number,
		value: ArrayBuffer | ArrayBufferView | Uint8Array,
	): Promise<{ partNumber: number; etag: string }>;
	complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
	abort(): Promise<void>;
}

export interface R2MultipartBinding {
	createMultipartUpload(key: string): Promise<{ uploadId: string }>;
	resumeMultipartUpload(key: string, uploadId: string): R2PartHandle;
	get(
		key: string,
		opts?: { range?: { offset: number; length: number } },
	): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	delete(key: string): Promise<void>;
}

const VIDEO_PREFIX = "shoebox-video/";

export function videoKey(submissionId: string, ext: string): string {
	return `${VIDEO_PREFIX}${submissionId}${ext}`;
}

/** Read a byte range from R2 as a Uint8Array (for the resumable YouTube push). */
export async function readRange(
	bucket: R2MultipartBinding,
	key: string,
	offset: number,
	length: number,
): Promise<Uint8Array> {
	const obj = await bucket.get(key, { range: { offset, length } });
	if (!obj) throw new Error(`R2 object not found: ${key}`);
	return new Uint8Array(await obj.arrayBuffer());
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors from `src/video/r2.ts` or `src/video/types.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/video/r2.ts src/video/types.ts
git commit -m "feat: R2 multipart binding types and range reader"
```

---

## Task 9: Settings + types for video (`src/types.ts`)

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `VideoUpload`, `YoutubeTransfer` (Task 8).
- Produces: extended `SubmissionRecord` (`video?`, `youtube?`), extended `PluginSettings` + `DEFAULT_SETTINGS` (`maxVideoSizeMb`, `youtubeEnabled`, `youtubeChannelTitlePrefix`, `youtubeDailyCap`, `youtubePublicPlaceholder`).

- [ ] **Step 1: Extend `SubmissionRecord`**

In `src/types.ts`, add an import at the top and two optional fields to `SubmissionRecord` (after `photos?`):

```ts
import type { VideoUpload, YoutubeTransfer } from "./video/types.js";
```

```ts
	video?: VideoUpload;
	youtube?: YoutubeTransfer;
```

- [ ] **Step 2: Extend `PluginSettings`**

Add to the `PluginSettings` interface:

```ts
	maxVideoSizeMb: number;
	youtubeEnabled: boolean;
	youtubeTitlePrefix: string;
	youtubeDailyCap: number;
	youtubePublicPlaceholder: boolean;
```

- [ ] **Step 3: Extend `DEFAULT_SETTINGS`**

Add to `DEFAULT_SETTINGS`:

```ts
	maxVideoSizeMb: 1024,
	youtubeEnabled: false,
	youtubeTitlePrefix: "From the Shoebox",
	youtubeDailyCap: 5,
	youtubePublicPlaceholder: false,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: video and YouTube fields on submission record and settings"
```

---

## Task 10: Video upload routes (`src/sandbox-entry.ts`)

**Files:**
- Modify: `src/sandbox-entry.ts`

**Interfaces:**
- Consumes: `R2_PART_SIZE`/`partCount` (Task 2), `isAllowedVideoType`/`withinSizeCap`/`sniffVideoMagic` (Task 5), `videoKey`/`R2MultipartBinding` (Task 8), `VideoUpload` (Task 8), existing `verifySessionToken`, `getSettings`, `getIP`, `validateOrigin`, `checkSubmissionRateLimit`, `getMediaBucket`.
- Produces: routes `video/init`, `video/part`, `video/complete`, `video/abort`; a `getMediaMultipart()` helper returning the binding typed as `R2MultipartBinding`.

This task wires the public upload path. Each route mirrors the existing photo routes' gating (origin check, session token, rate limit). The browser uploads binary chunks via `PUT` with raw bytes (`ctx.request.arrayBuffer()`), keeping each chunk under the Worker body limit.

- [ ] **Step 1: Add imports and the multipart binding helper**

At the top of `src/sandbox-entry.ts`, add imports:

```ts
import { R2_PART_SIZE, partCount } from "./video/chunking.js";
import { isAllowedVideoType, withinSizeCap, sniffVideoMagic } from "./video/validation.js";
import { videoKey } from "./video/r2.js";
import type { R2MultipartBinding } from "./video/r2.js";
import type { VideoUpload } from "./video/types.js";
```

After `getMediaBucket()`, add:

```ts
async function getMediaMultipart(): Promise<R2MultipartBinding | null> {
	const bucket = await getMediaBucket();
	return (bucket as unknown as R2MultipartBinding | null) ?? null;
}

const VIDEO_EXT_BY_TYPE: Record<string, string> = {
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
};
```

- [ ] **Step 2: Add the `video/init` route**

Inside the `routes: { ... }` object, after `chat/removePhoto`, add:

```ts
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
```

- [ ] **Step 3: Add the `video/part` route (binary body)**

After `video/init`, add:

```ts
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
```

- [ ] **Step 4: Add `video/complete` and `video/abort` routes**

After `video/part`, add:

```ts
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
```

- [ ] **Step 5: Extend `CollectedData` for the in-flight upload**

In `src/types.ts`, add to `CollectedData`:

```ts
	videoUpload?: import("./video/types.js").VideoUpload;
	videoSubmissionId?: string;
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/sandbox-entry.ts src/types.ts
git commit -m "feat: chunked video upload routes (init/part/complete/abort)"
```

---

## Task 11: Carry video into submission + approve sets pending_upload

**Files:**
- Modify: `src/sandbox-entry.ts`

**Interfaces:**
- Consumes: `VideoUpload`/`YoutubeTransfer` (Task 8), the `video/*` routes (Task 10).
- Produces: `form/submit` persists a `video` + `youtube:{state:"staged"}` on the submission record when a completed upload exists; `submissions/approve` transitions `youtube.state` to `pending_upload`.

- [ ] **Step 1: Persist the video on submit**

In the `form/submit` handler, where the submission record is written via `ctx.storage.submissions.put(submissionId, { ... } satisfies SubmissionRecord)`, add these two fields to the object (using the completed upload stashed on the session). Just before the `put`, compute:

```ts
						const completedVideo = session.collected.videoUpload && !session.collected.videoUpload.uploadId
							? session.collected.videoUpload
							: undefined;
```

Then add to the record literal:

```ts
							video: completedVideo,
							youtube: completedVideo ? { state: "staged", bytesSent: 0, attempts: 0 } : undefined,
```

Also include `"video"` in the `content_types` taxonomy when a video is present — change the `content_types` line to:

```ts
							content_types: [
								...((session.collected.photos?.length ?? 0) > 0 ? ["photo"] : []),
								...(completedVideo ? ["video"] : []),
								"story",
							],
```

- [ ] **Step 2: Approve transitions to pending_upload**

In the `submissions/approve` handler, after building `updated`, add (before the `ctx.storage.submissions.put`):

```ts
						if (updated.video && updated.youtube && updated.youtube.state === "staged") {
							updated.youtube = { ...updated.youtube, state: "pending_upload" };
						}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/sandbox-entry.ts
git commit -m "feat: persist video on submit and queue transfer on approval"
```

---

## Task 12: Cron transfer hook + install scheduling

**Files:**
- Modify: `src/sandbox-entry.ts`

**Interfaces:**
- Consumes: `getAccessToken`/`startResumableSession`/`pushChunk`/`VideoMeta` (Tasks 6–7), `nextYoutubeChunk` (Task 2), `readRange`/`R2MultipartBinding` (Task 8), `hasQuota`/`incrementUsed` (Task 4), `assertTransition` (Task 3), `getSettings`.
- Produces: a `cron` hook handler that advances one transfer per tick; install hook schedules a recurring task; new `allowedHosts`; new `settingsSchema` entries.

The cron hook is **single-flight per plugin**. Each tick: enforce quota, pick the oldest `pending_upload`/`uploading` submission, ensure a resumable session, push **one** chunk (a few MB), persist progress, and on completion write the YouTube id to the content entry. Because each tick moves one chunk, a large file completes across many ticks without a long-lived request.

- [ ] **Step 1: Add imports and a per-tick budget constant**

Add to the imports in `src/sandbox-entry.ts`:

```ts
import { nextYoutubeChunk } from "./video/chunking.js";
import { readRange } from "./video/r2.js";
import { getAccessToken, startResumableSession, pushChunk } from "./video/youtube.js";
import type { VideoMeta } from "./video/youtube.js";
import { hasQuota, incrementUsed } from "./video/quota.js";
import { assertTransition } from "./video/state.js";
import type { YoutubeTransfer } from "./video/types.js";
```

Near the top-level constants, add:

```ts
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
```

- [ ] **Step 2: Add the transfer helper (module-level)**

Before `export function createPlugin()`, add a helper that advances a single submission's transfer by one chunk:

```ts
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
		await incrementUsed(ctx.kv, new Date().toISOString().slice(0, 10));
		assertTransition("uploading", "uploaded");
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
```

- [ ] **Step 3: Add the `cron` hook to the `hooks` object**

Inside `hooks: { ... }`, add:

```ts
				cron: {
					errorPolicy: "continue",
					handler: async (event: unknown, ctx: PluginContext) => {
						const name = (event as { name?: string }).name;
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
```

- [ ] **Step 4: Schedule the recurring task in the install hook**

In the `"plugin:install"` handler, after the existing `ctx.kv.set` calls and before the final `ctx.log.info`, add:

```ts
						await ctx.kv.set("settings:youtubeEnabled", false);
						await ctx.kv.set("settings:maxVideoSizeMb", 1024);
						await ctx.kv.set("settings:youtubeDailyCap", 5);
						await ctx.kv.set("settings:youtubeTitlePrefix", "From the Shoebox");
						await ctx.kv.set("settings:youtubePublicPlaceholder", false);
						if (ctx.cron) {
							// Every 10 minutes.
							await ctx.cron.schedule("video-transfer", { schedule: "*/10 * * * *" });
						}
```

- [ ] **Step 5: Add new `allowedHosts` and `settingsSchema` entries**

Change `allowedHosts` (in both `sandbox-entry.ts` `definePlugin` and keep `index.ts` in sync in Task 14):

```ts
			allowedHosts: ["api.brevo.com", "oauth2.googleapis.com", "www.googleapis.com", "upload.googleapis.com"],
```

Add to `settingsSchema`:

```ts
					youtubeEnabled: { type: "boolean", label: "Enable Video → YouTube", default: false },
					maxVideoSizeMb: { type: "number", label: "Max Video Size (MB)", default: 1024, min: 10, max: 4096 },
					youtubeDailyCap: { type: "number", label: "Max YouTube Uploads per Day", default: 5, min: 1, max: 50 },
					youtubeTitlePrefix: { type: "string", label: "YouTube Title Prefix", default: "From the Shoebox" },
					youtubePublicPlaceholder: { type: "boolean", label: "Show pre-audit video placeholder publicly", default: false },
```

Update `settings/get` and `settings/update` routes to read/write the five new keys, following the existing pattern (numbers via `Number(...)`, booleans/strings via `save(...)`).

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (`ctx.content.update` with `youtube_video_id` requires that field on the `community_submissions` collection — see Task 16 integration note; the call is defensively wrapped in try/catch.)

- [ ] **Step 7: Commit**

```bash
git add src/sandbox-entry.ts
git commit -m "feat: cron-driven resumable R2→YouTube transfer with quota and retry"
```

---

## Task 13: Cleanup cron (stale multipart + transferred objects)

**Files:**
- Modify: `src/sandbox-entry.ts`

**Interfaces:**
- Consumes: `getMediaMultipart`, `advanceTransfer` neighbors; `ctx.storage.submissions`.
- Produces: a second scheduled task `video-cleanup` handled in the same `cron` hook; deletes R2 objects for `uploaded` submissions and rejects' leftovers.

- [ ] **Step 1: Handle the cleanup task name in the `cron` hook**

In the `cron` hook handler, before the `video-transfer` block, add a branch:

```ts
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
```

(Reject cleanup of an unfinished multipart is already handled at `submissions/reject`; extend that route to abort an in-flight upload — Step 2.)

- [ ] **Step 2: Abort multipart on reject**

In the `submissions/reject` handler, after the photo cleanup `Promise.all(...)`, add:

```ts
						if (submission.video?.uploadId) {
							const bucket = await getMediaMultipart();
							if (bucket) {
								try { await bucket.resumeMultipartUpload(submission.video.r2Key, submission.video.uploadId).abort(); } catch { /* best effort */ }
							}
						} else if (submission.video?.r2Key) {
							await deletePhotoFromR2(submission.video.r2Key);
						}
```

- [ ] **Step 3: Schedule the cleanup task on install**

In the `"plugin:install"` handler `if (ctx.cron)` block, add a second schedule:

```ts
							await ctx.cron.schedule("video-cleanup", { schedule: "0 * * * *" }); // hourly
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox-entry.ts
git commit -m "feat: cleanup cron for staged R2 objects and aborted uploads"
```

---

## Task 14: Sync plugin descriptor (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `index.ts` `allowedHosts` mirrors `sandbox-entry.ts`. (Capabilities unchanged — cron needs none.)

- [ ] **Step 1: Update `allowedHosts` in the descriptor**

In `src/index.ts`, change `allowedHosts`:

```ts
			allowedHosts: ["api.brevo.com", "oauth2.googleapis.com", "www.googleapis.com", "upload.googleapis.com"],
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "chore: sync plugin descriptor allowedHosts with sandbox entry"
```

---

## Task 15: OAuth consent script + README docs

**Files:**
- Create: `scripts/youtube-consent.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces: a runnable Node script that performs the installed-app OAuth flow and prints a refresh token; README section documenting setup, secrets, and the manual e2e test.

- [ ] **Step 1: Write the consent script**

Create `scripts/youtube-consent.mjs`:

```js
#!/usr/bin/env node
// One-time helper: mint a YouTube refresh token for the EBT channel.
// Usage: YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... node scripts/youtube-consent.mjs
// Uses the OAuth "out-of-band"/loopback flow. Requires a Desktop-app OAuth client.

import http from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
	console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first.");
	process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}`;
const scope = "https://www.googleapis.com/auth/youtube.upload";
const authUrl =
	`https://accounts.google.com/o/oauth2/v2/auth?response_type=code` +
	`&client_id=${encodeURIComponent(clientId)}` +
	`&redirect_uri=${encodeURIComponent(redirectUri)}` +
	`&scope=${encodeURIComponent(scope)}` +
	`&access_type=offline&prompt=consent`;

const server = http.createServer(async (req, res) => {
	const code = new URL(req.url, redirectUri).searchParams.get("code");
	if (!code) {
		res.writeHead(400).end("No code");
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Done. You can close this tab.</p>");
	server.close();
	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}).toString(),
	});
	const json = await tokenRes.json();
	if (!json.refresh_token) {
		console.error("No refresh_token returned. Revoke prior access and retry with prompt=consent.", json);
		process.exit(1);
	}
	console.log("\nRefresh token:\n" + json.refresh_token + "\n");
	console.log("Store it as a Worker secret:\n  wrangler secret put YOUTUBE_REFRESH_TOKEN");
	process.exit(0);
});

server.listen(PORT, () => {
	console.log("Opening browser for consent…\n" + authUrl);
	const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
	exec(`${cmd} "${authUrl}"`);
});
```

- [ ] **Step 2: Document setup in README**

Append to `README.md`:

```markdown
## Video → YouTube hosting

Large community videos upload to R2 in chunks and, on admin approval, transfer
automatically to the EBT YouTube channel.

### One-time setup

1. In Google Cloud Console, create an OAuth **Desktop app** client for a project
   that has the **YouTube Data API v3** enabled.
2. Mint a refresh token (run locally):
   ```bash
   YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... node scripts/youtube-consent.mjs
   ```
3. Store all three as Worker secrets:
   ```bash
   wrangler secret put YOUTUBE_CLIENT_ID
   wrangler secret put YOUTUBE_CLIENT_SECRET
   wrangler secret put YOUTUBE_REFRESH_TOKEN
   ```
4. In **Shoebox Settings**, toggle **Enable Video → YouTube** on.

### Behaviour & limits

- Videos are created **private** and stay private until Google's API audit
  clears for the project (platform-enforced for unverified apps).
- Default size cap: **1 GB**. Daily upload cap defaults to **5** (YouTube quota).
- Transfer runs every ~10 minutes via the plugin cron, advancing one chunk per
  tick (resumable), so large files complete over several ticks.

### Manual end-to-end test

With secrets set and the feature enabled, submit a short (<50 MB) MP4 through the
public widget, approve it in **Review Submissions**, then watch the submission's
`youtube.state` progress to `uploaded` and a private video appear on the channel.
Delete the test video afterwards.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/youtube-consent.mjs README.md
git commit -m "docs: YouTube OAuth consent script and setup guide"
```

---

## Task 16: Collection field, version bump, changeset, final verification

**Files:**
- Modify: `package.json`, `src/index.ts`, `src/sandbox-entry.ts` (version strings)
- Create: `.changeset/shoebox-video-youtube.md` (if the repo uses changesets — check first)

**Interfaces:**
- Produces: a released-ready plugin at the next minor version; an integration note for the site-side schema + embed.

- [ ] **Step 1: Add the `youtube_video_id` field to the content collection (integration note + action)**

The cron writes `youtube_video_id` onto `community_submissions`. Add this field to the EBT **site** seed (`seed/seed.json` in the site repo, collection `community_submissions`) as an optional string field, and regenerate types (`npx emdash types`). **This is a site-repo change, not a plugin-repo change** — record it here and perform it in the site repo:

```
community_submissions.fields += { name: "youtube_video_id", type: "string", required: false }
```

Public rendering of the embed (post-audit) belongs in the site template
`src/pages/from-the-shoebox/[id].astro`:

```astro
{entry.data.youtube_video_id && (
  <iframe
    width="560" height="315"
    src={`https://www.youtube-nocookie.com/embed/${entry.data.youtube_video_id}`}
    title="Video" frameborder="0" allowfullscreen loading="lazy"
  />
)}
```

- [ ] **Step 2: Bump the plugin version**

Change `version` from `1.1.0` to `1.2.0` in `package.json`, `src/index.ts` (descriptor + `entrypoint` stays), and `src/sandbox-entry.ts` (`definePlugin` `version`).

- [ ] **Step 3: Add a changeset (if used)**

Run: `ls .changeset 2>/dev/null` — if the directory exists, create `.changeset/shoebox-video-youtube.md`:

```markdown
---
"emdash-plugin-shoebox": minor
---

Adds large-video uploads to the Shoebox submission flow with automatic hosting on the Every Bit Texas YouTube channel. Community members can now attach an MP4, MOV, or WebM video (up to 1 GB); once an admin approves the submission, the video transfers to YouTube automatically in the background and the published story embeds the player. Videos start private until the channel's API access is verified.
```

If `.changeset` does not exist, skip this step.

- [ ] **Step 4: Full verification**

Run all of:

```bash
pnpm test
pnpm exec tsc --noEmit
```

Expected: all tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: bump shoebox plugin to 1.2.0 for video→YouTube feature"
```

---

## Self-Review

**Spec coverage:**
- B1 Data model → Tasks 3 (state), 8 (record types), 9 (settings/record fields), 11 (persist). *Refinement: operational state in plugin storage, not collection — flagged above.*
- B2 Upload path → Tasks 2 (chunk math), 8 (R2 helpers), 10 (init/part/complete/abort routes), gated by Turnstile/HMAC reuse (origin + session token + rate limit in each route).
- B3 Approval→cron transfer → Tasks 6–7 (YouTube client), 12 (cron hook, OAuth refresh, resumable across ticks, quota, allowedHosts, native `globalThis.fetch`).
- B4 Visibility → Task 12 (forced `private`), settings `youtubePublicPlaceholder` (Task 9/12), Task 16 (youtube-nocookie embed, site-side).
- B5 OAuth/secrets → Task 15 (consent script), Task 12 (Worker-env secret reads), Task 9/12 (settings).
- B6 Abuse controls → Task 5 (size/type/magic), Task 10 (rate limit + caps at init), Task 13 (cleanup + abort).
- B7 Testing → Tasks 2–7 unit tests; Task 15 documents the real e2e manual test against the EBT channel.

**Placeholder scan:** No TBD/TODO; all code steps carry complete code.

**Type consistency:** `VideoUpload`/`YoutubeTransfer` defined in Task 8, consumed in 9/10/11/12; `VideoState` from Task 3 used in `YoutubeTransfer`; `nextYoutubeChunk`/`pushChunk` range contracts (inclusive `end`) consistent across Tasks 2, 7, 12; `getMediaMultipart`/`R2MultipartBinding` defined in Task 10/8 and reused in 12/13.

**Known cross-repo dependency:** `youtube_video_id` collection field + embed rendering live in the EBT **site** repo (Task 16 Step 1) — the plugin writes the field defensively (try/catch) so it is safe to deploy the plugin before the site field exists.
