# Twice-weekly Moodle deadlines check (Claude in Chrome)

**Why this way:** Monash's Moodle has no calendar export and the Moodle app is blocked, but you can
see the calendar in your browser. So Claude in Chrome reads the *Upcoming events* page in your
own logged-in Chrome and hands it to Life. Life turns each item into a uni task with a due date,
or updates the existing one, so nothing is duplicated.

## Set up (once)
1. In the Chrome where Claude in Chrome is installed, log into learning.monash.edu (tick "stay
   signed in" if Okta offers it), and open Life once so your token is saved.
2. Claude in Chrome panel → create a shortcut with the prompt below → clock icon → schedule it
   **Sunday 3pm and Wednesday 6pm**.
3. Run it once by hand and check Life → Inbox.

## Prompt (replace LIFE_DOMAIN)

```
Read-only Moodle deadlines check for my planning app, Life.

RULES: read only. Never submit, upload, start a quiz attempt, post or change any settings. Only open pages and read them. If Okta/Monash asks me to log in or verify: stop and send only "LOGIN NEEDED: moodle".

1. Open https://learning.monash.edu/calendar/view.php?view=upcoming
2. For every event listed, write one line:
   UNIT CODE | title | type (assignment / quiz / exam / other) | due date and time exactly as shown | link
   Include everything in the next 4 weeks. If an event has a short description or weighting visible when you open it, add it after a " — ".
3. Also open https://learning.monash.edu/my/ and check the "Timeline" block (next 30 days) for anything missing from step 2, and add those lines too.
4. Hand it to Life:
   - With the Life connector: call capture_page with source "moodle", hint "deadlines", and the lines as text.
   - Otherwise open https://LIFE_DOMAIN/capture?source=moodle&kind=deadlines, paste the lines, and click "Send to Life".
5. Reply with how many deadlines you sent.
```
