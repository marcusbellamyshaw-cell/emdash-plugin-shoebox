# emdash-plugin-shoebox

A community photo and story submission plugin for [Emdash CMS](https://emdashcms.com). Powers the "From the Shoebox" feature on [Every Bit Texas](https://everybittexas.com) — a public submission form where visitors share old Texas photos and family memories. Submissions land in the Emdash admin as draft posts for editorial review, with one-click approve/reject and automatic email notifications via Brevo.

## What it does

- Public submission form with photo upload (up to 5 photos, 10 MB each — JPG, PNG, WebP)
- Structured draft posts saved to a **Community Submission** content type in Emdash, reviewable in the admin
- **One-click approve** → publishes the post and emails the submitter a confirmation
- **Reject** → sends a configurable warm rejection email
- Category tagging from submitter checkbox selections
- Brevo integration: optional newsletter signup collected at submission time
- Session tokens with HMAC signing; per-IP rate limiting (submissions and turns)
- Submission funnel analytics stored in D1 (widget opened / started / completed)
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
| Brevo API key | For confirmation and rejection emails |
| Brevo newsletter list ID | For optional newsletter signup |
| Confirmation email sender name / address | Shown on emails sent to submitters |
| R2 Access Key ID + Secret Access Key | For photo uploads to R2 (separate R2 API token) |
| R2 bucket name + public URL | Where photos are stored |
| Max file size (default 10 MB) | Per photo limit |
| Max photos per submission (default 5) | |
| Max submissions per IP per 24 h (default 3) | |
| Max story word count (default 2,000) | |
| Plugin enabled toggle | Disable the form without removing the plugin |
| Newsletter signup toggle | Show or hide the newsletter question |

## Admin routes

| Route | Description |
|---|---|
| `POST /submissions/approve` | Publishes the draft post and emails the submitter |
| `POST /submissions/reject` | Sends rejection email and marks the submission |
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

## License

MIT
