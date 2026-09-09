# Editing wssl.org

## Signing in
You do not need an account or a password — just your email.

1. Go to https://www.wssl.org/admin/.
2. Type your email address and click **Send me a code**.
3. Open the email, copy the one-time code, paste it in.

That's it; the editor opens. The sign-in lasts a while, so you will not be asked every time. If your email is not on the list of editors you will be turned away — ask the webmaster to add it.

## Editing a page
- Pick the section (Programs, Registration, Schedules, Fields, Volunteers, About), open the page, edit, click **Publish**.
- Publishing commits to GitHub and the site rebuilds automatically in about 1–2 minutes.
- **Draft**: tick "Draft" and publish to hide a page without deleting it.
- **New page**: click **New** in a section. "URL path" becomes the address under that section (e.g. `core/waitlists` → /programs/core/waitlists/). Add it to the menu under Site Settings → Navigation menu if it should appear in the nav.
- **PDFs and images**: use the image/file button in the editor; files are stored in `/uploads/`.

## Rainout / closure banner
Site Settings → Alert banner → tick "Show banner", write the message, Publish. Untick to remove.

## Undo
Every publish is a Git commit recorded under your email address, so the webmaster can see who changed what and revert a change (`git revert <commit>`). You can also just re-edit the page.
