# ebt-plugin-shoebox

An AI-powered community submission plugin for [Emdash CMS](https://emdashcms.com). Powers the "From the Shoebox" feature on [Every Bit Texas](https://everybittexas.com) — a guided submission form that collects old Texas photos and family stories from the public, stores them as draft posts for editorial review, and handles consent, email confirmation, and newsletter signup.

## What it does

- Public submission form with photo upload (up to 5 photos, 10 MB each — JPG, PNG, WebP)
- Structured draft posts saved to a **Community Submission** content type in Emdash, reviewable in the admin
- **One-click approve** → publishes the post and emails the submitter
- **Rejection email** → sends a warm rejection from a configurable template
- Automated taxonomy extraction: categories, tags, region, era inferred from the submission text
- Brevo integration: optional newsletter signup collected during submission
- Session tokens with HMAC signing; rate limiting (per-IP submissions and turns)
- Submission funnel analytics stored in D1 (widget opened / started / completed)
- Admin dashboard widget showing submission stats

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

All settings are stored in Cloudflare KV — no hardcoded API keys anywhere in the codebase. Configure via the **Shoebox Settings** page in the Emdash admin panel:

| Setting | Description |
|---|---|
| Brevo API key | For confirmation and rejection emails |
| Brevo newsletter list ID | For optional newsletter signup |
| Confirmation email sender name / address | Shown on emails sent to submitters |
| Rejection email template | Editable warm rejection copy |
| Cloudflare Turnstile site key + secret | Spam protection on the submission form |
| R2 Access Key ID + Secret Access Key | For photo uploads to R2 (separate R2 API token, not your account token) |
| R2 bucket name + public URL | Where photos are stored |
| Max file size (default 10 MB) | Per photo limit |
| Max photos per submission (default 5) | |
| Max submissions per IP per 24 h (default 3) | |
| Plugin enabled toggle | Disable the form without removing the plugin |
| Newsletter signup toggle | Show or hide the newsletter question |

## Plugin routes (sandboxed Worker)

All public-facing API routes run in an isolated sandboxed Worker (`ebt-plugin-shoebox/sandbox`):

| Route | Description |
|---|---|
| `POST /form/init` | Issues a signed session token |
| `POST /form/submit` | Validates session, saves draft, sends confirmation email |
| `POST /chat/upload` | Uploads a photo to R2 and returns the media ID |
| `POST /chat/removePhoto` | Removes a previously uploaded photo |

Admin routes (trusted Worker, authenticated):

| Route | Description |
|---|---|
| `POST /submissions/approve` | Publishes the draft post and emails the submitter |
| `POST /submissions/reject` | Sends rejection email and marks the submission |
| `GET /submissions/list` | Lists pending submissions for the review queue |
| `GET /settings` / `POST /settings` | Read and update plugin settings |

## Data model

Submissions are saved as draft posts in a **Community Submission** content type. Additional fields stored per submission:

- Submitter name, email, phone (optional)
- Credit preference (named / anonymous)
- Consent and copyright declaration timestamps
- Original unedited story text (alongside any edited version)
- IP address, submission date
- Taxonomy confidence score
- Submission funnel analytics

## Requirements

- Emdash `^0.16.0`
- Cloudflare R2 (photos), D1 (submissions/analytics), KV (sessions/settings)
- Brevo account (for transactional email and newsletter)
- Cloudflare Turnstile (for spam protection)

## License

MIT
