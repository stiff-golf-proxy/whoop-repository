/* ============================================================
   WHOOP → LifePlatform proxy
   ------------------------------------------------------------
   A tiny Express server that:
     1. Holds your WHOOP client_id / client_secret (server-side only).
     2. Runs the OAuth2 authorization-code login flow.
     3. Stores the resulting tokens on disk, auto-refreshing them.
     4. Exposes simple JSON endpoints your LifePlatform.html calls.

   Your secret NEVER goes to the browser. The static file only ever
   talks to THIS server.

   ---- ONE-TIME SETUP -------------------------------------------------
   1. Create a WHOOP developer app:  https://developer.whoop.com
        - Add redirect URL:  http://localhost:3000/auth/callback
          (and your deployed URL's /auth/callback when you host it)
        - Copy the Client ID and Client Secret.
   2. In this folder:
        cp .env.example .env      # then fill in the values
        npm install
        npm start
   3. Visit  http://localhost:3000/auth/login  and approve access once.
   4. In LifePlatform → WHOOP → Connect proxy, set the proxy URL to
        http://localhost:3000   (or your deployed URL).
   5. Click "Sync now".

   ---- DEPLOYING (so it runs without your laptop on) ------------------
   Any Node host works (Render, Railway, Fly.io, a small VPS). Set the
   same env vars there, update the redirect URL in the WHOOP dashboard
   to <your-host>/auth/callback, log in once, done. For Vercel/Netlify
   you'd split these routes into serverless functions — same logic.
   ==================================================================== */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import 'dotenv/config';

const {
  WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET,
  REDIRECT_URI = 'http://localhost:3000/auth/callback',
  ALLOW_ORIGIN = '*',
  PORT = 3000
} = process.env;

const AUTH = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer';
const SCOPES = ['read:recovery','read:cycles','read:workout','read:sleep','read:profile','offline'].join(' ');
const TOKEN_FILE = './tokens.json';

const app = express();
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json());

// Token persistence. Locally we use a file. On an ephemeral host (Railway/Render)
// the file is wiped on redeploy, so we ALSO seed from WHOOP_REFRESH_TOKEN env var
// and log the refresh token after login so you can paste it into the host's env.
let tokens = null;
try { if (fs.existsSync(TOKEN_FILE)) tokens = JSON.parse(fs.readFileSync(TOKEN_FILE)); } catch (e) {}
if (!tokens && process.env.WHOOP_REFRESH_TOKEN) {
  tokens = { refresh_token: process.env.WHOOP_REFRESH_TOKEN, access_token: null, expires_in: 0, obtained_at: 0 };
  console.log('[TOKENS] Seeded refresh token from environment.');
}
const saveTokens = t => {
  tokens = t;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); } catch (e) { /* read-only FS on host: fine */ }
  if (t && t.refresh_token) {
    console.log('[TOKENS] New refresh token (save as WHOOP_REFRESH_TOKEN env var to persist across restarts):');
    console.log('[TOKENS] ' + t.refresh_token);
  }
};

/* ---- OAuth: step 1, send the user to WHOOP ---- */
app.get('/auth/login', (req, res) => {
  console.log('\n[LOGIN] redirect_uri =', REDIRECT_URI);
  console.log('[LOGIN] scopes       =', SCOPES);
  const url = new URL(AUTH);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', WHOOP_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', Math.random().toString(36).slice(2));
  res.redirect(url.toString());
});

/* ---- OAuth: step 2, exchange the code for tokens ---- */
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error: cbErr, error_description } = req.query;
    if (cbErr) { console.log('[CALLBACK] WHOOP returned error:', cbErr, error_description); throw new Error('WHOOP sent error: ' + cbErr + ' — ' + (error_description||'')); }
    console.log('\n[CALLBACK] code received:', code ? code.slice(0,8)+'… (len '+code.length+')' : 'MISSING');
    console.log('[CALLBACK] exchanging with redirect_uri =', REDIRECT_URI);
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT_URI,
      client_id: WHOOP_CLIENT_ID, client_secret: WHOOP_CLIENT_SECRET
    });
    const r = await fetch(TOKEN, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    const text = await r.text();
    console.log('[CALLBACK] WHOOP token response status:', r.status);
    console.log('[CALLBACK] WHOOP token response body  :', text);
    if (!r.ok) throw new Error('token exchange failed: ' + text);
    const t = JSON.parse(text);
    t.obtained_at = Date.now();
    saveTokens(t);
    res.send('<h2>WHOOP connected ✓</h2><p>You can close this tab and return to your LifePlatform.</p>');
  } catch (e) { console.log('[CALLBACK] FAILED:', e.message); res.status(500).send(e.message); }
});

