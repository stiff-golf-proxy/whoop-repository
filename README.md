# WHOOP → LifePlatform proxy (always-on / Railway)

Deploys to Railway from GitHub. Runs 24/7 so your laptop can be closed.

## Files
- `server.js` — the proxy (WHOOP OAuth + /whoop/* + /news /traffic /calendar)
- `package.json` — dependencies + start command
- `.gitignore` — keeps secrets out of git

## One-time deploy
1. Put these 3 files in a GitHub repo (see steps your assistant gave you).
2. On railway.app: New Project → Deploy from GitHub repo → pick the repo.
3. Railway builds and starts it automatically (`npm install` then `npm start`).
4. Add environment variables (Railway → your service → Variables):
   - WHOOP_CLIENT_ID      = your client id
   - WHOOP_CLIENT_SECRET  = your client secret
   - REDIRECT_URI         = https://YOUR-APP.up.railway.app/auth/callback
   - ALLOW_ORIGIN         = *
   (PORT is set by Railway automatically — do not set it.)
5. Generate a public domain (Railway → Settings → Networking → Generate Domain).
   Copy it, e.g. https://whoop-proxy-production.up.railway.app
6. Put that exact domain + /auth/callback into:
   - the REDIRECT_URI variable above
   - your WHOOP app's Redirect URLs (developer.whoop.com)
7. Visit  https://YOUR-APP.up.railway.app/auth/login  once, approve → "WHOOP connected".
8. In LifePlatform → WHOOP → Settings, set the proxy URL to your Railway domain.

## Keeping the login across restarts
After login the logs print a line:
   [TOKENS] <a long refresh token>
Copy that value into a new Railway variable:
   WHOOP_REFRESH_TOKEN = <that value>
Now redeploys/restarts stay logged in without you re-authorising.

## Keeping notifications alive across redeploys
Every phone subscription is welded to the VAPID public key it was created with.
If the proxy comes up holding a different keypair, Apple rejects every push with
a 403: the phone stays listed in `push-subs.json`, sends look like they worked,
and nothing arrives.

The keypair is read from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` if they are
set, otherwise from `vapid.json` in `DATA_DIR` — which is the container's own
disk unless a volume is mounted, so it is regenerated on every redeploy.

Pin it once and it never rotates again:
1. Look in the deploy log for the `[PUSH] WARNING keypair is NOT persistent` block —
   it prints the current public and private keys.
2. Add both as Railway variables:
   - VAPID_PUBLIC_KEY  = <the printed public key>
   - VAPID_PRIVATE_KEY = <the printed private key>
3. Redeploy, then re-enable notifications once on the phone (Coach →
   Re-register this device). Registrations made under the old key are shown as
   stale and the app re-subscribes itself next time it opens.

Mounting a Railway volume and setting `DATA_DIR` to its mount path achieves the
same thing, and also keeps reminders, WHOOP tokens and the userdata blob.

`GET /push/status` reports live vs stale devices, where the keypair came from,
whether it is persistent, and the outcome of the last send.

## The magazine (Read tab)
Each topic is a standing brief — a written instruction to an editor, not a
keyword. Once a day the proxy turns each brief into a small issue using Claude's
web search, and keeps the last issue in `magazine.json` on the volume so opening
the tab is instant.

- Topics are added, edited and removed from inside the app; nothing is
  hard-coded except the two it ships with (AI & Claude, Golf · mindset).
- `POST /magazine/refresh {id}` fetches a new issue on demand. One at a time.
- Auto-refresh runs from 05:00 local, one topic per 15-minute tick, for anything
  older than 20 hours.
- Titles already published to a shelf are remembered (last 60) so a refresh
  brings new reading rather than yesterday's list reordered.
- `MAG_MODEL` overrides the model used for editorial judgement.

Briefs work best when they say what to leave out as well as what to look for.

## Insurance (Cover tab)
Drop a policy schedule (PDF or photo) and the proxy extracts it into a structured
policy: insurer, period, premium and frequency, then one row per insured item
with its sum insured, basis, premium, excess and notes.

The split that matters: **the model reads the document, the app does the
arithmetic.** Every rate, total, median and comparison on the screen is computed
in the browser from the extracted figures, so a misread sum insured shows up as
a number you can see and correct rather than a confident sentence written around
it. Extracted values are editable before saving.

What it computes:
- Annual premium and monthly equivalent, annualising monthly/quarterly premiums.
- Sum insured split into asset cover and life/risk cover — never added together,
  because they are not the same kind of number.
- Rate per R1 000 of cover a year, per item and per category. Only shown where
  the schedule actually splits the premium per item; where it doesn't, the app
  says so rather than apportioning.
- Items priced above their own category median — comparison is against his own
  book, not an external table.
- Excess exposure, renewals inside 90 days, categories with no cover on file,
  and an aggregated list of what the schedules fail to state.

`POST /insurance/review` sends the computed figures plus the policy structure to
Claude for a written review — gaps, cost observations, questions for the broker.
The prompt states that the arithmetic is already done and that no new number may
be introduced.

`INSURANCE_MODEL` overrides the model. Policies live in `insurance.json` on the
volume, so they are not in the app's own backup file.

## Journal (Goals tab)
A dated journal sits behind the same password as the goals, in the same synced
blob. Entries carry a date, optional title, body, optional category and an
optional link to a goal; the view groups them by month, newest first, with
search across title, body and category.

Journal entries are **union-merged by id** on both sides of the sync
(`mergeUserdata` on the server, `_mergeLost` in the browser). The rest of the
goals blob is scalar — newest push wins — but an entry written on a phone must
not be erased by a later push from a laptop that never saw it. A push carrying
no goals key at all now leaves what is on disk alone rather than replacing it
with nothing.

## Notes
- Free tier may cold-start after idle; first request waits a few seconds.
- Never commit `.env` or `tokens.json` (the .gitignore handles this).
