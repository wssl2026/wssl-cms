# wssl-cms
Source for https://www.wssl.org — Astro static site, content in `src/content/pages`, edited via Decap CMS at `/admin`, hosted on Cloudflare Pages. See `docs/editors.md` (editing) and `docs/runbook.md` (operations, created at deploy time).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server |
| `npm run build` | Rebuild the Ask WSSL corpus and page index, then `astro build` into `dist/` |
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
- **`public/admin/config.yml`** — `backend.repo` is `wssl2026/wssl-cms` (the content repository). It is only the fallback Decap declares before it detects the `/api/cms/v1` proxy, but it must still be right.
- **Cloudflare Pages secrets** (Settings → Environment variables, encrypted):
  - `GEMINI_API_KEY` — the Ask WSSL assistant on its default provider (Google AI Studio → Get API key).
  - `ANTHROPIC_API_KEY` — only needed if you switch `LLM_PROVIDER` to `anthropic`.
  - `GITHUB_BOT_TOKEN` — the fine-grained PAT above.
- **Ask WSSL's model** — `LLM_PROVIDER` in `wrangler.toml` is `gemini` (the alternative is `anthropic`; any other value makes the widget answer "temporarily unavailable" and logs `chat_provider_misconfigured`). `GEMINI_MODEL` is `gemini-3.8-flash` and `GEMINI_RETRIEVAL` is `index` (the alternative is `cache`; see "How Ask WSSL answers" and Cost). Confirm the key can actually call that model **once, before launch**: `GEMINI_API_KEY=... npm run check-gemini-model` lists every model the key may use and exits non-zero if `GEMINI_MODEL` is not among them.
- **`DAILY_CAP`** (plain var, default `200`) — the number of Ask WSSL questions answered per UTC day before the widget answers "reached its daily limit". Raise or lower it after watching the first week; see Cost below.
- **`docs/runbook.md`** — operations runbook, written in Task 12 at deploy time. It does not exist yet.

## How `/admin` signs editors in

Cloudflare Access protects `/admin` and `/api/cms`, so an editor proves who they are with a one-time code sent to their email. Access then injects a signed `Cf-Access-Jwt-Assertion` header into every request it forwards. Decap CMS talks to `functions/api/cms/v1.ts` (its "proxy backend" protocol), which verifies that header against the team's public keys, checks it was minted for our Access application, and only then commits through the `GITHUB_BOT_TOKEN`. The bot is the *committer* of every commit; the editor's email is the *author*, so `git log` still shows who changed what. Editors may only read and write under `src/content/pages/`, `src/data/` and `public/uploads/` — anything else is refused.

Locally, `/admin` still expects `npx decap-server` on port 8081 and commits to your working copy. To exercise the deployed path instead, run `npx wrangler pages dev dist` with `GITHUB_BOT_TOKEN` in `.dev.vars` and `CF_ACCESS_AUD` unset; `/api/cms/v1` then accepts unauthenticated requests from `localhost` only, committing as `Local editor <local@wssl.org>`.

## How Ask WSSL answers

`functions/api/chat.ts` owns the guards — same-origin only, history validation, the KV daily cap — and the SSE wire protocol the widget reads (`text`, `citation`, `done`, `error`). Behind them sits a small provider interface (`functions/_lib/providers/types.ts`) with two implementations, chosen by `LLM_PROVIDER`:

