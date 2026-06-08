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

// ---- DURABLE TOKEN STORAGE (the fix for the HTTP 500 on sync) -------------
// WHOOP refresh tokens are SINGLE-USE: every refresh returns a brand-new refresh
// token and invalidates the old one. Railway/Render filesystems are EPHEMERAL —
// wiped on every redeploy/restart — so writing tokens.json to the project root
// loses the rotated token, and the static WHOOP_REFRESH_TOKEN env seed gets burned
// after the first refresh. The next restart then reuses a dead token => HTTP 500.
//
// Fix: write tokens to a MOUNTED PERSISTENT VOLUME. On Railway, attach a volume
// and it exposes RAILWAY_VOLUME_MOUNT_PATH (e.g. /data); we store tokens there so
// the rotated refresh token survives restarts and the proxy self-maintains.
const DATA_DIR = (process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '.').replace(/\/+$/, '');
const TOKEN_FILE = process.env.TOKEN_FILE || (DATA_DIR + '/tokens.json');

const app = express();
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json());

// Token persistence. Tokens are read from (and rotated tokens written back to)
// TOKEN_FILE — point this at a persistent volume on a host (see above). The static
// WHOOP_REFRESH_TOKEN env var is only a FIRST-BOOT seed; once a real refresh happens
// the rotated token is saved to the volume and used from then on.
let tokens = null;
let tokenSource = 'none';
try {
  if (fs.existsSync(TOKEN_FILE)) { tokens = JSON.parse(fs.readFileSync(TOKEN_FILE)); tokenSource = 'volume file (' + TOKEN_FILE + ')'; }
} catch (e) { console.log('[TOKENS] could not read', TOKEN_FILE, '-', e.message); }
if (!tokens && process.env.WHOOP_REFRESH_TOKEN) {
  tokens = { refresh_token: process.env.WHOOP_REFRESH_TOKEN, access_token: null, expires_in: 0, obtained_at: 0 };
  tokenSource = 'WHOOP_REFRESH_TOKEN env seed';
  console.log('[TOKENS] Seeded refresh token from environment (first boot).');
}
console.log('[TOKENS] storage =', TOKEN_FILE, '| source =', tokenSource);
const saveTokens = t => {
  tokens = t;
  try {
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
    console.log('[TOKENS] saved to', TOKEN_FILE);
  } catch (e) {
    // If this logs on every refresh, your storage is NOT persistent — tokens will be
    // lost on the next restart and sync will eventually 500. Attach a volume and set DATA_DIR.
    console.log('[TOKENS] WARNING could not persist tokens to', TOKEN_FILE, '-', e.message);
  }
  if (t && t.refresh_token) {
    console.log('[TOKENS] (backup) current refresh token:', t.refresh_token);
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
  if (!r.ok) {
    const detail = await r.text();
    // The usual cause here: the stored refresh token was already used once (WHOOP
    // rotates them) and storage isn't persistent, so we tried a dead token. Re-auth.
    throw new Error('token refresh failed (re-connect WHOOP at /auth/login, and make sure tokens are stored on a persistent volume): ' + detail);
  }
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
// Calendar storage: today's events are PUSHED here by the local macOS Calendar.app
// AppleScript sync (sync-calendar.sh) — a cloud proxy can't read Calendar.app itself.
// Events are stored on the persistent volume and served while fresh (<18h). If no
// pushed data exists, we fall back to an ICAL_URL feed when configured.
const CAL_FILE = DATA_DIR + '/calendar.json';
const CAL_TOKEN = process.env.CAL_INGEST_TOKEN || '';      // optional shared secret
const CAL_MAX_AGE_MS = 18 * 3600 * 1000;
function normEvents(list){
  return (Array.isArray(list) ? list : [])
    .map(e => ({ time: e.time || (e.start || '').slice(11,16) || '', title: e.title || e.summary || '', location: e.location || '' }))
    .filter(e => e.title)
    .sort((a,b) => (a.time||'').localeCompare(b.time||''));
}

// Local sync POSTs today's events here: { events:[{time,title,location}] }
app.post('/calendar', (req, res) => {
  try {
    if (CAL_TOKEN && req.get('x-cal-token') !== CAL_TOKEN) return res.status(401).json({ error: 'bad token' });
    const body = req.body || {};
    const events = normEvents(Array.isArray(body) ? body : (body.events || body.diary || []));
    const payload = { events, updatedAt: new Date().toISOString() };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CAL_FILE, JSON.stringify(payload));
    console.log(`[CALENDAR] stored ${events.length} events`);
    res.json({ ok: true, stored: events.length });
  } catch (e) { console.log('[CALENDAR] ingest failed', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/calendar', async (req, res) => {
  try {
    // 1) Fresh pushed events from the local Calendar.app sync (preferred)
    if (fs.existsSync(CAL_FILE)) {
      const j = JSON.parse(fs.readFileSync(CAL_FILE));
      if (j.updatedAt && (Date.now() - Date.parse(j.updatedAt)) < CAL_MAX_AGE_MS) {
        return res.json({ events: j.events || [], source: 'push' });
      }
    }
    // 2) Fallback: ICAL_URL feed if configured
    const ical = process.env.ICAL_URL;
    if (!ical) return res.json({ events: [] });            // nothing yet today (not an error)
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
    res.json({ events, source: 'ical' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   COACH — private life coach powered by the Claude (Anthropic) API.
   Needs ANTHROPIC_API_KEY. The frontend sends recent messages plus a
   compact personal snapshot (recovery, sleep, training, tasks, finances)
   so the advice is grounded. Model is configurable via COACH_MODEL.
   ============================================================ */
const COACH_MODEL = process.env.COACH_MODEL || 'claude-sonnet-4-6';
const COACH_SYSTEM = `You are Stuart's personal life coach, embedded in his private life dashboard.
You are warm, direct, and practical — a blend of an experienced performance coach and a thoughtful friend.
You have access to a live snapshot of his data (WHOOP recovery/sleep/strain, training, tasks, finances), provided below.

How you coach:
- Be specific and grounded: reference his actual numbers when relevant, don't speak in generalities.
- Be concise. Short paragraphs. Lead with the answer, then the why. Use **bold** sparingly for key points.
- Drive action: usually end with one clear, doable next step or a focused question.
- Respect that he is 54, runs and plays golf, and cares about longevity and a comfortable retirement.
- On training: balance ambition with recovery — when recovery is low, steer toward easier work; when it's high, encourage him to use it.
- You are not a doctor or a licensed financial advisor. For medical or specific investment decisions, give general guidance and suggest he consult a professional. Never give confident buy/sell calls.
- If he seems stressed or down, be supportive and human first, tactical second.
Keep replies focused — a few sentences to a short paragraph unless he asks for depth.`;

app.post('/coach', async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(501).json({ error: 'ANTHROPIC_API_KEY not set on the proxy' });
    const { messages = [], context = '' } = req.body || {};
    const clean = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!clean.length) return res.status(400).json({ error: 'no messages' });
    const system = COACH_SYSTEM + (context ? `\n\n--- Stuart's current snapshot ---\n${String(context).slice(0, 2000)}` : '');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: COACH_MODEL, max_tokens: 1024, system, messages: clean })
    });
    const text = await r.text();
    if (!r.ok) { console.log('[COACH] API error', r.status, text); return res.status(502).json({ error: `Claude API ${r.status}` }); }
    const j = JSON.parse(text);
    const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ reply: reply || '(no reply)' });
  } catch (e) { console.log('[COACH] failed', e.message); res.status(500).json({ error: e.message }); }
});

