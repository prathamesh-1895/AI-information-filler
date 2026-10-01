# Manual tests

Things the automated suites cannot drive. Run them on a real Chrome or Edge
with the built extension loaded (`chrome://extensions` → Developer mode →
Load unpacked → `apps/extension/.output/chrome-mv3`). Never submit a real
form while testing.

## Screen Share (PLAYBOOK Task 10.1)

Playwright cannot click the browser's own share picker, so screen and window
sharing is checked by hand. Before you start:

- You are signed in (Settings → Account), and Settings → AI help says **AI on**.
- The vault has at least Full name and City.

Steps:

1. Open `test-fixtures/canvas-form.html` from `pnpm fixtures` (http://127.0.0.1:5178/canvas-form.html) in a separate **window**.
2. In the side panel, open **Screen** → **Share a screen or window**.
3. The browser's picker opens. Choose the **Window** tab and pick the window from step 1, then **Share**.
   - Expected: the panel header shows a red **Sharing** badge with **Stop sharing**, on every panel tab.
   - Expected: Chrome shows its own "sharing" bar as well.
4. Click **Take a picture of the shared screen**.
   - Expected: a preview of the window appears. Nothing has been sent yet. "0 hidden" is shown, because screens get no automatic hiding.
5. Drag over the **Password** box on the preview.
   - Expected: it turns solid dark and the count says "1 hidden".
   - **Undo** removes it again; drag it back.
6. Click **Read with AI**.
   - Expected: "Event registration", "Filler can’t type into this app. Copy each value.", and the fields in screen order.
   - Full name and City have values with **Copy**. Password is **Never filled** with no Copy button.
7. Click **Copy** next to Full name, then paste into any text box.
   - Expected: your name is pasted.
8. Click **Stop sharing** in the panel header.
   - Expected: the badge disappears, Chrome's sharing bar closes, and **Take a picture…** is replaced by **Share a screen or window**.
9. Share again, then stop it from **Chrome's own bar** instead.
   - Expected: the panel's badge disappears too.
10. Cancel the picker once.
    - Expected: "Sharing was cancelled or is not allowed here." and nothing else happens.

Record the date, browser version and result in `PROGRESS.md` under the phase that asked for this check.

## Tab snapshot permission (real browser)

Automated tests give the build `<all_urls>` because Playwright cannot click the toolbar button. In a real install, test both ways a tab snapshot is permitted:

1. Open any https page with a form. Click Filler's toolbar button, then **Screen → Snapshot this tab**.
   - Expected: it works (the click granted `activeTab`).
2. Open a new tab with a different site. Switch to it **without** clicking the toolbar button, then use **Snapshot this tab** from the open panel.
   - Expected: either it works (site access granted earlier), or the readable message "Click Filler's toolbar button on the tab first, or use Share a screen or window".

## Live sites, one per family (PLAYBOOK Task 11.3)

Check one real site per family. **Never press the final Submit / Publish / Apply / Pay button.** Use your own account: you sign in yourself, Filler never does. If you don't use a site, pick another from the same family, or write "skipped".

For each site:
1. Sign in to the site yourself and open the profile or form page.
2. Click Filler's toolbar button, then **Start on this page**.
3. Note:
   - **a.** Does "Tips for …" show the right family, or none (fine for "Generic")?
   - **b.** How many fields were planned, and how many asked as questions?
   - **c.** Were any fields wrong (wrong value, or wrong field)? Write the label.
   - **d.** Were password, OTP, card, Aadhaar, PAN or other ID fields shown under "Not filled by Filler" with **Never filled**, and left empty?
4. Approve and **Fill** one or two harmless fields (for example your city), check they stuck, then undo them on the site if you like.
5. Close the tab without submitting.

| Family | Suggested site | Profile shown (a) | Planned / asked (b) | Wrong fields (c) | Never-fill OK (d) | Date |
|---|---|---|---|---|---|---|
| Freelance | Upwork or Fiverr profile edit page | | | | | |
| Jobs / internships | LinkedIn Easy Apply, Naukri, Internshala or a Workday/Greenhouse/Lever careers page | | | | | |
| Online forms | Any Google Form you own (make a test one) | | | | | |
| Hackathon / event | Devfolio or Unstop registration | | | | | |
| College / scholarship / government | A college admission or scholarship form (personal-details step only) | | | | | |
| Generic (no profile) | Any other site's "edit profile" page | | | | | |

Send the filled table back (or paste it into chat) and it will be recorded in `PROGRESS.md`.
