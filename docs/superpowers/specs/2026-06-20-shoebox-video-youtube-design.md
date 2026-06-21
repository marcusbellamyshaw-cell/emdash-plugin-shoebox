# Shoebox Video Upload → Automatic YouTube Hosting — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan
**Plugin:** `ebt-plugin-shoebox` (`C:\EBT-emdash\emdash-plugin-shoebox`)
**Related upstream fix:** emdash PR #1562 (issue #1313) — `ctx.media.upload()` write-gate. **This design does NOT depend on #1562 merging**; it uses the direct `env.MEDIA` R2 binding workaround already established for Shoebox photos.

---

## 1. Goal & Scope

Let community members submit **large video files** through the public Shoebox submission flow, the same way they already submit photos. On **admin approval**, the video is transferred **automatically to EBT's YouTube channel via the YouTube Data API v3**, and the published Shoebox entry embeds the YouTube player.

In scope:

- Large video upload (browser → R2) that survives the Cloudflare Workers ~100 MB request-body limit.
- Approval-triggered, **cron-driven** transfer from R2 → YouTube using resumable upload.
- Visibility handling that respects YouTube's unverified-project audit gate (videos forced private until Google audit passes).
- OAuth refresh-token storage and one-time consent.
- Abuse controls and cleanup.

Out of scope (deferred / explicitly not built):

- Cloudflare Stream as a hosting backend (decided against — YouTube chosen).
- Client-side transcoding / thumbnail generation.
- Editing/replacing a video after it's been pushed to YouTube.
- Public auto-publish before the Google audit clears (off by default).

---

## 2. Constraints (verified)

- **Cloudflare Workers request body ≈ 100 MB** → uploads must be chunked. We use R2 multipart upload with ~64 MB parts.
- **R2 Worker binding has no presigned URLs** → browser cannot PUT directly to R2; chunks proxy through plugin routes that call `env.MEDIA` (the binding). This is the same workaround Shoebox photos already use.
- **emdash `cron` capability exists** (`ctx.cron` + `cron` hook in core `types.ts`) → used to drive the R2→YouTube transfer out-of-band from the request.
- **Sandbox has no AbortSignal** — never pass `AbortSignal` to `ctx.http.fetch` (DataCloneError). Use `Promise.race` for timeouts. (See `feedback-sandbox-no-abortsignal`.)
- **YouTube unverified-project audit gate** — until Google's API audit passes, `videos.insert` results are **locked to `private`** regardless of requested status; daily upload quota is very low. We design for "private until verified," with a flip to public after audit.
- **YouTube Data API quota** — `videos.insert` costs ~1600 units against a default 10,000/day quota → ~6 uploads/day until quota increase. Enforce a daily cap.

---

## 3. Architecture Overview

```
Browser (submission form)
  │  init / part×N / complete   (Turnstile + HMAC session gated)
  ▼
Plugin routes ──env.MEDIA──► R2 (staged multipart object)
  │
  ▼ creates community_submissions entry  state = "staged"
  │
Admin Queue.tsx ── approve ──► state = "pending_upload"
  │
  ▼ (~10 min cron tick)
cron hook: OAuth refresh → YouTube resumable upload (R2 → YouTube)
           Content-Range across ticks, daily quota in KV
  │
  ▼ state = "uploaded" (videoId stored)  → entry embeds youtube-nocookie player
```

Seven subsystems (B1–B7) below.

---

## B1. Data Model

Extend the existing `community_submissions` collection with two field groups.

**`video` group** (submission-side):

- `r2_key` (string) — staged R2 object key.
- `upload_id` (string) — R2 multipart upload id (cleared on complete/abort).
- `size_bytes` (number).
- `content_type` (string).
- `original_filename` (string).
- `parts` (json) — array of `{ partNumber, etag }` accumulated during upload.

**`youtube` group** (hosting-side):

- `state` (string enum) — state machine below.
- `video_id` (string) — YouTube video id once created.
- `resumable_uri` (string) — YouTube resumable session URI (spans cron ticks).
- `bytes_sent` (number) — resumable upload progress cursor.
- `error` (string) — last failure reason.
- `attempts` (number) — retry counter.

**State machine** (`youtube.state`):

```
staged ─approve─► pending_upload ─cron picks up─► uploading ─done─► uploaded
                       │                              │
                       └──────────── failed ◄─────────┘ (retryable)
```

- `staged` — video bytes complete in R2, awaiting moderation.
- `pending_upload` — admin approved; queued for cron.
- `uploading` — cron actively pushing bytes (resumable in progress).
- `uploaded` — present on YouTube (private until audit).
- `failed` — terminal-until-retry; `error` + `attempts` set.
- `published` — **reserved**, not used in v1 (would mean public post-audit).

A submission may be **photo-only** (no `video` group populated) — video fields are all optional; existing photo flow untouched.

---

## B2. Upload Path (browser → R2)

Four plugin routes, all gated by the existing Turnstile double-verify + HMAC session token:

