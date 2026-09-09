# wssl-cms
Source for https://www.wssl.org — Astro static site, content in `src/content/pages`, edited via Sveltia CMS at `/admin`, hosted on Cloudflare Pages. See `docs/editors.md` (editing) and `docs/runbook.md` (operations, created at deploy time).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server |
| `npm run build` | Vendor the pinned Sveltia CMS bundle into `public/admin/`, rebuild the Ask WSSL corpus and page index, then `astro build` into `dist/` |
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
- **GitHub bot token** — create a **fine-grained personal access token** (Repository access: *only* the content repository; Repository permissions: **Contents: read and write**, **Metadata: read-only**) and store it as the `GITHUB_BOT_TOKEN` Pages secret. Every edit is committed by this token, with the signed-in editor recorded in a `Co-authored-by:` trailer on the commit.
- **`wrangler.toml`** — set `GITHUB_REPO` to the real `owner/repo` and `GITHUB_BRANCH` to the branch Pages builds from. The `USAGE` KV namespace `id` and `preview_id` are zeros; create them with `npx wrangler kv namespace create USAGE` (and `--preview`) and paste the ids in.
- **`public/admin/config.yml`** — `backend.repo` is `wssl2026/wssl-cms` (the content repository), and it must match `GITHUB_REPO`: the proxy refuses any call aimed anywhere else, so a mismatch shows up as a 403 on every request the editor makes.
- **Cloudflare Pages secrets** (Settings → Environment variables, encrypted):
  - `GEMINI_API_KEY` — the Ask WSSL assistant on its default provider (Google AI Studio → Get API key).
  - `ANTHROPIC_API_KEY` — only needed if you switch `LLM_PROVIDER` to `anthropic`.
  - `GITHUB_BOT_TOKEN` — the fine-grained PAT above.
  - `CMS_SESSION_SECRET` — a random string **at least 32 characters** long (a password generator's output is fine) that signs the editor's session token. Without it, or with a shorter one, `/admin` cannot sign anyone in: both `/api/cms/auth` and `/api/cms/gh/*` answer 503. Changing it signs every editor out; nothing else depends on its value.
- **Ask WSSL's model** — `LLM_PROVIDER` in `wrangler.toml` is `gemini` (the alternative is `anthropic`; any other value makes the widget answer "temporarily unavailable" and logs `chat_provider_misconfigured`). `GEMINI_MODEL` is `gemini-3.8-flash` and `GEMINI_RETRIEVAL` is `index` (the alternative is `cache`; see "How Ask WSSL answers" and Cost). Confirm the key can actually call that model **once, before launch**: `GEMINI_API_KEY=... npm run check-gemini-model` lists every model the key may use and exits non-zero if `GEMINI_MODEL` is not among them.
- **`DAILY_CAP`** (plain var, default `200`) — the number of Ask WSSL questions answered per UTC day before the widget answers "reached its daily limit". Raise or lower it after watching the first week; see Cost below.
- **Question log** (optional) — set `QUESTION_LOG_URL` in `wrangler.toml` and the `QUESTION_LOG_SECRET` Pages secret to log every Ask WSSL question to a Google Sheet. See "Question log (Google Sheet)" below. Off by default — leave both unset to skip this.
- **`docs/runbook.md`** — operations runbook, written in Task 12 at deploy time. It does not exist yet.

## How `/admin` signs editors in

Cloudflare Access protects `/admin` and `/api/cms`, so an editor proves who they are with a one-time code sent to their email. Access then injects a signed `Cf-Access-Jwt-Assertion` header into every request it forwards.

Sveltia CMS runs in the editor's browser and speaks the GitHub API, so it expects to hold a GitHub credential. It must never hold ours. Two functions stand between it and GitHub:

- **`functions/api/cms/auth.ts`** (`GET /api/cms/auth`) is the sign-in popup Sveltia opens. It verifies the Access JWT and mints a **session token** — `base64url({email, exp})` plus an HMAC over it, signed with `CMS_SESSION_SECRET`, good for eight hours — then hands it to the editor through the postMessage handshake Sveltia listens for. The session token is not a GitHub credential and is worth nothing on its own.
- **`functions/api/cms/gh/[[path]].ts`** (`ALL /api/cms/gh/*`) is the GitHub API as far as the editor is concerned; `public/admin/index.html` points Sveltia's `api_root` at it. Every request must carry **both** a valid Access JWT **and** a session token that decodes to the same email — a session copied out of one editor's browser is useless in another's. Only then does the proxy attach the `GITHUB_BOT_TOKEN` and forward.

What may be forwarded at all is decided by `functions/_lib/github-proxy.ts`, and it is a short list: the recursive tree listing, blob reads, and the GraphQL endpoint — the last one only for a query that reads *this* repository through its `$owner`/`$repo` variables, or for the single `createCommitOnBranch` mutation aimed at this repository. `GET /user`, `GET /user/emails` and the collaborator check are answered from the Access email without calling GitHub at all, so the bot's own account is never described to the browser. Everything else — forks, pull requests, issues, refs, `dispatches`, other repositories, the `viewer` — is a 403.

GitHub's `createCommitOnBranch` mutation has no author or committer field: it attributes the commit to whoever the token belongs to, which is the bot. So the proxy adds a `Co-authored-by: <editor email>` trailer to every commit it forwards, and strips any trailer the browser tried to send, which is what keeps `git log` able to answer "who changed this".

Locally, run `npx wrangler pages dev dist --port 8790` with `GITHUB_BOT_TOKEN` and `CMS_SESSION_SECRET` in `.dev.vars` and `CF_ACCESS_AUD` empty (`.dev.vars` overrides `wrangler.toml`); both functions then accept unauthenticated requests from `localhost` only, as `local@wssl.org`. For editing against your own working copy there is no server to run at all — open `/admin` on localhost and use Sveltia's **Work with Local Repository** button, which reads and writes the checkout through the browser's File System Access API.

## How Ask WSSL answers

`functions/api/chat.ts` owns the guards — same-origin only, history validation, the KV daily cap — and the SSE wire protocol the widget reads (`text`, `citation`, `done`, `error`). Behind them sits a small provider interface (`functions/_lib/providers/types.ts`) with two implementations, chosen by `LLM_PROVIDER`:

- **`gemini`** (`functions/_lib/providers/gemini.ts`) — has two **retrieval modes**, chosen by `GEMINI_RETRIEVAL` in `wrangler.toml`; any value other than `cache` means `index`. Both share client construction, abort handling, error mapping and `served_by`, so the handler and the widget cannot tell them apart. Gemini has no citation API either way, so the shared system prompt already requires inline Markdown links to the pages used; the server parses those links back out of the answer into `citation` events, so sources are never listed twice. If a provider's API key is not configured, `/api/chat` returns the same 503 config-error response as an unknown `LLM_PROVIDER` instead of a raw exception.
  - **`index`** (the default, `gemini-index.ts`) — the model gets a map of the site instead of the site: one line per page (`- title — url — summary [headings]`), about 6K tokens for all 87 pages, built into `functions/_lib/index.json` (git-ignored, rebuilt by `npm run build` beside `corpus.json`). It then calls a `read_pages` tool with the URLs it wants and answers from those pages. The loop is boxed in — at most **2 tool rounds**, **4 pages per call** and **6 pages per question**, so a question is at most three model calls — and it always ends with a streamed answer, so the visitor sees text arriving even when the model never called the tool. A URL that is not in the corpus comes back as `(no such page)` rather than being dropped, and a tool the provider does not offer is ignored with a `gemini_unknown_tool` log line. Sources are the pages actually read, plus any other corpus page the answer links to. One JSON line per question, `chat_index_mode`, carries `rounds`, `pages_read` and the token counts — never page text, the question or the answer. If `index.json` somehow arrives empty the provider logs `gemini_index_missing` and falls back to cache mode rather than answering from an empty map.
  - **`cache`** (`gemini-cache.ts`) — the whole corpus plus the system prompt goes into a Google **explicit context cache** that lives an hour; its name is recorded in the `USAGE` KV namespace under `gemini-cache:<model>:<sha256 of corpus+prompt>`, so every request in that hour reuses it (log line `gemini_cache_hit`). Change any page and the hash changes, so the next question writes a fresh cache instead of answering from stale content. If the cache turns out to be gone the function rebuilds it and retries once; if the model refuses to cache at all — usually the corpus is under the minimum token count — it logs `gemini_cache_unavailable` and sends the corpus inline instead. A response with no exception but nothing usable in it (no cache name) is treated the same way — inline for that one request — without giving up on caching for the isolate.
- **`anthropic`** (`functions/_lib/providers/anthropic.ts`) — unchanged: the corpus as citation-enabled documents with a 1-hour prompt cache, and Claude's own citation deltas.

## Question log (Google Sheet)

Every answered Ask WSSL question can be logged to a Google Sheet, so the owner can see what families are asking and where the assistant falls short. It is **off by default** and entirely opt-in by configuration — set both `QUESTION_LOG_URL` and `QUESTION_LOG_SECRET` to turn it on. Logging never touches the visitor's answer: it happens after `functions/api/chat.ts` finishes streaming the SSE response, scheduled with `context.waitUntil` so it cannot delay or fail the request, and every failure (a rejected fetch, a non-2xx response, a timeout, or a wrong secret) is caught and reduced to a `question_log_error` log line carrying only the HTTP status and, when relevant, a short excerpt of the response body — never thrown, never the question or answer content. The Apps Script above answers a rejected secret with HTTP 200 and the body `forbidden` rather than an error status, so a 2xx response alone is not treated as success: only a body of exactly `ok` is — anything else (including `forbidden`) is logged as `question_log_error` so a mismatched `SECRET` / `QUESTION_LOG_SECRET` doesn't fail silently.

What is recorded, one row per question: the timestamp, an anonymous session id, the question (trimmed, at most 2000 characters), the first 2000 characters of the answer, the distinct source URLs cited, the provider and model, the retrieval mode (`index` / `cache` / `anthropic`), a status (`ok`, `error`, or `refusal`), how long the answer took, and the prompt/candidate token counts. **Nothing else** — no IP address, no user agent, no conversation history beyond the single question just asked.

The session id is a random value the widget generates once per browser tab (`crypto.randomUUID()`, kept in `sessionStorage`) purely so the owner can see which rows came from the same visit — it carries no personal data, is never derived from anything about the visitor, and resets the moment the tab is closed or the browser is restarted. The server only accepts a well-formed id (letters, digits and hyphens, at most 64 characters); anything else is logged as an empty `session_id` rather than rejecting the question.

### Setting up the sheet (no coding required)

1. Create a new Google Sheet named **"Ask WSSL questions"** (any name works, but this keeps it recognizable).
2. Open **Extensions → Apps Script**, delete the placeholder code, and paste in exactly this:

   ```javascript
   const SECRET = PropertiesService.getScriptProperties().getProperty('SECRET');
   const HEADERS = ['ts', 'session_id', 'question', 'answer_excerpt', 'sources', 'provider', 'model', 'retrieval', 'status', 'ms', 'prompt_tokens', 'candidates_tokens'];
   function doPost(e) {
     const body = JSON.parse(e.postData.contents || '{}');
     if (!SECRET || body.secret !== SECRET) return ContentService.createTextOutput('forbidden').setMimeType(ContentService.MimeType.TEXT);
     const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
     if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
     sheet.appendRow(HEADERS.map((h) => body[h] == null ? '' : String(body[h])));
     return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
   }
   ```

3. In the Apps Script editor, go to **Project Settings → Script properties → Add script property**. Name it `SECRET` and set it to a long random string (a password generator's output is fine) — this is the shared secret that stops strangers from writing junk rows into the sheet. Keep this value somewhere safe; the same value goes into `QUESTION_LOG_SECRET` below.
4. Click **Deploy → New deployment**. For "Select type" choose **Web app**. Set **Execute as** to **Me**, and **Who has access** to **Anyone**. Click **Deploy** and authorize the script when prompted.
5. Copy the **Web app URL** it gives you (it looks like `https://script.google.com/macros/s/.../exec`).
6. In `wrangler.toml`, set `QUESTION_LOG_URL` to that URL.
7. In the Cloudflare Pages dashboard (Settings → Environment variables), add the secret `QUESTION_LOG_SECRET` with the same random string from step 3.
8. Redeploy the site. Ask a question through the widget on the live site; a row should appear in the sheet within a few seconds.

**Why "Anyone" for access?** The Cloudflare function that posts the row is not signed in with a Google account, so the web app must accept unauthenticated requests — that is what "Anyone" means for an Apps Script web app. It does **not** mean anyone can read your sheet or run arbitrary code: the script only exposes the one `doPost` entry point above, and that checks the `SECRET` on every request before writing anything. Anyone who does not know the secret gets back `forbidden` and nothing is written.

**Retention (optional).** To automatically delete rows older than 12 months, add this function in the same Apps Script project and attach a time-driven trigger to it (in the Apps Script editor, the clock icon on the left → **Add Trigger** → choose `prune`, event source **Time-driven**, a monthly timer):

```javascript
function prune() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const values = sheet.getDataRange().getValues();
  for (let row = values.length; row > 1; row--) {
    if (new Date(values[row - 1][0]) < cutoff) sheet.deleteRow(row);
  }
}
```

## Cost

How much a question costs depends on the provider and, on Gemini, on the retrieval mode: index mode sends a small map plus a few pages, cache mode sends the whole site. `npm run corpus` builds both files and prints their sizes; `npx tsx scripts/count-corpus-tokens.ts` measures the corpus. Check the current rates before trusting the arithmetic below: **Gemini** at <https://ai.google.dev/gemini-api/docs/pricing>, **Claude** at <https://claude.com/pricing#api>.

**Gemini in `index` mode (`gemini-3.8-flash`, the default).** Each question sends the ~6K-token page map plus the pages the model reads (at most six; the whole corpus is ~80K tokens across 87 pages), in two or three model calls — so roughly 10–25K input tokens, at the flash-class rate of about $0.30 per million:

- **Every question**: ≈ 20K × $0.30 / 1M ≈ **$0.006**, plus output. Nothing is stored between questions, so there is no cache storage charge and a content edit costs nothing extra.

At `DAILY_CAP = 200` that is well under **$2** a day, and the bill scales with questions asked rather than with hours the site is up. That 10–25K figure assumes typically-sized pages: a page's full text, once read, rides along in `contents` on every later call for that question (the second tool round's request, and always the final answer), so it is billed again each time rather than once. A worst-case question — the model reads all six pages, and each is unusually large — can reach roughly **60–70K** input tokens for that one question.

**Gemini in `cache` mode (`GEMINI_RETRIEVAL = "cache"`).** Flash-class input is roughly $0.30 per million tokens, cached input about a tenth of that, plus a storage charge (~$1 per million tokens per hour) for as long as the explicit cache lives:

- **Cold question** (first of the hour, or the first after any content change): the corpus is read at full rate and then stored, so ≈ 100K × $0.30 / 1M ≈ **$0.03**, plus ≈ **$0.10** to hold the cache for the hour.
- **Warm question** (cache hit): ≈ 100K × $0.03 / 1M ≈ **$0.003**, plus output.

At `DAILY_CAP = 200` a realistic day is well under **$5** — the hourly cache storage, not the questions, dominates. The worst case, if every question missed the cache, is about $8.

**Claude (`LLM_PROVIDER = anthropic`).** Sonnet 5 costs $2 per million input tokens (the model is the `MODEL` constant in `functions/_lib/chat.ts`), and its tokenizer counts about 30% more than older models:

- **Cold question**: the corpus is written to the 1-hour cache at 2× the base rate, so ≈ 100K × $2 × 2 / 1M ≈ **$0.40**, plus a few cents of output.
- **Warm question**: cached input reads cost 10% of the base rate, so ≈ 100K × $2 × 0.1 / 1M ≈ **$0.02**.

At `DAILY_CAP = 200` that lands near **$5–8**, worst case about $80.

Either way, watch the one JSON line the chat function logs per question before raising the cap: `chat_index_mode` in Gemini's index mode (`rounds`, `pages_read`, `prompt_tokens`, `candidates_tokens`, `thoughts_tokens`, `turns` — the token counts are summed across every tool turn and the final stream, not just the last one), and a token-count line in the other two (`cachedContentTokenCount` on Gemini's cache mode, `cache_read_input_tokens` on Claude — one of those should dominate). All of them carry the model and the day's count, and never any message content. In the two cached modes a publish invalidates the cache, so the first question after each content edit is a cold one; index mode has no cache to invalidate.
