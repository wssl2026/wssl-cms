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

- **`public/admin/config.yml`** — `backend.repo: OWNER/REPO` must name the real GitHub repository, and `backend.base_url` must be the deployed site origin (e.g. `https://www.wssl.org`). Until both are right, editors cannot sign in to `/admin`.
- **`wrangler.toml`** — the `USAGE` KV namespace `id` and `preview_id` are zeros. Create them with `npx wrangler kv namespace create USAGE` (and `--preview`) and paste the ids in.
- **Cloudflare Pages secrets** (Settings → Environment variables, encrypted):
  - `ANTHROPIC_API_KEY` — the Ask WSSL assistant.
  - `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — the GitHub OAuth app used by `/admin`. Its callback URL must be `https://<site>/api/callback`.
- **`DAILY_CAP`** (plain var, default `200`) — the number of Ask WSSL questions answered per UTC day before the widget answers "reached its daily limit". Raise or lower it after watching the first week; see Cost below.
- **`docs/runbook.md`** — operations runbook, written in Task 12 at deploy time. It does not exist yet.

## Cost

Ask WSSL sends the whole site to the model on every question: ~90K tokens of corpus and system prompt (`npm run corpus` builds it, `npx tsx scripts/count-corpus-tokens.ts` measures it against the API). Claude Opus 5 costs $5 per million input tokens, so:

- **Cold question** (nothing cached — first question of the hour, or after any content change): the corpus is written to the 1-hour cache at 2× the base rate, so ≈ 90K × $5 × 2 / 1M ≈ **$0.90**, plus a few cents of output.
- **Warm question** (cache hit): cached input reads cost 10% of the base rate, so ≈ 90K × $5 × 0.1 / 1M ≈ **$0.05**.

At `DAILY_CAP = 200` the realistic day — a handful of cold cache writes plus warm reads — lands near **$10–15**; the absolute worst case, if every question missed the cache, is about $180. Watch the `usage` line the chat function logs (`cache_read_input_tokens` should dominate) before raising the cap. A publish invalidates the cache, so the first question after each content edit is a cold one.
