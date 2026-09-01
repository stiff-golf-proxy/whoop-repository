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

## Expense claims (Expenses tab)
Two views. **Slips** is capture — photograph a till slip, say what it was for.
**Reconcile** is the claim, and it is driven by the statement rather than by
the slips: every line the bank charged is a row, and the question against each
is whether it is claimed and what backs it. That is the shape a claim gets
reviewed in, so it is the shape you edit.

### The sign is a fact about the layout, not the transaction
Matching used to find nothing on a real statement. The matcher skipped any
line that wasn't a positive amount, and the extractor had returned purchases
negative — which is how plenty of statements print them, since a purchase
makes a negative balance more negative. Every line was discarded before it was
ever compared.

Extraction now asks for the amount as printed and always positive, with a
separate `direction` of debit or credit decided from the column or the Cr
marker. Statements already on file are repaired on read: whichever sign the
bulk of the lines carry is taken as the debit sign, because a card statement
is overwhelmingly purchases. `signs corrected on import` on the statement says
when that happened.

### Matching, and why it says what it did
Amount closeness, date gap and merchant-name agreement against the statement
narrative, scored together, then assigned greedily — one slip per line, one
line per slip. A tip that makes the charge larger than the slip still matches
when the name agrees.

A run reports `exact / likely / possible / loose`, and every slip left loose
comes with the nearest line and what stopped it: *closest line is R 399.00,
353.4% out; that line is 50 days after the slip*. A screen that says 0 with no
way in is what this replaces.

### Fixing it by hand
Attach any slip to any line. The picker ranks by fit and annotates each slip
with what is off about it — `R 949.00 out · 9d later`, `same amount · same day
· name agrees` — with slips already spoken for sorted to the bottom rather
than hidden, because moving one is a legitimate correction. A hand-made match
is marked `manual` and re-running the matcher will not disturb it.

Per line you can also edit the purpose, exclude the line from the claim, or
record why there is no slip for it. Payments and credits are listed separately
and cannot be claimed.

### The pack
**Build claim pack** produces one PDF: a summary, the claim schedule, the
statement's own pages, then one page per slip captioned with the line it
supports. Photographs are re-encoded in the browser to 1100px at q0.55 before
they are ever uploaded — a twenty-slip claim at phone resolution is 60MB and
bounces off every mail server; this lands around 60KB a page.

Statements uploaded before this change have no PDF on file, so the pack says so
and carries the schedule alone. Re-upload the statement to get its pages in.

Line decisions live inside the statement and are **merged by recency** on both
sides of the sync (`mergeUserdata` on the server, `_mergeLost` in the browser) — an afternoon of reconciling on the laptop must not die the
next time the phone pushes. A slip's match merges the same way.

## What the coach is given
`buildCoachContext()` is the only builder, and it assembles four sections: the
About profile, the 3X4 DNA blueprint, blood results, and a live snapshot of
WHOOP, tasks and net worth.

Blood is the latest reading per marker with its reference range, an explicit
BELOW/ABOVE RANGE flag, and the previous reading so direction is visible — a
marker moving the wrong way inside its range says more than one sitting still
outside it.

There were, for a long time, **two** coach implementations in this file: ten
functions defined twice, and because function declarations hoist and the last
one wins, the older and thinner set was the one running. It sent WHOOP, tasks
and a net-worth line, and nothing else — so asking the coach about the DNA
report or the bloods produced a truthful "I can't see any", while the richer
builder sat above it as dead code. If you add a coach function, check it is not
already defined.

## Cropping a slip
Drag a box over the photograph and everything outside it is discarded. Crop
before saving, from the add-slip sheet, and the extractor reads the tighter
frame — usually the difference between a slip that reads badly and one that
reads clean. Slips already on file can be cropped in place: same id, same
match, new image.

The cut is always taken from the pixels handed to the cropper, so cropping
twice does not compound the JPEG loss.

## Capture from the Back Tap
Two taps on the back of the phone, speak, done — the app never opens.

An iOS Shortcut (Dictate Text → Get Contents of URL) posts to `POST /capture`
with a shared token. The words are interpreted into a task if they look like
one, queued in `capture-inbox.json`, and the app drains the inbox on its next
sync and acknowledges only what it took.

Captures land in the **Inbox** unless the words name one of your projects, in
which case they are filed there — the whole project name, or a distinctive word
of four letters or more from it. Anything less certain stays in the Inbox: a
thought spoken at a traffic light carries no project with it, and filing it
somewhere wrong is worse than filing it nowhere. A Shortcut can also name a
project outright by posting a `project` field, which wins over the guess; an
unrecognised name falls back to the Inbox rather than failing.

Whatever lands in the Inbox carries a **file** button, which opens the project
list directly. Moving a task was previously only possible by knowing that
tapping its words opened an edit sheet with a project dropdown inside — fine
when the Inbox held the odd stray, not fine once every capture lands there.

Nothing is written into the userdata blob from the server side — the browser
owns that file and two writers would race. `Tasks → Back Tap` shows the recipe
with the real URL and token filled in.

The token is generated once and kept on the volume, or set `CAPTURE_TOKEN`.
`/capture`, `/capture/inbox` and `/capture/inbox/ack` authenticate on it rather
than the session cookie, because a Shortcut has no cookie jar; they are matched
on the **exact** path, never by prefix, so `/capture/token` — which hands the
secret out — stays behind the session like everything else.

If interpretation fails, the capture is still kept. Losing a thought because a
model was unavailable would defeat the point of the feature.

## Tasks resolve by recency, not by existence
Merging tasks by id alone preserved whether a task existed and nothing else. A
task present on both devices was left exactly as the local copy had it, so
every field change made elsewhere — ticked done, re-prioritised, given a due
date, filed into a project — was discarded whenever the local copy happened to
be the newer of the two. Tick it on the phone, open the laptop, and the laptop
pushed its own un-ticked copy back over it.

Deletion had the mirror problem: a union can only add, so a task deleted on one
device was restored by the other.

Now every mutation stamps `updatedAt`; a task on both sides resolves to the
newer stamp (`updatedAt`, else `doneAt`, else `createdAt`); and a deletion
leaves a tombstone in `morning.deletedTasks` that outranks any copy older than
itself — while an edit made *after* the delete still wins, so the two orderings
are distinguishable. Tombstones are pruned at 90 days. Projects merge the same
way, so a rename sticks.

Tasks ticked before this change heal themselves: `doneAt` is later than
`createdAt`, so the ticked copy already outranks the un-ticked one.

## Notes on a task, and the knowledge they build
A task is a line of text; what you know about it is everything you said while
doing it. Notes hang off the task, carry their date, and survive the task being
ticked off — so `Tasks → Knowledge` searches everything ever said, across open
and completed work.

The note box is a plain textarea on purpose. Wispr Flow, iOS dictation and a
keyboard all write into it identically, so the best transcription available is
always usable without integrating with any of them. **Record** is the
hands-full fallback: it captures audio, sends it to `/voice` with `raw: true`
for the words alone rather than an interpretation, and drops them in the same
box to be corrected before anything is saved. Audio lives on the volume under
`note-audio/`, never in the synced blob — the same rule the slip photographs
follow.

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
