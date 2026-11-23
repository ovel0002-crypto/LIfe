# Weekly Instagram DM check (Claude in Chrome)

**Where it runs:** the Claude in Chrome extension in *your* Google Chrome, where you're already
logged into Instagram. Nothing runs on the server and no Instagram password is stored anywhere.

**Risk:** automated reading isn't allowed by Instagram's terms. Running it once a week, read-only,
in your normal browser keeps the chance of a lock low, but it isn't zero.

## Set up (once)
1. Install **Claude in Chrome** from the Chrome Web Store, sign in, and pin it.
2. In that Chrome, log into instagram.com, and open your Life app once (`https://LIFE_DOMAIN`) so
   your Life token is saved there (Settings → Server).
3. Optional: add Life as a connector (claude.ai → Customize → Connectors → + Add → Add custom
   connector, URL `https://LIFE_DOMAIN/mcp`, Request header `Authorization: Bearer <LIFE_API_TOKEN>`).
   If the Chrome run can use connectors it will call Life directly; if not, it uses the capture page.
4. Open the Claude in Chrome panel → create a shortcut with the prompt below → click the clock icon
   and schedule it **weekly** (e.g. Sunday 3pm, before your weekly admin hour).
5. Run it once by hand and check the result in Life → Inbox.

## Prompt (paste this into the shortcut; replace LIFE_DOMAIN)

```
Weekly read-only Instagram check for my planning app, Life.

RULES — follow exactly:
- READ ONLY. Never type in Instagram, never send/reply/react/like/follow/accept/delete, never click buttons that change anything. Only open pages, scroll, and open conversations to read them.
- Open at most 25 conversations. Don't refresh repeatedly.
- If Instagram shows a login page, a "suspicious activity"/checkpoint/captcha, or asks to confirm it's me: STOP. Go to step 4 and write only "LOGIN NEEDED: instagram".

STEPS
1. Go to https://www.instagram.com/direct/inbox/. The list on the left shows each chat with "N new messages" or the last message and how long ago (e.g. "28m", "8h", "3d"). Group chats show their name (e.g. a birthday or event chat).
2. Open each chat that has new messages or activity in the last 7 days (newest first, at most 25). Scroll up inside a chat only far enough to cover the last 7 days. Glance at the "Requests" tab too, but never accept anything.
3. Note only what matters for my plans: invitations and plans (who, what, when, where), questions someone asked me, things I said I'd do, changes or cancellations, dates and deadlines. Skip memes, reels and small talk. Keep dates/times exactly as shown, with sender first names.
4. Hand it to Life:
   - If you have the Life connector, call its capture_messages tool once with source "instagram" and the messages.
   - Otherwise open https://LIFE_DOMAIN/capture?source=instagram, paste your notes into the box (one message per line, like "[Jess] (Sat 3:12pm) bbq at mine sat arvo?"), and click "Send to Life". Typing into Life's own page is fine.
5. Reply with a one-line summary of what you sent.
```