/* ---- keep the access token fresh ---- */
async function freshToken() {
  if (!tokens) throw new Error('Not authenticated — visit /auth/login first');
  const ageSec = (Date.now() - tokens.obtained_at) / 1000;
  if (ageSec < (tokens.expires_in - 120)) return tokens.access_token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    client_id: WHOOP_CLIENT_ID, client_secret: WHOOP_CLIENT_SECRET, scope: SCOPES
  });
  const r = await fetch(TOKEN, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  if (!r.ok) throw new Error('token refresh failed: ' + await r.text());
  const t = await r.json(); t.obtained_at = Date.now();
  if (!t.refresh_token) t.refresh_token = tokens.refresh_token;
  saveTokens(t);
  return t.access_token;
}

/* ---- page through a WHOOP collection within a day window ---- */
async function collect(path, days) {
  const token = await freshToken();
  const start = new Date(Date.now() - days * 86400000).toISOString();
  let out = [], nextToken = null, pages = 0;
  do {
    const url = new URL(API + path);
    url.searchParams.set('limit', '25');
    url.searchParams.set('start', start);
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    out = out.concat(j.records || []);
    nextToken = j.next_token;
  } while (nextToken && ++pages < 40);
  return out;
}

/* ---- mappers: raw WHOOP schema -> flat records the platform expects ---- */
const mapRecovery = r => ({ date:(r.created_at||'').slice(0,10), recovery:r.score?.recovery_score ?? null,
  hrv:r.score?.hrv_rmssd_milli ?? null, rhr:r.score?.resting_heart_rate ?? null,
  spo2:r.score?.spo2_percentage ?? null, skinTemp:r.score?.skin_temp_celsius ?? null });
const mapSleep = r => { const st=r.score?.stage_summary||{};
  return { date:(r.start||'').slice(0,10), performance:r.score?.sleep_performance_percentage ?? null,
    efficiency:r.score?.sleep_efficiency_percentage ?? null, consistency:r.score?.sleep_consistency_percentage ?? null,
    durationMs:(st.total_in_bed_time_milli||0)-(st.total_awake_time_milli||0),
    remMs:st.total_rem_sleep_time_milli ?? null, swsMs:st.total_slow_wave_sleep_time_milli ?? null,
    lightMs:st.total_light_sleep_time_milli ?? null, awakeMs:st.total_awake_time_milli ?? null,
    respRate:r.score?.respiratory_rate ?? null, disturbances:st.disturbance_count ?? null, nap:r.nap }; };
const mapWorkout = r => ({ date:(r.start||'').slice(0,10), sport:r.sport_name||'workout', strain:r.score?.strain ?? null,
  avgHr:r.score?.average_heart_rate ?? null, maxHr:r.score?.max_heart_rate ?? null, kilojoule:r.score?.kilojoule ?? null,
  distanceM:r.score?.distance_meter ?? null, durationMs:(r.start&&r.end)?(new Date(r.end)-new Date(r.start)):null });
const mapCycle = r => ({ date:(r.start||'').slice(0,10), strain:r.score?.strain ?? null,
  avgHr:r.score?.average_heart_rate ?? null, maxHr:r.score?.max_heart_rate ?? null, kilojoule:r.score?.kilojoule ?? null });

const handler = (path, mapper) => async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const recs = await collect(path, days);
    res.json(recs.map(mapper));
  } catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/whoop/recovery',  handler('/v2/recovery', mapRecovery));
