# WSSL Website Migration — Spec (Option 3: Static Site + Git-based CMS + custom AI assistant)

Source of record: Google Doc "WSSL Website Migration Plan - Option 3 (Jamstack & Headless CMS)"
(https://docs.google.com/document/d/1jzL4CZzkWOwNa-Ue7gMFNhqHgLe1pwh9Dx5r0b69SRg/edit), captured 2026-09-08,
plus the two deltas requested by Wei Tang on 2026-09-08 (see "Deltas from the Google Doc").

## Objective

Move the West Side Soccer League (WSSL, AYSO Region 473) public website off the deprecated Mura CMS
(https://www.wssl.org, `Mura CMS 7.5.2`) onto a static site generated from Markdown in a Git repository,
edited through an open-source browser CMS at `/admin`, hosted on a free edge CDN, with an AI assistant that
answers parent/coach/referee questions from the site's own content.

## Facts verified against the live site (2026-09-08)

| Fact | Value |
|---|---|
| Current CMS | Mura CMS 7.5.2 (`<meta name="generator">`) behind Cloudflare; DNS zone already on Cloudflare |
| Content API | `https://www.wssl.org/index.cfm/_api/json/v1/wssl/content/?fields=...&maxitems=100&pageIndex=N` returns every page with `body` HTML, `filename` (URL path), `title`, `menutitle`, `parentid`, `displayorder`, `isnav`, `lastupdate` |
| Content volume | 92 items (91 `Page`, 1 `Link`); 85 with a body; ~265K characters of text ≈ 66K tokens |
| Sections (top nav) | Programs, Registration, Schedules, Fields, Volunteers (coaches / referees / volunteers), About; `/blog` exists but has no posts |
| Largest pages | divisions fall-2025 / spring-2026 (~13K chars), referee classes, referee FAQ, travel FAQ, program FAQ |
| Assets | 23 PDF links (`/sites/wssl/assets/...`, some on `cms.wssl.org` and `inleague.wssl.org`), 48 images under `/sites/wssl/assets/Image/` |
| Page body container | `section.content > h1.mura-page-title` + `div.mura-body` (only needed if the JSON API disappears) |
| Brand | Navy `#002664`, gold `#ffbd41`, font "PT Sans"; logos `/sites/wssl/themes/wssl-theme/images/wssl-header-lg.png` and `.../mobile-logo.png`; carousel images `/sites/wssl/assets/Carousel/carousel-{1..4}.png` |
| Social | https://www.facebook.com/wsslnyc/ , https://www.instagram.com/wsslnyc/ |
| Transactional system | inLeague (`https://inleague.wssl.org`) for registration, rosters, payments, documents — stays external |
| Forms on old site | Mura forms with reCAPTCHA (contact, coach comment, referee feedback); WSSL already uses Google Forms for tryout inquiries |
| Verified emails | `registrar@wssl.org` (refund policy page) |

## Requirements (from the Google Doc)

1. **SSG**: Astro, static HTML output, mobile-responsive, Tailwind CSS.
2. **Content store**: private GitHub repo; each page is a Markdown file with frontmatter, grouped by section.
3. **Headless CMS**: open-source, form-based, at `/admin`; email/OAuth login; saving commits to GitHub; builds in < 60 s.
4. **Hosting**: Cloudflare Pages or Netlify, custom domain, automatic builds on every commit.
5. **Phase 1 – extraction**: automated pull of all legacy pages, HTML → Markdown, media and PDFs downloaded, content grouped by section.
6. **Phase 2 – layouts**: global nav, header alert banner (field closures / rainouts), footer links, document download styling; external links to league operational systems preserved.
7. **Phase 3 – CMS**: schema with validated fields (dates, text, PDF attachments); access control.
8. **Phase 4 – deployment**: deploy, add AI assistant to the root layout, re-index content, DNS cutover.
9. **Cost target**: ≈ $0 hosting/repo/CMS; forms $0–10; AI $19–49 / month.
10. **Continuity**: no server runtime, full Git history, plain Markdown = zero lock-in.

## Deltas from the Google Doc (decided 2026-09-08)

- **Permissions**: all editors have the same permissions. The doc's module-level roles (CODEOWNERS / Tina Cloud roles) are dropped. Every editor is a GitHub collaborator with write access to the content repo; every save publishes directly to `main`. A per-page `draft` flag lets an editor hide a page without deleting it. Git history is the rollback mechanism.
- **CMS choice**: Decap CMS 3 (100% open source; the doc's "Decap" option). TinaCMS is dropped (hosted Tina Cloud is not open-source-only).
- **Editor login (changed 2026-09-08)**: editors sign in with an email one-time code through Cloudflare Access; a Pages Function commits to GitHub with one league-owned bot token, recording the editor's email as the commit author. Editors do not need GitHub accounts.
- **AI assistant**: custom-built, not Chatbase/SiteGPT, so it can use the newest Claude model and features. It is a Cloudflare Pages Function calling the Claude API (`claude-opus-5`) with streaming, adaptive thinking, the citations feature, 1-hour prompt caching of the whole site corpus, and server-side refusal fallbacks. Because the whole site is ~66K tokens, the full corpus is sent on every request (cached); no vector store / retrieval step.
- **Hosting**: Cloudflare Pages (not Netlify) because the wssl.org DNS zone is already on Cloudflare and the assistant, the CMS OAuth handshake, and a KV usage counter all run as Pages Functions with no extra vendor.
- **Forms**: the Mura forms are replaced by links to Google Forms (already used by WSSL) — $0, no code.
- **Extraction language**: TypeScript/Node (one toolchain for scripts, site, and functions) using the Mura JSON API instead of a Python crawler.

## Non-goals (follow-ups, not in this project)

- Blog/news collection (legacy blog is empty).
- Password-protected role zones, SSO with inLeague, coach-certification automation.
- PDF text inside the assistant corpus (PDFs are linked, not read) — add later if questions about PDF content are common.
- Analytics.

## Success criteria

- Every legacy page URL (`/<section>/<...>/`) resolves on the new site with the same content, or is redirected.
- An editor with a GitHub account can log in at `/admin`, edit a page, save, and see the change live within ~2 minutes.
- The assistant answers "What is the refund policy for core?" from the Refund Policy page with a citation link, streams the answer, and refuses to invent facts not on the site.
- Monthly run rate at expected traffic (≤ 50 questions/day) stays under ~$60, with a hard daily request cap.