// Serve the LifePlatform dashboard itself at / and /app (same origin as the proxy,
// so the platform auto-detects this URL and CORS is a non-issue).
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_FILE = path.join(__dirname, 'LifePlatform.html');
function serveApp(req, res){
  if (fs.existsSync(APP_FILE)) return res.sendFile(APP_FILE);
  res.status(404).send('LifePlatform.html not found in the deploy. Upload it alongside server.js.');
}
app.get('/', serveApp);
app.get('/app', serveApp);
app.get('/status', (req, res) => {
  let persistent = false;
  try { if (DATA_DIR && DATA_DIR !== '.') { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); persistent = true; } } catch (e) {}
  res.json({
    proxy: 'LifePlatform',
    whoopAuthenticated: !!tokens,
    tokenStorage: TOKEN_FILE,
    persistentStorage: persistent,
    persistentStorageWarning: persistent ? undefined : 'Tokens are NOT on a persistent volume — they will be lost on the next restart and sync will 500. Attach a volume and set DATA_DIR.',
    calendar: (() => { try { if (fs.existsSync(CAL_FILE)) { const j = JSON.parse(fs.readFileSync(CAL_FILE)); const fresh = j.updatedAt && (Date.now() - Date.parse(j.updatedAt)) < CAL_MAX_AGE_MS; return `push (${(j.events||[]).length} events, ${fresh ? 'fresh' : 'stale — run sync'})`; } } catch (e) {} return process.env.ICAL_URL ? 'configured (ICAL_URL)' : 'waiting for first push (run sync-calendar.sh)'; })(),
    traffic: process.env.GOOGLE_MAPS_KEY ? 'configured (GOOGLE_MAPS_KEY)' : 'OFF — set GOOGLE_MAPS_KEY',
    coach: process.env.ANTHROPIC_API_KEY ? ('configured (' + COACH_MODEL + ')') : 'OFF — set ANTHROPIC_API_KEY',
    routes: ['/whoop/recovery','/whoop/sleep','/whoop/workouts','/whoop/cycles','/whoop/profile','/news','/traffic','/calendar'],
    connect: '/auth/login'
  });
});
app.listen(PORT, () => console.log(`LifePlatform proxy listening on port ${PORT}`));
