# Your to-dos (to keep development moving)

Only you can do these. I'll tick them off as we go.

**Never paste passwords, tokens, cookies or secret links into the chat.** Upload redacted files
instead: blur names and personal details (dates and times are fine). If I need a real key for
testing, I'll ask through the environment's secure credential form.

## Now

- [ ] **1. Humanforce pages** (5 min)
  Screenshots with names blurred of:
  - the **login page** at lunapark.humanforce.com
  - the **/Roster page**, showing where the **download** button is

  This lets me tune the auto-login to the real pages; it's built and tested against a lookalike.
  Don't send the password. You'll type it into Life's Settings once it's deployed.

- [ ] **2. Moodle** (5 min)
  - A blurred screenshot of Moodle → **Calendar → Upcoming events**, and one of an assignment's page.
  - Does Moodle stay logged in, in your Chrome, across days? (yes / no / asks every time)

- [ ] **3. Notion** (10 min)
  - Create an internal integration at notion.so/my-integrations.
  - On your team board: **••• → Connections →** add the integration.
  - Tell me the database's name, and what the column with "Executive Admin / Injection Moulder /
    Marketing" is called.
  - I'll then ask for the token through the **secure credential form**, so I can test against your
    real board.

- [ ] **4. Tamarin** (5 min + your admins)
  - Are you a Tamarin admin? If not, who is?
  - The change for Tamarin is ready on a local branch, `feat/webhook-mention-filter`. It adds an
    optional "Only messages about" user filter, so only messages that concern you leave the server.
    Its tests pass and nothing else changes. **OK for me to push it and open a PR on
    `monashautomation/discordbot` for your team to review?**
  - Which channels carry action items?

- [ ] **5. Monash timetable** (2 min)
  Check the bottom of the Allocate+ home page for **"subscribe to your timetable"**, or my.monash →
  *Monash calendar feeds*, and tell me if it's there. Don't send the link; it can contain a private
  token.

- [ ] **6. Server** (20 min, when you're ready to use it daily)
  - Sign up for **BinaryLane** (Melbourne, 4 GB) or one of the alternatives in the README.
  - Get a domain or subdomain.
  - I'll walk you through deploying. Onboarding runs then.

## Done
- [x] Humanforce link and roster sample: your `.ics` is now a test case, with times fixed to Melbourne time
- [x] Claude in Chrome available and DM screenshot: Instagram prompt tuned to your inbox
- [x] Notion: you can create integrations, and the board layout is understood (Cancelled, team tags, overdue items)
- [x] Monash Google allows outside apps
- [x] Example emails: Afterpay, AGL and VicRoads are now live test cases (all pass)
- [x] Engine: Pro plan, via `claude -p`
- [x] Your context: becomes the onboarding flow, which is built
