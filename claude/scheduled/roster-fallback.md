# Weekly roster check: fallback (Claude in Chrome)

Use this only if Humanforce has no calendar link **and** the server's saved login keeps expiring
(for example, if your employer forces a fresh SSO/MFA login every time). The preferred options are:
1. Humanforce calendar link, added as a locked feed in Settings.
2. The server auto-pull (Settings → Auto-pulls, plus `pnpm --filter @life/server login-site humanforce`).

## Set up
Same as `instagram-dms.md`: Claude in Chrome in your Chrome, logged into Humanforce, Life opened
once. Create a shortcut with the prompt below and schedule it weekly.

## Prompt (replace HUMANFORCE_URL and LIFE_DOMAIN)

```
Weekly read-only roster check for my planning app, Life.

RULES: read only. Never click buttons that change anything (no accepting/swapping/declining shifts, no availability changes). If a login or security check appears, stop and send only "LOGIN NEEDED: humanforce".

1. Open HUMANFORCE_URL and go to my roster/shifts for the next 3 weeks.
2. Write every shift as one line: day, date, start–end time, location/role. Include "open"/"offered" shifts separately, marked OFFERED.
3. Hand it to Life:
   - With the Life connector: call capture_page with source "humanforce" and the lines as text.
   - Otherwise open https://LIFE_DOMAIN/capture?source=humanforce&kind=roster, paste the lines, click "Send to Life".
4. Reply with how many shifts you sent.
```
