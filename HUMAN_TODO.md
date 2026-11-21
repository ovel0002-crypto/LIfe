# Your to-dos (to keep development moving)

These are the things only you can do. I'll tick them off and update this list as we go.

**Never paste passwords, tokens, cookies or secret URLs into the chat.** Upload redacted files
instead (blur names and personal details; dates and times are fine). If I need a real key for
testing, I'll ask through the environment's secure credential form.

## Now: needed for what I'm building next

- [ ] **1. Humanforce: is there a calendar link?** (5 min)
  In the Humanforce app or website, look for *Calendar sync*, *Add to calendar*, *Subscribe* or *iCal*
  (usually under Profile/Settings or on the roster page). Tell me **yes or no**.
  - If yes, I just add it as a locked calendar feed. That's the most reliable option.
  - If no, send me:
    - the portal address, domain only (e.g. `yourworkplace.humanforce.com`)
    - a screenshot of the roster/shifts page with names blurred
    - how you log in (password? SSO through your employer? a code by SMS or app?)

- [ ] **2. A roster sample** (5 min)
  A redacted screenshot, PDF or email of your roster as you normally get it. It becomes a test case.

- [ ] **3. Claude Desktop + Claude in Chrome on your PC** (10 min)
  - Install Claude Desktop if you don't have it.
  - Check whether **Claude in Chrome** is available on your Pro account.
  - Screenshot the Settings → Connectors page and tell me what you see.
  - Send a redacted screenshot of your Instagram **DM inbox on desktop web** (instagram.com/direct/inbox).
    I'll tune the weekly read-only prompt to its layout.

- [ ] **4. Moodle calendar file** (3 min)
  Moodle → Calendar → *Import or export calendars* → *Export calendar* → *All courses*,
  *Recent and next 60 days* → **Export** (download the `.ics` file, **not** the URL), then upload it.
  The URL has a private token in it; the file is safe to share. I'll tune Monash deadline parsing against it.

- [ ] **5. Timetable file** (3 min)
  Export your Monash timetable as `.ics` and upload it.

- [ ] **6. Notion** (5 min)
  - Tell me whether you're a workspace owner, or allowed to create an integration.
  - Send a screenshot of the action-items database's **column headers** (title, assignee, status, due,
    project, whatever they're called).

- [ ] **7. Discord** (5 min + waiting on your admin)
  - Ask your team's server admin whether they're OK inviting a **read-only** bot.
  - Tell me the names of the channels where action items get discussed.

- [ ] **8. Monash Google** (2 min)
  Try myaccount.google.com with your Monash account → *Security* → *Third-party apps & services*,
  or just tell me if you've ever used "Sign in with Google" on an outside app with your Monash
  account. That decides between direct access and a forwarding filter.

- [ ] **9. Your real context** (15 min, in chat, plain words)
  - Your personal projects: what stage each is at, and what "done" looks like.
  - This semester's units.
  - A typical week: classes, usual shift days/hours, gym, regular social things.
  - When you like to start and stop work, and your quiet hours.
  - When you focus best (morning / afternoon / night).

- [ ] **10. Example emails** (5 min)
  Two or three redacted examples of emails you'd want caught: a Moodle notification, a
  group-project email, a social invite.

## Soon: needed before you use it day to day

- [ ] **11. Decide where it runs and what pays for AI**
  - Pick a small VPS (e.g. Hetzner CX22, ~€4/mo) and a domain or subdomain.
  - Either: an Anthropic API key with a spend limit set in the Console,
    or: use your Pro plan by running `claude login` on the server (`LIFE_LLM_PROVIDER=claude-cli`).

## Done
_(nothing yet)_
