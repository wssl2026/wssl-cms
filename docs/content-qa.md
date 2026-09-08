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