app.get('/whoop/sleep',     handler('/v2/activity/sleep', mapSleep));
app.get('/whoop/workouts',  handler('/v2/activity/workout', mapWorkout));
app.get('/whoop/cycles',    handler('/v2/cycle', mapCycle));
app.get('/whoop/profile', async (req, res) => {
  try {
    const token = await freshToken();
    const [p, b] = await Promise.all([
      fetch(API + '/v2/user/profile/basic', { headers:{Authorization:'Bearer '+token} }).then(r=>r.json()),
      fetch(API + '/v2/user/measurement/body', { headers:{Authorization:'Bearer '+token} }).then(r=>r.ok?r.json():{})
    ]);
    res.json({ firstName:p.first_name, lastName:p.last_name, heightM:b.height_meter, weightKg:b.weight_kilogram, maxHr:b.max_heart_rate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   MORNING REPORT routes — news, traffic, calendar
   These power the LifePlatform landing page. Each is optional:
   the page degrades gracefully if a route is missing or a key
   is not set. Add the relevant env vars to switch each one on.
   ============================================================ */

/* ---- BBC News (RSS → JSON). No key needed. ----
   feed=bbc (default) | world | technology | business | sport  */
const BBC_FEEDS = {
  bbc:        'https://feeds.bbci.co.uk/news/rss.xml',
  world:      'https://feeds.bbci.co.uk/news/world/rss.xml',
  technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  business:   'https://feeds.bbci.co.uk/news/business/rss.xml',
  sport:      'https://feeds.bbci.co.uk/sport/rss.xml'
};
app.get('/news', async (req, res) => {
  try {
    const url = BBC_FEEDS[req.query.feed] || BBC_FEEDS.bbc;
    const xml = await fetch(url).then(r => r.text());
    // light, dependency-free RSS parse
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map(m => {
      const block = m[1];
      const pick = (tag) => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
        if (!r) return '';
        return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
      };
      const pub = pick('pubDate');
      return {
        title: pick('title'),
        link: pick('link'),
        pubDate: pub ? new Date(pub).toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' }) : ''
      };
    });
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Traffic / drive time. Needs GOOGLE_MAPS_KEY (Directions API). ----
   Returns live duration-in-traffic for from→to.  */
app.get('/traffic', async (req, res) => {
  try {
    const key = process.env.GOOGLE_MAPS_KEY;
    if (!key) return res.status(501).json({ error: 'GOOGLE_MAPS_KEY not set' });
    const { from, to } = req.query;
    const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
    u.searchParams.set('origin', from);
    u.searchParams.set('destination', to);
    u.searchParams.set('departure_time', 'now');     // enables traffic-aware duration
    u.searchParams.set('key', key);
    const j = await fetch(u).then(r => r.json());
    const leg = j.routes?.[0]?.legs?.[0];
    if (!leg) return res.status(404).json({ error: 'no route', status: j.status });
    res.json({
      durationText: (leg.duration_in_traffic || leg.duration)?.text,
      normalText: leg.duration?.text,
      distanceText: leg.distance?.text
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Calendar (today's events). Uses the same Google OAuth tokens
   pattern as WHOOP, OR a simple read-only iCal URL via ICAL_URL. ----
   Simplest path: set ICAL_URL to a private .ics feed (Google Calendar
   → Settings → "Secret address in iCal format"). No OAuth needed.  */
app.get('/calendar', async (req, res) => {
  try {
    const ical = process.env.ICAL_URL;
    if (!ical) return res.status(501).json({ error: 'ICAL_URL not set' });
    const text = await fetch(ical).then(r => r.text());
    const today = new Date(); const y=today.getFullYear(), mo=String(today.getMonth()+1).padStart(2,'0'), d=String(today.getDate()).padStart(2,'0');
    const todayStr = `${y}${mo}${d}`;
    const events = [];
    for (const block of text.split('BEGIN:VEVENT').slice(1)) {
      const get = (k) => { const r = new RegExp(`${k}[^:]*:(.*)`).exec(block); return r ? r[1].trim() : ''; };
      const dtstart = get('DTSTART');
      if (!dtstart.startsWith(todayStr)) continue;          // only today
      const tm = dtstart.length >= 13 ? `${dtstart.slice(9,11)}:${dtstart.slice(11,13)}` : '';
      events.push({ time: tm, title: get('SUMMARY'), location: get('LOCATION') });
    }
    events.sort((a,b) => (a.time||'').localeCompare(b.time||''));
    res.json({ events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('LifePlatform proxy running. WHOOP authenticated: ' + (!!tokens) + '. Routes: /whoop/*, /news, /traffic, /calendar. Visit /auth/login to connect WHOOP.'));
app.listen(PORT, () => console.log(`LifePlatform proxy listening on port ${PORT}`));
