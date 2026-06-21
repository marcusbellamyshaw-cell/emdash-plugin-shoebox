# emdash-plugin-shoebox

A community photo and story submission plugin for [Emdash CMS](https://emdashcms.com). Powers the "From the Shoebox" feature on [Every Bit Texas](https://everybittexas.com) — a public submission form where visitors share old Texas photos and family memories. Submissions land in the Emdash admin as draft posts for editorial review, with one-click approve/reject and automatic email notifications via Brevo.

## What it does

- Public submission form with photo upload (up to 5 photos, 10 MB each — JPG, PNG, WebP)
- Structured draft posts saved to a **Community Submission** content type in Emdash, reviewable in the admin
- **One-click approve** → publishes the post; the confirmation email is sent to the submitter when you click Publish in Emdash
- **Reject** → marks the submission rejected and removes its photos (no email is sent to the submitter; the optional reason is internal context for the team)
- Category tagging from submitter checkbox selections
- Brevo integration: optional newsletter signup collected at submission time
- Session tokens with HMAC signing; per-IP rate limiting on submissions
- Submission funnel analytics stored in D1 (widget opened / completed)
- Admin dashboard widget showing submission counts
- All API keys and settings stored in Cloudflare KV — nothing hardcoded

## Installation

```sh
pnpm add ebt-plugin-shoebox
```

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash";
import { shoeboxPlugin } from "ebt-plugin-shoebox";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [shoeboxPlugin()],
    }),
  ],
});
```

## Configuration

Configure via the **Shoebox Settings** page in the Emdash admin panel. All values are stored in Cloudflare KV.

| Setting | Description |
|---|---|
| Plugin enabled toggle | Disable the form without removing the plugin |
| Brevo API key | For the approval confirmation email and newsletter signup |
| Newsletter signup toggle | Show or hide the newsletter question |
| Brevo newsletter list ID (default 3) | Which Brevo list newsletter opt-ins are added to |
| Max file size (default 10 MB) | Per photo limit |
| Max photos per submission (default 5) | |
| Max submissions per IP per 24 h (default 3) | |
| Max story word count (default 2,000) | |

> Photos are stored via the bound `MEDIA` R2 binding (no R2 keys to configure), and the confirmation email sender is currently `Every Bit Texas <hello@everybittexas.com>`.

## Admin routes

| Route | Description |
|---|---|
| `POST /submissions/approve` | Marks the submission approved (the confirmation email is sent on Publish) |
| `POST /submissions/reject` | Marks the submission rejected and deletes its photos (no email sent) |
| `GET /submissions/list` | Lists pending submissions for the review queue |
| `GET /settings/get` / `POST /settings/update` | Read and update plugin settings |

## Public routes (sandboxed Worker)

| Route | Description |
|---|---|
| `POST /form/init` | Issues a signed session token |
| `POST /form/submit` | Validates session, saves draft, sends confirmation email |
| `POST /chat/upload` | Uploads a photo to R2 and returns the media ID |
| `POST /chat/removePhoto` | Removes a previously uploaded photo |

## Requirements

- Emdash `^0.16.0`
- Cloudflare R2 (photos), D1 (submissions/analytics), KV (sessions/settings)
- Brevo account (transactional email and newsletter)

## About

Community photo and story submission plugin for EmDash CMS. Designed by Marcus Shaw for [Every Bit Texas](https://everybittexas.com). Coded by [Claude Code](https://claude.ai/code).

Built for [EmDash CMS](https://github.com/emdash-cms/emdash) — star the repo to support open-source CMS development.

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

#### Abandoned uploads (R2 lifecycle)

The Cloudflare R2 Workers binding has no `listMultipartUploads` method, so the
plugin cannot enumerate and abort incomplete uploads in code. Instead, configure
a **bucket-level R2 lifecycle rule** to auto-abort them:

> **Cloudflare dashboard → R2 → your media bucket → Settings → Object lifecycle
> rules → Add rule → "Abort incomplete multipart uploads after N days"** — set
> N to **7**.

This only affects multipart uploads that were started but never completed or
aborted (e.g. a user who began a video upload and closed the tab). It has no
effect on completed objects. The rule reclaims storage automatically without any
code changes.

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

## License

MIT