1. **`POST .../video/init`** — body: filename, contentType, size. Validates against caps (B6), calls `env.MEDIA.createMultipartUpload(key)`, creates the `community_submissions` entry in `state="staged"` with `video.r2_key` + `video.upload_id`, returns `{ submissionId, key, uploadId, partSize }`.
2. **`PUT .../video/part`** — body: raw chunk bytes; query/header: submissionId, partNumber. Proxies to `resumeMultipartUpload(...).uploadPart(partNumber, bytes)`, appends `{ partNumber, etag }` to `video.parts`. Chunk size ~64 MB (under the ~100 MB Worker body limit).
3. **`POST .../video/complete`** — body: submissionId. Calls `.complete(parts)`, clears `upload_id`, finalizes `state="staged"`. (Form's text fields are saved here or at init.)
4. **`POST .../video/abort`** — body: submissionId. Calls `.abort()`, deletes the entry (or marks abandoned). Also invoked by cleanup cron (B6).

Browser orchestrates: init → slice file into part-sized blobs → PUT each (with limited concurrency + retry per part) → complete. Progress bar from parts done / total.

---

## B3. Approval → Cron Transfer (R2 → YouTube)

- **Queue.tsx**: the existing approve action, for entries with a populated `video` group, sets `youtube.state = "pending_upload"` (instead of immediately publishing).
- **`cron` hook (~10 min cadence)**:
  1. Quota check: read today's count from KV; bail if at daily cap.
  2. Select one entry where `state ∈ {pending_upload, uploading}` (oldest first), set `uploading`.
  3. OAuth: exchange stored refresh token for an access token (`oauth2.googleapis.com/token`).
  4. If no `resumable_uri`: start a resumable session (`POST .../upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`) with metadata (title from submission, description, `privacyStatus: "private"`); store `resumable_uri`.
  5. Push the **next byte range** from R2 to the resumable URI with `Content-Range: bytes A-B/total` — bounded per tick so a single tick stays well within sandbox time. Update `bytes_sent`.
  6. On `308 Resume Incomplete`: stay `uploading`, persist cursor, finish next tick.
  7. On `200/201`: store `video.video_id`, set `state="uploaded"`, increment KV quota count, schedule R2 cleanup of the staged object.
  8. On error: increment `attempts`; if retryable and under limit, leave `pending_upload`; else `state="failed"` with `error`.
- **No AbortSignal** anywhere — use `Promise.race([fetch, timeout])`.
- **allowedHosts** (native plugin network allowlist): `oauth2.googleapis.com`, `www.googleapis.com`, `upload.googleapis.com`.

Resumable-across-ticks is the key design choice: large files upload over several cron ticks without holding a long-lived request.

---

## B4. Visibility

- Videos are created **`private`** and **stay private until the Google API audit passes** (platform-enforced for unverified projects; we don't fight it).
- Published Shoebox entry: when `state="uploaded"` but pre-audit, show a **placeholder** ("video processing / pending review"), **off by default** for public display — the entry can publish its text/photo content without exposing a private video.
- Post-audit, embed via **`youtube-nocookie.com`** privacy-enhanced iframe using `video.video_id`.
- A single plugin setting (`youtube.publicPlaceholder`, default `false`) controls whether the pre-audit placeholder renders publicly.

---

## B5. OAuth & Secrets

- **One-time consent**: a small standalone script (run by the EBT admin locally, not in the Worker) performs the OAuth2 consent flow for the EBT YouTube channel and prints a **refresh token**.
- **Storage**: refresh token + client id/secret stored as **Worker secrets** (`wrangler secret put YOUTUBE_REFRESH_TOKEN` etc.), read in the cron hook via the Worker env. Non-secret config (channel id, default privacy, cadence, caps) in **plugin settings**.
- Scope: `https://www.googleapis.com/auth/youtube.upload`.
- Rationale for Worker secrets over plugin settings for the token: secrets aren't exposed in the admin UI and aren't in the content DB.

---

## B6. Abuse Controls

- **Size cap**: default **1 GB** per video (configurable); enforced at `init` (declared size) and defensively at `complete` (sum of parts).
- **Content-type sniff**: validate declared `contentType` is a video MIME; optionally sniff magic bytes of the first part.
- **Per-IP rate limit**: limit submissions/initiations per IP per window (reuse existing Shoebox session/Turnstile signals + a KV counter).
- **Cleanup cron**: a periodic sweep that **aborts incomplete multipart uploads** older than N hours (`env.MEDIA` list + `abort`) and deletes staged R2 objects for entries that were rejected or whose upload was abandoned, plus staged objects already transferred to YouTube.

---

## B7. Testing

- **Unit tests** (vitest): state-machine transitions; daily-quota KV accounting; chunk/part math (file size → part count, ranges, `Content-Range` headers); content-type/size validation.
- **Mocked integration**: YouTube OAuth + resumable endpoints and R2 `env.MEDIA` mocked — exercise init→part→complete and the multi-tick resumable transfer including `308` resume.
- **Real e2e** against the **EBT YouTube channel**: upload a small real video as **private + deletable**, assert it lands, then delete. Gated/manual (uses real quota).

---

## Defaults Summary

| Setting | Default |
|---|---|
| Max video size | 1 GB |
| R2 part size | ~64 MB |
| Cron cadence | ~10 min |
| Daily YouTube upload cap | tracked in KV, set below quota |
| Refresh token storage | Worker secrets |
| Pre-audit public placeholder | off |
| Created video privacy | private (forced until audit) |

---

## Open Items (carry into the plan, not blockers)

- Exact per-tick byte budget for the resumable push (tune to sandbox CPU/time limits).
- Whether form text fields are persisted at `init` or `complete` (lean: `complete`).
- Quota-increase request to Google (parallel track; not code).
