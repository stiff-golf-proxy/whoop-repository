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

## Notes
- Free tier may cold-start after idle; first request waits a few seconds.
- Never commit `.env` or `tokens.json` (the .gitignore handles this).
