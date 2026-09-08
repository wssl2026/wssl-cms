# wssl-cms
Source for https://www.wssl.org — Astro static site, content in `src/content/pages`, edited via Decap CMS at `/admin`, hosted on Cloudflare Pages. See `docs/editors.md` (editing) and `docs/runbook.md` (operations, created at deploy time).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server |
| `npm run build` | Rebuild the Ask WSSL corpus, then `astro build` into `dist/` |
| `npm test` | Vitest suite |
| `npm run migrate` | Re-import every page from the old Mura site (~5 min, network) |
| `npm run check-links` | Check `dist/` for broken internal links and dead `#fragments` |

## Before this goes live

Everything below is a placeholder in the repo and must be filled in by whoever deploys the site:

- **Cloudflare Access** — editors sign in to `/admin` with their email address and a one-time code, and never need a GitHub account. In Zero Trust → Access → Applications → **Add an application → Self-hosted**:
  - Domain `www.wssl.org`, paths `/admin` and `/api/cms` (one application with both paths, or two applications — either way both must be covered, or the editor API is open).
  - Policy: **Allow**, with `Emails` listing each editor, or `Emails ending in` `@wssl.org`.
  - Identity provider: **One-time PIN**.
  - Copy the application's **Application Audience (AUD) tag** into `CF_ACCESS_AUD` in `wrangler.toml`, and the team domain (Zero Trust → Settings → Custom Pages, e.g. `wssl.cloudflareaccess.com`) into `CF_ACCESS_TEAM_DOMAIN`.
- **GitHub bot token** — create a **fine-grained personal access token** (Repository access: *only* the content repository; Repository permissions: **Contents: read and write**, **Metadata: read-only**) and store it as the `GITHUB_BOT_TOKEN` Pages secret. Every edit is committed by this token, with the signed-in editor recorded as the commit's author.
- **`wrangler.toml`** — set `GITHUB_REPO` to the real `owner/repo` and `GITHUB_BRANCH` to the branch Pages builds from. The `USAGE` KV namespace `id` and `preview_id` are zeros; create them with `npx wrangler kv namespace create USAGE` (and `--preview`) and paste the ids in.
- **`public/admin/config.yml`** — `backend.repo: OWNER/REPO` must name the real GitHub repository. It is only the fallback Decap declares before it detects the `/api/cms/v1` proxy, but it must still be right.
- **Cloudflare Pages secrets** (Settings → Environment variables, encrypted):
  - `ANTHROPIC_API_KEY` — the Ask WSSL assistant.
  - `GITHUB_BOT_TOKEN` — the fine-grained PAT above.
- **`DAILY_CAP`** (plain var, default `200`) — the number of Ask WSSL questions answered per UTC day before the widget answers "reached its daily limit". Raise or lower it after watching the first week; see Cost below.
- **`docs/runbook.md`** — operations runbook, written in Task 12 at deploy time. It does not exist yet.

## How `/admin` signs editors in

Cloudflare Access protects `/admin` and `/api/cms`, so an editor proves who they are with a one-time code sent to their email. Access then injects a signed `Cf-Access-Jwt-Assertion` header into every request it forwards. Decap CMS talks to `functions/api/cms/v1.ts` (its "proxy backend" protocol), which verifies that header against the team's public keys, checks it was minted for our Access application, and only then commits through the `GITHUB_BOT_TOKEN`. The bot is the *committer* of every commit; the editor's email is the *author*, so `git log` still shows who changed what. Editors may only read and write under `src/content/pages/`, `src/data/` and `public/uploads/` — anything else is refused.

Locally, `/admin` still expects `npx decap-server` on port 8081 and commits to your working copy. To exercise the deployed path instead, run `npx wrangler pages dev dist` with `GITHUB_BOT_TOKEN` in `.dev.vars` and `CF_ACCESS_AUD` unset; `/api/cms/v1` then accepts unauthenticated requests from `localhost` only, committing as `Local editor <local@wssl.org>`.

## Cost

Ask WSSL sends the whole site to the model on every question: ~90K tokens of corpus and system prompt (`npm run corpus` builds it, `npx tsx scripts/count-corpus-tokens.ts` measures it against the API). Claude Opus 5 costs $5 per million input tokens, so:

- **Cold question** (nothing cached — first question of the hour, or after any content change): the corpus is written to the 1-hour cache at 2× the base rate, so ≈ 90K × $5 × 2 / 1M ≈ **$0.90**, plus a few cents of output.
- **Warm question** (cache hit): cached input reads cost 10% of the base rate, so ≈ 90K × $5 × 0.1 / 1M ≈ **$0.05**.

At `DAILY_CAP = 200` the realistic day — a handful of cold cache writes plus warm reads — lands near **$10–15**; the absolute worst case, if every question missed the cache, is about $180. Watch the `usage` line the chat function logs (`cache_read_input_tokens` should dominate) before raising the cap. A publish invalidates the cache, so the first question after each content edit is a cold one.
