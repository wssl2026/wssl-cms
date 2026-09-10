# Editing wssl.org

## Signing in
You do not need a GitHub account, and you do not need a password — just your email.

1. Go to https://www.wssl.org/admin/.
2. Type your email address and click **Send me a code**.
3. Open the email, copy the one-time code, paste it in.
4. The editor's own welcome screen appears. Click **Sign In with GitHub**.

That fourth click is not a second sign-in and there is nothing to type: the editor calls the button "GitHub" because GitHub is where the site's pages are kept, but it is your email sign-in from step 3 that it checks. A small window may flash open and close — that is the editor collecting your session. If it does not, allow pop-ups for wssl.org and click the button again.

The sign-in lasts a while, so you will not be asked every time. After about eight hours of editing the session runs out and the editor asks you to reload the page — reload `/admin/` and click the button again. If you have had the editor open longer than that, clicking **Save** will fail with a sign-in error instead of publishing; your unsaved changes stay in the browser tab, so sign in again and save once more rather than closing the tab. If your email is not on the list of editors you will be turned away — ask the webmaster to add it.

Ignore **Work with Local Repository**: that button only appears to developers running the site on their own machine.

## Editing a page
- Pick the section (Programs, Registration, Schedules, Fields, Volunteers, About), open the page, edit, click **Save**.
- Saving commits to GitHub and the site rebuilds automatically in about 1–2 minutes.
- **Draft**: tick "Draft" and save to hide a page without deleting it.
- **New page**: click **New** in a section. "URL path" becomes the address under that section (e.g. `core/waitlists` → /programs/core/waitlists/). Add it to the menu under Site Settings → Navigation menu if it should appear in the nav.
- **PDFs and images**: drag the file straight onto the image or file field, or click the field and pick **Upload** in the asset library that opens. The library also lets you re-use a file you uploaded earlier instead of uploading it twice. Files are stored under `/assets/`; the pictures and PDFs carried over from the old site are already in the library under `legacy`, so you can reuse them instead of uploading again.
- **Tables**: the editor understands Markdown tables and shows them as real tables, but this version has no toolbar button for inserting one. To add a table, or to add a row or a column to one, switch the content box to its **Markdown** view with the toggle above it and edit the pipe (`| … | … |`) rows directly; switch back to rich text to check the result. Editing the *text inside* an existing table's cells works in either view.

## Page styles carried over from the old site
- **Blue banner headings**: the navy bar with white text that heads most sections is **Heading 3**. Put the cursor on the line, open the heading menu in the toolbar and pick Heading 3. Heading 2 is a plain large heading, as before.
- **Bold text**: the whole site is set in bold, as the old site was, so ordinary text and "bold" text look the same. Use a banner or a bullet list to make something stand out.
- **Indent**: the quote button indents a paragraph; it does not put it in italics or draw a bar beside it.
- **Coloured callout boxes** (the green or red notices): these are small HTML blocks. To add one, switch the content box to its **Markdown** view and paste, on its own lines with a blank line above and below:

  ```
  <div class="alert alert-danger">

  Your notice here. Links and **bold** work.

  </div>
  ```

  Use `alert-success` for green, `alert-danger` for red, `alert-warning` for yellow. Editing the text inside an existing box works in either view.
- **Side column**: photos and link lists that appeared to the left of a page on the old site live in the page's **Side column** field, above the Body. Add photos with the image button; a Heading 3 line there makes a blue banner over a list of links. Leave it empty for a page without a side column. On phones the side column shows after the page text.

## Preview while editing
Every page and Site Settings screen has a preview pane next to the editing form that updates as you type. Once a page has been saved at least once, a **View on site** link also appears above the form; it opens the live page in a new tab. That link always shows the last *saved* version of the page — it will not show edits you have made since the last **Save**, and after the rebuild finishes (about 1–2 minutes) it reflects what is now live. The preview pane shows just the page content — title and body — styled roughly like the site; for the exact look, use the **View on site** link after saving.

## Rainout / closure banner
Site Settings → Alert banner → tick "Show banner", write the message, Save. Untick to remove.

## Undo
Every save is a Git commit that records your email address, so the webmaster can see who changed what and revert a change (`git revert <commit>`). You can also just re-edit the page.
