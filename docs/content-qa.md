# Content QA — legacy vs new

Do this on `npx astro preview` (or the staging URL) with the old site open side by side.

For each top-level section, open every page listed in `src/data/nav.json` and check:
- [ ] Title and body text match the old page (tables, bullet lists, bold warnings such as the refund notice).
- [ ] Every PDF link opens (`/assets/legacy/...`), or points to the original external URL if the download failed.
- [ ] Images show; remove decorative ones that came through broken.
- [ ] Old Mura forms (Contact, Coach comment form, Referee feedback) are replaced with a link to a Google Form created by the section owner.
- [ ] Embedded YouTube/Maps iframes render (Referee videos, Fields pages).
- [ ] Pages that are out of date (e.g. Fall 2025 divisions) are either updated or marked Draft.

Record anything you cannot fix as a line in this file under "Open items".

## Open items

- (g) **Ten dead in-page links (`#fragment`) that were already dead on the old site.** The migration now preserves legacy `<a name="…">` anchors, so 98 of the 108 fragment links in the built site resolve. The ten below point at anchors that do not exist in the Mura HTML either (verified against the live API), so they were broken on wssl.org before the migration; `npm run check-links` reports them as "broken fragment links" until the webmaster adds the missing section anchors or removes the links in the CMS:
  - `/about/wssl-leadership/` → `#division`, `#travel`, `#other`, `#emeritus`
  - `/programs/travel-teams/travel-faq/` → `#tryouts`
  - `/schedules/training-schedules/winter-training/` → `#flex`, `#preseason`
  - `/volunteers/referees/referee-faq/` → `#teens`
  - `/programs/core/divisions/spring-2026/` → `#G9`, `#G11`
- (e) **Seasonal divisions pages in the Ask WSSL corpus.** The `programs/core/divisions/<season>` pages (Fall 2025, Spring 2026, …) are part of the corpus the assistant reads, so it can answer from a season that has passed. Whether to keep, prune or rewrite them is a content decision for the webmaster: either retire the stale season pages (set `draft: true`, which drops them from the corpus) or leave them and accept that answers may quote an old season. Raised by the final review; deliberately not changed by the fix wave.
- (f) **No Content-Security-Policy on the site.** `public/_headers` sets `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`, but no CSP: a useful policy has to allow Google Fonts, the editor's inline styles and the inline script in `/admin/index.html`, and needs testing against `/admin` before it can be turned on. (The CMS bundle itself is now served from our own origin, so `script-src 'self'` would cover it — the inline init script is what still needs a nonce or a hash.) Deferred from the final review.

- (a) The "Tryout Inquiry Form" nav link was dropped during migration because it pointed at a Mura-only URL (`migrate` skipped it as `Link:tryout-inquiry-form2`, with no equivalent page in the new site). The WSSL webmaster should add the Google Form URL for this link under Site Settings → Navigation.
- (b) The three Mura forms (Contact, Coach comment form, Referee feedback) need Google Forms in place of the old Mura form widgets. `src/content/pages/volunteers/coaches-coach-comment-form.md` and `src/content/pages/volunteers/referees-referee-feedback.md` already link to Google Forms — confirm those URLs are still the section owner's current forms. `src/content/pages/about/contact.md` has no form at all (only mailto links); the section owner should supply a Google Form URL if a Contact form is still wanted.
- (c) `/assets/legacy/Images/Fields/ballfield5.jpg` was unavailable on the old site (flagged in `scripts/migration-report.json`). The broken `<img>` reference was removed from `src/content/pages/fields/central-park-north-meadow.md`; the goal-nesting instructions on that page now show only the remaining `goalsnested.jpg` photo. If the webmaster has a replacement photo, it can be re-added.
- (d) The link checker (`npm run check-links`) found 8 broken internal links after the initial build, all fixed by hand-editing the affected Markdown:
  - `src/content/pages/programs/index.md`: `/programs/travel-tournament/travel-overview/` → `/programs/travel-teams/`; `/programs/travel-tournament/tournament-teams/` → `/programs/tournament-teams/` (legacy Mura URLs replaced with the actual migrated page paths).
  - `src/content/pages/programs/program-faq.md`: same two link targets, same fix.
  - `src/content/pages/volunteers/index.md`: `/volunteers/referees/` → `/volunteers/referees/welcome/` (there is no `/volunteers/referees/` index page; linked to the Referee welcome page, matching the pattern already used for the "Coach Volunteers" link on the same page).
  - `src/content/pages/volunteers/referees-welcome.md`: `/volunteers/referees/working-with-coaches/` → `/volunteers/referees/referee-resources/` (the "working with coaches" page was never migrated — no such content exists anywhere in the site — so this now points to the closest section page, Referee Resources).
  - `src/content/pages/volunteers/referees-welcome.md`: `/volunteers/referees/heading-the-ball/` → `/volunteers/referees/referee-resources/` (same reason: "Heading the Ball" was never migrated as its own page; points to the closest section page, Referee Resources).
  - `src/content/pages/fields/central-park-north-meadow.md`: removed the `![](/assets/legacy/Images/Fields/ballfield5.jpg)` image reference (see item c above).

  The side-by-side visual/content comparison against the live old site (title/body text match, PDF links, image quality, iframes, out-of-date season pages such as Fall 2025 / Spring 2026 divisions) still needs to be done by the WSSL webmaster on `npx astro preview` or the staging URL.
