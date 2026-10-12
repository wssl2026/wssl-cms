# Editor training on staging

A 45-minute hands-on session for the two editors, run on the staging site before launch. The reference for everything below is [editors.md](editors.md); this is the session plan.

## Before the session (webmaster)

1. **Give the editors access.** Cloudflare dashboard → Zero Trust → Access → Applications → the `wssl-cms.pages.dev` application → its policy → add each editor's email to the **Include → Emails** list. They are turned away at sign-in until this is done.
2. **Send them two links:** the staging editor at `https://wssl-cms.pages.dev/admin/` and the staging site at `https://wssl-cms.pages.dev/`. Until launch, the editor lives at that address, not at wssl.org.
3. **Say this up front:** staging is a copy. Until launch, real changes still go on the old wssl.org site. On launch day the pages here are replaced by a final copy of the old site, so a page edited here before then is lost. The practice page is the exception: it is never overwritten.

## What staging edits do, and do not, survive

| Edited on staging before launch | At launch |
| --- | --- |
| Any ordinary page (Programs, Registration, …) | Replaced by the old site's version. Make the real change on wssl.org. |
| The practice page (About → Editor practice page) | Kept until the webmaster deletes it. Edit freely. |
| Site Settings: Alert banner, Contact & links, Home page, Navigation menu | **Kept as-is.** Put them back the way you found them before leaving. |

## Session plan

**1. Sign in (5 min).** Everyone opens the editor link, enters their email, pastes the code from the email, then clicks **Sign In with GitHub** on the editor's welcome screen (it is not a second sign-in; see editors.md). Expect a small window to flash open and close.

**2. Find your way around (5 min).** Left column: the six site sections and Site Settings. Open **About → Editor practice page**. Point out the three parts of the screen: the form on the left, the preview pane on the right, and the **View on site** link above the form. Toggle the Body field between rich text and Markdown once, then back.

**3. Edit the practice page (15 min).** Each editor, in turn or on their own copy of the instructions at the bottom of the page:
- fix the typo in the last paragraph;
- add a bullet to the list;
- type a new line and make it a blue banner with Heading 3 from the heading menu;
- put the cursor on an empty line, click the image button, and pick any photo from the **legacy** folder in the library;
- click **Save**, then watch the preview, then wait a minute or two and click **View on site**.
Show that the saved page on the site matches the preview, including the banner and the side column on a wide window.

**4. A notice box (5 min).** Switch the Body to Markdown view, copy the red callout block already on the page, paste it below, change its text, switch back to rich text, save. This is the one thing that needs the Markdown view; everything else is the toolbar.

**5. The rainout banner (5 min).** This is the edit they will make most often in a hurry. Site Settings → Alert banner → tick **Show banner**, type "Practice: all fields closed today", pick a colour, Save. Open the staging home page after the rebuild and see the banner. Then untick it and save again, so staging is left clean.

**6. The home page (5 min).** Site Settings → Home page. Show the field status line and the announcement cards. Look only; or change the field status, save, see it on the home page, and change it back.

**7. Questions and the two rules (5 min).**
- Saving publishes. There is no draft-then-approve step; the rebuild takes a minute or two and then it is live. The **Draft** tick box hides a whole page.
- Every save records who made it, and the webmaster can undo any save. Nobody can break the site in a way that cannot be reverted.

## After launch

Nothing changes for the editors except the address: `https://www.wssl.org/admin/`. The webmaster deletes the practice page before launch (it is listed in the README's pre-launch checklist).
