# Editing wssl.org

## One-time setup (per editor)
1. Create a free GitHub account at https://github.com/signup (use your @wssl.org email).
2. Send your GitHub username to the webmaster, who adds you as a collaborator with **Write** access on the content repository. Every editor has the same access.
3. Go to https://www.wssl.org/admin/ and click **Login with GitHub**.

## Editing a page
- Pick the section (Programs, Registration, Schedules, Fields, Volunteers, About), open the page, edit, click **Publish**.
- Publishing commits to GitHub and the site rebuilds automatically in about 1–2 minutes.
- **Draft**: tick "Draft" and publish to hide a page without deleting it.
- **New page**: click **New** in a section. "URL path" becomes the address under that section (e.g. `core/waitlists` → /programs/core/waitlists/). Add it to the menu under Site Settings → Navigation menu if it should appear in the nav.
- **PDFs and images**: use the image/file button in the editor; files are stored in `/uploads/`.

## Rainout / closure banner
Site Settings → Alert banner → tick "Show banner", write the message, Publish. Untick to remove.

## Undo
Every publish is a Git commit. Ask the webmaster to revert a change (`git revert <commit>`), or re-edit the page.
