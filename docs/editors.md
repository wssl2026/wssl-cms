# Editing wssl.org

## Signing in
You do not need a GitHub account, and you do not need a password — just your email.

1. Go to https://www.wssl.org/admin/.
2. Type your email address and click **Send me a code**.
3. Open the email, copy the one-time code, paste it in.
4. The editor's own welcome screen appears. Click **Sign In with GitHub**.

That fourth click is not a second sign-in and there is nothing to type: the editor calls the button "GitHub" because GitHub is where the site's pages are kept, but it is your email sign-in from step 3 that it checks. A small window may flash open and close — that is the editor collecting your session. If it does not, allow pop-ups for wssl.org and click the button again.

The sign-in lasts a while, so you will not be asked every time. After about eight hours of editing the session runs out and the editor asks you to reload the page — reload `/admin/` and click the button again. If your email is not on the list of editors you will be turned away — ask the webmaster to add it.

Ignore **Work with Local Repository**: that button only appears to developers running the site on their own machine.

## Editing a page
- Pick the section (Programs, Registration, Schedules, Fields, Volunteers, About), open the page, edit, click **Save**.
- Saving commits to GitHub and the site rebuilds automatically in about 1–2 minutes.
- **Draft**: tick "Draft" and save to hide a page without deleting it.
- **New page**: click **New** in a section. "URL path" becomes the address under that section (e.g. `core/waitlists` → /programs/core/waitlists/). Add it to the menu under Site Settings → Navigation menu if it should appear in the nav.
- **PDFs and images**: drag the file straight onto the image or file field, or click the field and pick **Upload** in the asset library that opens. The library also lets you re-use a file you uploaded earlier instead of uploading it twice. Files are stored in `/uploads/`.
- **Tables**: the editor understands Markdown tables and shows them as real tables, but this version has no toolbar button for inserting one. To add a table, or to add a row or a column to one, switch the content box to its **Markdown** view with the toggle above it and edit the pipe (`| … | … |`) rows directly; switch back to rich text to check the result. Editing the *text inside* an existing table's cells works in either view.

## Rainout / closure banner
Site Settings → Alert banner → tick "Show banner", write the message, Save. Untick to remove.

## Undo
Every save is a Git commit that records your email address, so the webmaster can see who changed what and revert a change (`git revert <commit>`). You can also just re-edit the page.