- **`gemini`** (`functions/_lib/providers/gemini.ts`) — has two **retrieval modes**, chosen by `GEMINI_RETRIEVAL` in `wrangler.toml`; any value other than `cache` means `index`. Both share client construction, abort handling, error mapping and `served_by`, so the handler and the widget cannot tell them apart. Gemini has no citation API either way, so the shared system prompt already requires inline Markdown links to the pages used; the server parses those links back out of the answer into `citation` events, so sources are never listed twice. If a provider's API key is not configured, `/api/chat` returns the same 503 config-error response as an unknown `LLM_PROVIDER` instead of a raw exception.
  - **`index`** (the default, `gemini-index.ts`) — the model gets a map of the site instead of the site: one line per page (`- title — url — summary [headings]`), about 6K tokens for all 87 pages, built into `functions/_lib/index.json` (git-ignored, rebuilt by `npm run build` beside `corpus.json`). It then calls a `read_pages` tool with the URLs it wants and answers from those pages. The loop is boxed in — at most **2 tool rounds**, **4 pages per call** and **6 pages per question**, so a question is at most three model calls — and it always ends with a streamed answer, so the visitor sees text arriving even when the model never called the tool. A URL that is not in the corpus comes back as `(no such page)` rather than being dropped, and a tool the provider does not offer is ignored with a `gemini_unknown_tool` log line. Sources are the pages actually read, plus any other corpus page the answer links to. One JSON line per question, `chat_index_mode`, carries `rounds`, `pages_read` and the token counts — never page text, the question or the answer. If `index.json` somehow arrives empty the provider logs `gemini_index_missing` and falls back to cache mode rather than answering from an empty map.
  - **`cache`** (`gemini-cache.ts`) — the whole corpus plus the system prompt goes into a Google **explicit context cache** that lives an hour; its name is recorded in the `USAGE` KV namespace under `gemini-cache:<model>:<sha256 of corpus+prompt>`, so every request in that hour reuses it (log line `gemini_cache_hit`). Change any page and the hash changes, so the next question writes a fresh cache instead of answering from stale content. If the cache turns out to be gone the function rebuilds it and retries once; if the model refuses to cache at all — usually the corpus is under the minimum token count — it logs `gemini_cache_unavailable` and sends the corpus inline instead. A response with no exception but nothing usable in it (no cache name) is treated the same way — inline for that one request — without giving up on caching for the isolate.
- **`anthropic`** (`functions/_lib/providers/anthropic.ts`) — unchanged: the corpus as citation-enabled documents with a 1-hour prompt cache, and Claude's own citation deltas.

## Cost

How much a question costs depends on the provider and, on Gemini, on the retrieval mode: index mode sends a small map plus a few pages, cache mode sends the whole site. `npm run corpus` builds both files and prints their sizes; `npx tsx scripts/count-corpus-tokens.ts` measures the corpus. Check the current rates before trusting the arithmetic below: **Gemini** at <https://ai.google.dev/gemini-api/docs/pricing>, **Claude** at <https://claude.com/pricing#api>.

**Gemini in `index` mode (`gemini-3.8-flash`, the default).** Each question sends the ~6K-token page map plus the pages the model reads (at most six; the whole corpus is ~80K tokens across 87 pages), in two or three model calls — so roughly 10–25K input tokens, at the flash-class rate of about $0.30 per million:

- **Every question**: ≈ 20K × $0.30 / 1M ≈ **$0.006**, plus output. Nothing is stored between questions, so there is no cache storage charge and a content edit costs nothing extra.

At `DAILY_CAP = 200` that is well under **$2** a day, and the bill scales with questions asked rather than with hours the site is up.

**Gemini in `cache` mode (`GEMINI_RETRIEVAL = "cache"`).** Flash-class input is roughly $0.30 per million tokens, cached input about a tenth of that, plus a storage charge (~$1 per million tokens per hour) for as long as the explicit cache lives:

- **Cold question** (first of the hour, or the first after any content change): the corpus is read at full rate and then stored, so ≈ 100K × $0.30 / 1M ≈ **$0.03**, plus ≈ **$0.10** to hold the cache for the hour.
- **Warm question** (cache hit): ≈ 100K × $0.03 / 1M ≈ **$0.003**, plus output.

At `DAILY_CAP = 200` a realistic day is well under **$5** — the hourly cache storage, not the questions, dominates. The worst case, if every question missed the cache, is about $8.

**Claude (`LLM_PROVIDER = anthropic`).** Sonnet 5 costs $2 per million input tokens (the model is the `MODEL` constant in `functions/_lib/chat.ts`), and its tokenizer counts about 30% more than older models:

- **Cold question**: the corpus is written to the 1-hour cache at 2× the base rate, so ≈ 100K × $2 × 2 / 1M ≈ **$0.40**, plus a few cents of output.
- **Warm question**: cached input reads cost 10% of the base rate, so ≈ 100K × $2 × 0.1 / 1M ≈ **$0.02**.

At `DAILY_CAP = 200` that lands near **$5–8**, worst case about $80.

Either way, watch the one JSON line the chat function logs per question before raising the cap: `chat_index_mode` in Gemini's index mode (`rounds`, `pages_read`, `prompt_tokens`), and a token-count line in the other two (`cachedContentTokenCount` on Gemini's cache mode, `cache_read_input_tokens` on Claude — one of those should dominate). All of them carry the model and the day's count, and never any message content. In the two cached modes a publish invalidates the cache, so the first question after each content edit is a cold one; index mode has no cache to invalidate.
