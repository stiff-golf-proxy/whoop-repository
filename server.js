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
import crypto from 'crypto';
import webpush from 'web-push';
import 'dotenv/config';
import { mountMail } from './mail.js';

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
app.use(express.json({ limit: '60mb' })); // userdata blob + vision images + reference-swing frames are far larger than the 100kb default
app.use(express.urlencoded({ extended: false })); // login form posts

/* ===================================================================
   LOGIN GATE
   A single shared password protects the app, family dashboard and the
   userdata blob. On success we set a signed, HttpOnly session cookie
   (HMAC over an expiry timestamp) so no server-side session store is
   needed and it survives restarts. The password is read from the
   APP_PASSWORD env var; the signing key from SESSION_SECRET (falls back
   to a derived key so a missing secret never locks Stuart out, though
   setting SESSION_SECRET is strongly recommended).
   =================================================================== */
const APP_PASSWORD   = process.env.APP_PASSWORD || 'stiff-golf-2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('lp::' + APP_PASSWORD).digest('hex');
const SESSION_DAYS   = 30;
const COOKIE_NAME    = 'lp_session';

const signSession = (expMs) => {
  const payload = String(expMs);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
};
const verifySession = (val) => {
  if (!val || typeof val !== 'string' || !val.includes('.')) return false;
  const [payload, sig] = val.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(payload) > Date.now();
};
const parseCookies = (req) => {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
};
const isAuthed = (req) => verifySession(parseCookies(req)[COOKIE_NAME]);

const loginPage = (err) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sign in · Life</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Libre Franklin',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#eef4f3;color:#15302f;
  background-image:radial-gradient(1200px 600px at 100% 0%,rgba(10,138,150,.17),transparent 55%),radial-gradient(900px 700px at 0% 100%,rgba(31,155,88,.15),transparent 52%);}
.box{background:#fbfdfd;border:1px solid #d2e2e0;border-radius:18px;padding:40px 36px;width:100%;max-width:380px;
  box-shadow:0 4px 12px rgba(12,60,58,.08),0 20px 50px rgba(14,90,95,.16)}
.lbl{font-family:'Spline Sans Mono',monospace;font-size:11px;letter-spacing:.5px;color:#6f8a88;text-transform:uppercase;margin-bottom:6px}
h1{font-size:24px;font-weight:700;letter-spacing:-.3px;margin-bottom:24px}
input{width:100%;font-family:inherit;font-size:16px;padding:12px 14px;border:1px solid #b6cecb;border-radius:11px;background:#eef4f3;color:#15302f;margin-bottom:14px}
input:focus{outline:none;border-color:#0a8a96}
button{width:100%;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;padding:12px;border:none;border-radius:11px;background:#0a8a96;color:#fff;transition:.18s}
button:hover{background:#055058}
.err{color:#cb463c;font-size:13px;margin-bottom:14px}
</style></head><body>
<form class="box" method="POST" action="/login">
  <div class="lbl">Stuart Harris</div>
  <h1>Life Platform</h1>
  ${err ? '<div class="err">Incorrect password. Try again.</div>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <input type="hidden" name="next" value="${err && err.next ? err.next : '/'}">
  <button type="submit">Sign in</button>
</form></body></html>`;

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.set('Content-Type', 'text/html').send(loginPage(false));
});

app.post('/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  const next = (req.body && typeof req.body.next === 'string' && req.body.next.startsWith('/')) ? req.body.next : '/';
  const ok = pw.length === APP_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
  if (!ok) return res.status(401).set('Content-Type', 'text/html').send(loginPage({ next }));
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE_NAME}=${signSession(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.redirect(next);
});

app.get('/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// Gate protected routes. WHOOP OAuth callback + the login routes stay open so the
// auth handshake and sign-in page work; everything else requires a valid session.
// The manifest, service worker and icons must resolve before there's a session —
// iOS won't treat the site as installable otherwise. None of them carry any data.
// Everything that touches subscriptions or reminders stays behind the session.
const OPEN_PREFIXES = ['/login', '/logout', '/auth/', '/status',
                       '/manifest.webmanifest', '/sw.js', '/icon-', '/apple-touch-icon.png'];
app.use((req, res, next) => {
  if (OPEN_PREFIXES.some(p => req.path === p || req.path.startsWith(p))) return next();
  if (isAuthed(req)) return next();
  // Browsers navigating to a page get the login screen; API/XHR callers get 401.
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml) return res.status(401).set('Content-Type', 'text/html').send(loginPage({ next: req.originalUrl }));
  return res.status(401).json({ error: 'unauthorized' });
});

mountMail(app, { DATA_DIR });

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
// WHOOP refresh tokens are SINGLE-USE. The dashboard calls several /whoop/*
// endpoints in parallel; if each triggered its own refresh with the same token,
// the first would win and WHOOP's reuse detection would revoke the rest —
// breaking sync until a manual re-login. So all concurrent callers share ONE
// in-flight refresh via this promise lock.
let _refreshing = null;
async function freshToken() {
  if (!tokens) throw new Error('Not authenticated — visit /auth/login first');
  const ageSec = (Date.now() - tokens.obtained_at) / 1000;
  if (ageSec < (tokens.expires_in - 120)) return tokens.access_token;
  if (!_refreshing) _refreshing = _doRefresh().finally(() => { _refreshing = null; });
  return _refreshing;
}
async function _doRefresh() {
  // Re-check after acquiring the lock — another caller may have just refreshed.
  const ageSec = (Date.now() - tokens.obtained_at) / 1000;
  if (ageSec < (tokens.expires_in - 120)) return tokens.access_token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    client_id: WHOOP_CLIENT_ID, client_secret: WHOOP_CLIENT_SECRET,
    scope: 'offline' // per WHOOP spec, refresh requests use scope=offline (not the full list)
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
  sport:      'https://feeds.bbci.co.uk/sport/rss.xml',
  // AI for business — Google News RSS search (keyless), focused on efficiency/integration/automation
  ai:         'https://news.google.com/rss/search?q=' + encodeURIComponent('("artificial intelligence" OR "AI") (automation OR integration OR "business efficiency" OR enterprise OR workflow) when:7d') + '&hl=en-US&gl=US&ceid=US:en'
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

/* The coach can actually act, not just advise. Asking it in chat to "remind me
   at 5pm to practice golf" is the most natural way to set one, so it gets real
   tools rather than having to apologise that it can't. */
const COACH_TOOLS = [
  {
    name: 'set_reminder',
    description: 'Schedule a push notification to Stuart\'s phone. Use whenever he asks to be reminded, ' +
                 'nudged, or told about something at a time. Confirm what you set afterwards, in your own words.',
    input_schema: {
      type: 'object',
      properties: {
        text:   { type: 'string', description: 'What to remind him, in second person, e.g. "Practice golf"' },
        at:     { type: 'string', description: 'Local wall-clock time as YYYY-MM-DDTHH:MM. Resolve relative times against the current time given in your context.' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'], description: 'Defaults to none' }
      },
      required: ['text', 'at']
    }
  },
  {
    name: 'list_reminders',
    description: 'List Stuart\'s upcoming reminders. Use when he asks what is scheduled, or before changing something.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a scheduled reminder by its id. Call list_reminders first to find the id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The reminder id from list_reminders' } },
      required: ['id']
    }
  }
];

function runCoachTool(name, input) {
  try {
    if (name === 'set_reminder') {
      const at = localToInstant(input.at);
      if (!at) return { ok: false, error: 'Could not read that time. Use YYYY-MM-DDTHH:MM.' };
      const rems = readRems();
      const rem = { id: 'rem' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: String(input.text || '').slice(0, 400), at, repeat: input.repeat || 'none',
        source: 'coach', done: false, firedAt: null, createdAt: new Date().toISOString() };
      rems.push(rem); writeRems(rems);
      const devices = readSubs().length;
      return { ok: true, id: rem.id, firesAtLocal: input.at, repeat: rem.repeat,
        // tell the model the truth about delivery so it doesn't over-promise
        note: devices ? 'Will push to ' + devices + ' registered device(s).'
                      : 'Saved, but NO device is registered for notifications yet — tell him to open Coach and tap Enable notifications, or it will only show in the app.' };
    }
    if (name === 'list_reminders') {
      return { reminders: readRems().filter(r => !r.done)
        .sort((a, b) => new Date(a.at) - new Date(b.at))
        .slice(0, 25)
        .map(r => ({ id: r.id, text: r.text, at: r.at, repeat: r.repeat })) };
    }
    if (name === 'cancel_reminder') {
      const rems = readRems();
      const i = rems.findIndex(r => r.id === input.id);
      if (i < 0) return { ok: false, error: 'No reminder with that id' };
      const [gone] = rems.splice(i, 1); writeRems(rems);
      return { ok: true, cancelled: gone.text };
    }
    return { ok: false, error: 'unknown tool' };
  } catch (e) { return { ok: false, error: e.message }; }
}

app.post('/coach', async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(501).json({ error: 'ANTHROPIC_API_KEY not set on the proxy' });
    const { messages = [], context = '' } = req.body || {};
    const clean = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))
      .slice(-16)
      .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 4000) : m.content }));
    if (!clean.length) return res.status(400).json({ error: 'no messages' });
    // The model needs the wall clock to turn "5pm" into a real instant.
    const nowLocal = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }).format(new Date());
    const system = COACH_SYSTEM
      + `\n\nIt is currently ${nowLocal} (${APP_TZ}). You can set, list and cancel reminders yourself using your tools — `
      + `never tell him to use his phone's clock or calendar app instead, and never say you are unable to send alerts. `
      + `Reminders you set are delivered as push notifications to his phone by this dashboard.`
      + (context ? `\n\n${String(context).slice(0, 5000)}` : '');

    const convo = clean.slice();
    let reply = '', used = [];
    // Tool loop, bounded: set -> confirm is 2 hops; the cap stops runaways.
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: COACH_MODEL, max_tokens: 1500, system, tools: COACH_TOOLS, messages: convo })
      });
      const text = await r.text();
      if (!r.ok) { console.log('[COACH] API error', r.status, text.slice(0, 300)); return res.status(502).json({ error: `Claude API ${r.status}` }); }
      const j = JSON.parse(text);
      reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (j.stop_reason !== 'tool_use') break;
      const calls = (j.content || []).filter(b => b.type === 'tool_use');
      convo.push({ role: 'assistant', content: j.content });
      convo.push({ role: 'user', content: calls.map(c => {
        const out = runCoachTool(c.name, c.input || {});
        used.push(c.name);
        console.log('[COACH] tool', c.name, JSON.stringify(out).slice(0, 160));
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) };
      }) });
    }
    res.json({ reply: reply || '(no reply)', toolsUsed: used });
  } catch (e) { console.log('[COACH] failed', e.message); res.status(500).json({ error: e.message }); }
});

/* ============================================================
   VISION — generic image analysis endpoint.
   POST /vision  { image: "<base64>", media_type: "image/jpeg", prompt: "..." }
   Returns { text: "..." }
   Used by the golf scorecard reader (and anything else needing vision).
   ============================================================ */
/* ============================================================
   SWING — golf swing video analysis. The client extracts evenly-spaced
   frames from the uploaded video (Claude can't take video directly) and
   POSTs them as an ordered sequence; the coach reviews them as a motion
   sequence and can answer follow-up questions in the same thread.
   POST /swing {
     frames: ["<base64 jpeg>", ...]   (first request only; ordered start->finish)
     media_type, messages: [{role,content}], view: "face-on"|"down-the-line"|"",
     handed: "right"|"left"
   }
   Returns { reply: "..." }
   ============================================================ */
const SWING_SYSTEM = COACH_SYSTEM + `

You are now reviewing Stuart's GOLF SWING from a video. The user message contains an ordered sequence of still frames sampled evenly from address through to finish — read them as one continuous motion, left-to-right, top-to-bottom.

Coaching the swing:
- Work through the positions in order: setup/address, takeaway, halfway back, top of backswing, transition, downswing, impact, release, finish.
- Call out 2-3 things working well, then the 1-2 highest-leverage faults — be specific about what you see in which frame (e.g. "by the top, the club crosses the line").
- Give a concrete feel or drill for each fault, prioritised. Lead with the single change that would help most.
- If frames are too blurry, dark, or the wrong angle to judge something, say so honestly rather than guessing.
- Note the camera angle matters: face-on shows weight shift, sway and low point; down-the-line shows swing plane and path. If you can't tell the angle, infer it.
- Keep it focused and actionable. After the first review, answer follow-ups conversationally, referring back to what you saw.`;

/* POST /swing/annotate
   Takes one frame (base64 JPEG) + position label. Claude vision identifies
   the golfer's key joints and returns the exact lines a coach would draw:
   spine angle, shoulder line, hip line, lead arm, club shaft. The client
   draws these on a canvas overlay so they appear directly on the user's photo.
   Returns: { lines:[{fromPct,toPct,color,label}], note:"", visible:bool } */
app.post('/swing/annotate', async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(501).json({ error: 'ANTHROPIC_API_KEY not set' });
    const { image, media_type = 'image/jpeg', position = 'swing' } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image required' });

    const prompt = `You are a PGA golf coach annotating a "${position}" frame for coaching analysis.

Look at this golf swing image carefully. Identify the golfer's body and draw the key coaching lines.

Return ONLY a raw JSON object (no markdown, no explanation):
{
  "visible": true,
  "lines": [
    {
      "fromPct": [x_percent, y_percent],
      "toPct": [x_percent, y_percent],
      "color": "#hex",
      "label": "short label",
      "dashed": true
    }
  ],
  "note": "1-2 sentence coaching observation about what you see at this position"
}

Coordinates are percentages from top-left of the image (0-100).
Draw EXACTLY these lines (skip any you cannot confidently locate):
- Spine angle (#3B82F6, dashed): from top of head through center of hips — shows forward tilt
- Shoulder line (#14B8A6, dashed): through both shoulders left-to-right — shows shoulder tilt/turn
- Hip line (#10B981, dashed): through both hips — shows hip rotation vs shoulder
- Lead arm (#EF4444, solid): from lead shoulder to grip — shows arm straightness
- Club shaft (#F97316, dashed): from grip to club head — shows shaft angle

If the golfer is not clearly visible, return {"visible":false,"lines":[],"note":"Golfer not clearly visible in this frame"}.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: COACH_MODEL, max_tokens: 700,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type, data: image } },
          { type: 'text', text: prompt }
        ]}]
      })
    });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: 'Claude API ' + r.status });
    const j = JSON.parse(text);
    const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
    if (start < 0) return res.status(500).json({ error: 'No annotation returned' });
    let ann;
    try { ann = JSON.parse(reply.slice(start, end + 1)); } catch (e) { return res.status(500).json({ error: 'Parse failed' }); }
    console.log(`[ANNOTATE] ${position}: ${(ann.lines||[]).length} lines drawn`);
    res.json(ann);
  } catch (e) { console.log('[ANNOTATE] failed', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/swing', async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(501).json({ error: 'ANTHROPIC_API_KEY not set on the proxy' });
    const { frames = [], media_type = 'image/jpeg', messages = [], view = '', handed = 'right' } = req.body || {};
    const history = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))
      .slice(-12);

    // Build the message list. When frames are supplied they anchor the FIRST
    // user turn (the visual evidence); the running text conversation follows.
    // The client resends frames each live turn (stateless API), so the model
    // always "sees" the swing. The first stored user note (if any) is folded
    // into that first turn; subsequent turns are appended verbatim.
    let apiMessages;
    if (Array.isArray(frames) && frames.length) {
      const clipped = frames.slice(0, 12); // payload / token budget cap
      const angle = view ? `Camera angle: ${view}. ` : '';
      const intro = `${angle}Golfer is ${handed}-handed. Here are ${clipped.length} frames of my golf swing in order from address to finish.`;
      const content = [{ type: 'text', text: intro }];
      clipped.forEach((f, i) => {
        content.push({ type: 'text', text: `Frame ${i + 1}/${clipped.length}` });
        content.push({ type: 'image', source: { type: 'base64', media_type, data: f } });
      });
      // fold the first user text turn (e.g. "This is my 7-iron") into the frame turn
      const firstUser = history.find(m => m.role === 'user' && typeof m.content === 'string');
      if (firstUser && firstUser.content.trim()) content.push({ type: 'text', text: firstUser.content.slice(0, 1000) });
      content.push({ type: 'text', text: 'Please review it, or answer my latest question below if there is one.' });
      apiMessages = [{ role: 'user', content }];
      // append everything AFTER that first user turn (assistant replies + later questions)
      const firstIdx = firstUser ? history.indexOf(firstUser) : -1;
      const rest = history.filter((m, i) => i > firstIdx);
      rest.forEach(m => apiMessages.push({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 4000) : m.content }));
      // API requires the conversation to end on a user turn; if it ends on assistant, that's the
      // pending review request already covered by the frame turn — drop a trailing assistant.
      while (apiMessages.length > 1 && apiMessages[apiMessages.length - 1].role === 'assistant') apiMessages.pop();
    } else {
      // follow-up against a saved review (no frames in memory): text only
      if (!history.length) return res.status(400).json({ error: 'no frames and no messages' });
      apiMessages = history.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 4000) : m.content }));
      while (apiMessages.length > 1 && apiMessages[apiMessages.length - 1].role === 'assistant') apiMessages.pop();
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: COACH_MODEL, max_tokens: 1500, system: SWING_SYSTEM, messages: apiMessages })
    });
    const text = await r.text();
    if (!r.ok) { console.log('[SWING] API error', r.status, text.slice(0, 300)); return res.status(502).json({ error: `Claude API ${r.status}` }); }
    const j = JSON.parse(text);
    const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    console.log(`[SWING] reviewed (${(frames || []).length} frames, ${history.length} prior turns)`);
    res.json({ reply: reply || '(no reply)' });
  } catch (e) { console.log('[SWING] failed', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/vision', async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(501).json({ error: 'ANTHROPIC_API_KEY not set on the proxy' });
    const { image, media_type = 'image/jpeg', prompt = '' } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image field required (base64)' });
    if (!prompt) return res.status(400).json({ error: 'prompt field required' });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: COACH_MODEL,
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });
    const text = await r.text();
    if (!r.ok) { console.log('[VISION] API error', r.status, text); return res.status(502).json({ error: `Claude API ${r.status}` }); }
    const j = JSON.parse(text);
    const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ text: reply });
  } catch (e) { console.log('[VISION] failed', e.message); res.status(500).json({ error: e.message }); }
});

/* ============================================================
   KENTRIDGE WATCH — a weekly scheduled task scours SA sites for
   William Kentridge artworks for sale and POSTs the listings here.
   Stored on the volume; the dashboard reads GET /kentridge.
   ============================================================ */
const KENT_FILE = DATA_DIR + '/kentridge.json';
app.post('/kentridge', (req, res) => {
  try {
    if (CAL_TOKEN && req.get('x-cal-token') !== CAL_TOKEN) return res.status(401).json({ error: 'bad token' });
    const body = req.body || {};
    const listings = (Array.isArray(body) ? body : (body.listings || []))
      .map(x => ({ title: x.title || '', source: x.source || '', price: x.price || '', url: x.url || '', medium: x.medium || '', note: x.note || '' }))
      .filter(x => x.title);
    const payload = { listings, updatedAt: new Date().toISOString() };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KENT_FILE, JSON.stringify(payload));
    console.log(`[KENTRIDGE] stored ${listings.length} listings`);
    res.json({ ok: true, stored: listings.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/kentridge', (req, res) => {
  try {
    if (fs.existsSync(KENT_FILE)) return res.json(JSON.parse(fs.readFileSync(KENT_FILE)));
  } catch (e) {}
  res.json({ listings: [], updatedAt: null });
});

/* ============================================================
   PORTFOLIO INTELLIGENCE — a weekly research task compiles tailored,
   insight-led items (mostly AI, plus market/industry intel) for the
   Gerber portfolio and POSTs them here. Dashboard reads GET /research.
   ============================================================ */
const RES_FILE = DATA_DIR + '/research.json';

/* ============================================================
   SCENARIO PLANNER — expert forecast of how AI progress reshapes
   Stuart's personal and Gerber (GGG) work life. Toggles between two
   contexts; runs an on-demand web-search deep dive; returns LOW /
   MEDIUM / HIGH AI-progress scenarios, each with the top 5 outcomes
   at 1, 2.5 and 5 year horizons. Each outcome blends an
   opportunity/threat read, the concrete predicted state, a
   recommended action, and a quantified impact.
   Files on the volume:  scenario-profiles.json (editable briefs),
   scenario-personal.json / scenario-gerber.json (last forecasts).
   ============================================================ */
const SCEN_PROFILES_FILE = DATA_DIR + '/scenario-profiles.json';
const SCEN_FILE = ctx => DATA_DIR + '/scenario-' + (ctx === 'gerber' ? 'gerber' : 'personal') + '.json';
const SCEN_RUNNING = { personal: 0, gerber: 0 }; // timestamp of run start, 0 = not running
function scenRunning(ctx){ return SCEN_RUNNING[ctx] && (Date.now()-SCEN_RUNNING[ctx] < 90000); }

const SCEN_DEFAULT_PROFILES = {
  personal: `Stuart Harris is a Cape Town-based investment principal in his late 40s. He holds stakes in GGG Holdings (an investment group owning ~20 South African traditional businesses in trading, distribution and manufacturing) and manages the SBH Family Trust with a four-property portfolio and personal pension/RA assets. His daily work is portfolio oversight of traditional businesses, financial performance analysis, board participation, and family wealth management — NOT institutional PE, NOT fundraising, NOT tech investing. He built this AI dashboard himself and uses AI tools daily. Forecast concretely how AI reshapes: (a) the value of his analytical and oversight skills as an investor in traditional businesses, (b) how he spends his working time on portfolio monitoring and board work, (c) his personal productivity and decision-making, (d) the economic environment and asset values he holds, (e) the risk to his relevance when AI can do much of what he does. Be specific — name actual things he does, not generic "AI will disrupt investing" statements.`,
  gerber: `Gerber Goldschmidt Group (GGG, gerber.co.za) is a Cape Town investment holding company with ~20 TRADITIONAL South African operating businesses — physical goods, B2B distribution, manufacturing, SA market. Five verticals: (1) Golf wholesale: Seed Sport distributes premium golf equipment and accessories to SA pro shops and retailers — a relationship and logistics business; (2) Juice concentrate: Gerber Juice processes SA citrus/fruit into juice concentrate at ~1 million litres/month, with some export — exposed to crop conditions and global pricing; (3) Outdoor textiles/upholstery: Gerber Textiles and Cedarbrook Fabrics distribute technical outdoor and indoor fabrics to manufacturers and upholsterers — a materials supply business; (4) Telematics: Geotab Africa is a fleet tracking and GPS telematics reseller/integrator — a technology-adjacent business already in the AI space; (5) Vehicle security: Sanji Electronics manufactures vehicle anti-hijack and security systems for the SA market — hardware manufacturing in a crime-specific niche. These are NOT tech companies. Forecast AI impact on each vertical specifically: which face automation of their core function, where margins compress, where AI is a product/ops opportunity, how labour requirements change, and what the competitive landscape looks like in each case. One section per vertical.`
};
function readScenProfiles() {
  try { if (fs.existsSync(SCEN_PROFILES_FILE)) return { ...SCEN_DEFAULT_PROFILES, ...JSON.parse(fs.readFileSync(SCEN_PROFILES_FILE)) }; } catch (e) {}
  return { ...SCEN_DEFAULT_PROFILES };
}
app.get('/scenario/profiles', (req, res) => res.json(readScenProfiles()));
app.post('/scenario/profiles', (req, res) => {
  try {
    const b = req.body || {}; const cur = readScenProfiles();
    const p = {
      personal: String(b.personal != null ? b.personal : cur.personal).slice(0, 5000),
      gerber: String(b.gerber != null ? b.gerber : cur.gerber).slice(0, 5000)
    };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCEN_PROFILES_FILE, JSON.stringify(p));
    res.json({ ok: true, ...p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/scenario', (req, res) => {
  const ctx = req.query.ctx === 'gerber' ? 'gerber' : 'personal';
  try { if (fs.existsSync(SCEN_FILE(ctx))) return res.json(JSON.parse(fs.readFileSync(SCEN_FILE(ctx)))); } catch (e) {}
  res.json({ scenarios: null, updatedAt: null, ctx });
});

async function runScenario(ctx) {
  ctx = ctx === 'gerber' ? 'gerber' : 'personal';
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY not set on the proxy'), { status: 501 });
  if (scenRunning(ctx)) throw Object.assign(new Error('A forecast is already running.'), { status: 409 });
  SCEN_RUNNING[ctx] = Date.now();
  console.log(`[SCENARIO] run started (${ctx})`);
  try {
    const profile = readScenProfiles()[ctx];
    const today = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    const subject = ctx === 'gerber' ? "the Gerber Goldschmidt Group's operating businesses" : "Stuart's personal and professional life";

    const bandDef = {
      low:    { label: 'Low — slow adoption',         desc: 'AI adoption is slow: regulatory friction, capability plateau, high integration costs. Disruption is real but gradual.' },
      medium: { label: 'Medium — steady compounding', desc: 'Steady AI progress, broad but uneven adoption. Most businesses adapt; some are disrupted. Consensus expectations.' },
      high:   { label: 'High — transformative',       desc: 'Rapid capability gains. Agentic AI and automation accelerate sharply. Major structural disruption to businesses and roles.' }
    };
    const scenarios = {};

    for (const [band, def] of Object.entries(bandDef)) {
      const prompt =
`You are a sharp strategic foresight analyst. Today is ${today}.

Produce the ${def.label.toUpperCase()} AI scenario for ${subject}.

Scenario premise: ${def.desc}

PROFILE:
${profile}

Give EXACTLY 3 outcomes at 1 year, EXACTLY 3 at 2.5 years, EXACTLY 3 at 5 years. All 9 must be filled.

Each outcome — all five fields required, be substantive not thin:
- headline: specific named outcome, references actual businesses/assets/skills from the profile
- type: "opportunity", "threat", or "mixed"
- state: 2 concise sentences — what concretely happens. A specific event or state, not a vague trend.
- action: 1 sentence — the single most important move to make NOW
- impact: 1 line with numbers — revenue %, cost, time saved, margin, headcount, asset value. Use ranges, label estimates.

Return ONLY raw JSON, no markdown:
{"label":"${def.label}","summary":"2 sentence scenario framing","horizons":{"1":[3 outcomes],"2.5":[3 outcomes],"5":[3 outcomes]}}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: COACH_MODEL, max_tokens: 3500, messages: [{ role: 'user', content: prompt }] })
      });
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(`Claude API ${r.status} on ${band}`), { status: 502 });
      const j = JSON.parse(text);
      let reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const start = reply.indexOf('{');
      if (start < 0) throw new Error(`No JSON in ${band} response`);
      let raw = reply.slice(start);
      function repairJson(s) {
        const stack = []; let inStr = false, esc = false;
        for (const c of s) {
          if (esc) { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '{') stack.push('}');
          else if (c === '[') stack.push(']');
          else if ((c === '}' || c === ']') && stack.length && stack[stack.length - 1] === c) stack.pop();
        }
        let out = s; if (inStr) out += '"';
        out += stack.reverse().join(''); return out;
      }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { try { parsed = JSON.parse(repairJson(raw)); } catch (e2) { throw new Error(`${band} parse failed — try again.`); } }
      scenarios[band] = parsed;
      console.log(`[SCENARIO] ${band} done (${ctx}): ${Object.values(parsed.horizons||{}).reduce((n,v)=>n+(v||[]).length,0)} outcomes`);
    }

    const payload = { scenarios, ctx, updatedAt: new Date().toISOString() };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCEN_FILE(ctx), JSON.stringify(payload));
    console.log(`[SCENARIO] all 3 bands stored (${ctx})`);
    return payload;
  } finally { SCEN_RUNNING[ctx] = 0; }
}

app.post('/scenario/run', async (req, res) => {
  const ctx = ((req.body || {}).ctx === 'gerber') ? 'gerber' : 'personal';
  // Return immediately — generation runs in background; client polls /scenario/status
  let stored = null;
  try { if (fs.existsSync(SCEN_FILE(ctx))) stored = JSON.parse(fs.readFileSync(SCEN_FILE(ctx))); } catch (e) {}
  if (scenRunning(ctx)) return res.json({ running: true, ctx, scenarios: stored ? stored.scenarios : null, updatedAt: stored ? stored.updatedAt : null });
  res.json({ running: true, started: true, ctx, scenarios: null, updatedAt: null });
  // Background job — Railway won't time it out since we already responded
  runScenario(ctx).catch(e => console.log('[SCENARIO] background failed:', e.message));
});
// Poll endpoint — client calls this every 5s while waiting
app.get('/scenario/status', (req, res) => {
  const ctx = req.query.ctx === 'gerber' ? 'gerber' : 'personal';
  let stored = null;
  try { if (fs.existsSync(SCEN_FILE(ctx))) stored = JSON.parse(fs.readFileSync(SCEN_FILE(ctx))); } catch (e) {}
  res.json({ running: scenRunning(ctx), ctx, scenarios: stored ? stored.scenarios : null, updatedAt: stored ? stored.updatedAt : null });
});


/* ============================================================
   PAIRS LIVE RECOMPUTE — refreshes the z-score / live status of the
   fixed pair list from free Yahoo Finance daily closes. The historical
   backtest (trades, equity curve, CAGR) stays as the embedded snapshot;
   what we recompute live is each pair's CURRENT spread z-score and
   whether it's firing (|z|>1.5 = LIVE, >1.2 = NEAR), plus a fresh zhist
   tail for the sparkline. Stored on the volume; the dashboard reads
   GET /pairs and can trigger POST /pairs/refresh.
   Method mirrors the original: z of the log price ratio vs its own
   ~6-month (126-trading-day) rolling mean and std.
   ============================================================ */
const PAIRS_FILE = DATA_DIR + '/pairs.json';
let PAIRS_RUNNING = false;

const PAIRS_TICKERS = {
  'Northam': 'NPH.JO', 'Impala': 'IMP.JO', 'Growthpoint': 'GRT.JO', 'Redefine': 'RDF.JO',
  'Thungela': 'TGA.JO', 'Reunert': 'RLO.JO', 'Hudaco': 'HDC.JO', 'Kumba': 'KIO.JO',
  'Coronation': 'CML.JO', 'Ninety One': 'NY1.JO', 'Mr Price': 'MRP.JO', 'TFG': 'TFG.JO',
  'Truworths': 'TRU.JO', 'Hyprop': 'HYP.JO', 'Resilient': 'RES.JO', 'DRDGold': 'DRD.JO',
  'Harmony': 'HAR.JO', 'AngloAmer': 'AGL.JO', 'ARM': 'ARI.JO', 'Exxaro': 'EXX.JO',
  'Tharisa': 'THA.JO', 'BHP': 'BHG.JO',
  'Platinum': 'PL=F', 'Palladium': 'PA=F', 'Copper': 'HG=F', 'Aluminium': 'ALI=F'
  // NOTE: 'Coal' deliberately omitted — Yahoo has no clean free daily coal series
  // (QC=F is noisy/contract-rolled), so coal-leg pairs keep their snapshot z and
  // are flagged live_stale rather than showing a bogus recomputed value.
};

async function yahooCloses(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10mo`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`yahoo ${symbol} HTTP ${r.status}`);
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(`yahoo ${symbol} no result`);
  const ts = res.timestamp || [];
  const closes = (((res.indicators || {}).quote || [])[0] || {}).close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null) out.push({ t: ts[i], c: closes[i] });
  if (out.length < 60) throw new Error(`yahoo ${symbol} too few points (${out.length})`);
  return out;
}

function alignCloses(A, B) {
  const mapB = new Map(B.map(d => [new Date(d.t * 1000).toISOString().slice(0, 10), d.c]));
  const out = [];
  for (const d of A) {
    const key = new Date(d.t * 1000).toISOString().slice(0, 10);
    if (mapB.has(key)) out.push({ a: d.c, b: mapB.get(key) });
  }
  return out;
}

function zSeries(aligned, win) {
  const ratio = aligned.map(p => Math.log(p.a / p.b));
  const z = [];
  for (let i = 0; i < ratio.length; i++) {
    const lo = Math.max(0, i - win + 1);
    const w = ratio.slice(lo, i + 1);
    if (w.length < 20) { z.push(null); continue; }
    const m = w.reduce((s, v) => s + v, 0) / w.length;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) * (v - m), 0) / w.length) || 1e-9;
    z.push((ratio[i] - m) / sd);
  }
  return z;
}

async function refreshPairs() {
  if (PAIRS_RUNNING) throw Object.assign(new Error('A pairs refresh is already running.'), { status: 409 });
  PAIRS_RUNNING = true;
  console.log('[PAIRS] refresh started');
  try {
    let base = [];
    try { if (fs.existsSync(PAIRS_FILE)) base = (JSON.parse(fs.readFileSync(PAIRS_FILE)) || {}).pairs || []; } catch (e) {}
    if (!base.length) throw Object.assign(new Error('No pairs baseline yet — open the Pairs tab once to seed it.'), { status: 425 });

    const needed = new Set();
    base.forEach(p => { needed.add(p.a); needed.add(p.b); });
    const series = {};
    const failed = [];
    for (const name of needed) {
      const sym = PAIRS_TICKERS[name];
      if (!sym) { failed.push(name); continue; }
      try { series[name] = await yahooCloses(sym); }
      catch (e) { failed.push(name); console.log('[PAIRS]', e.message); }
      await new Promise(r => setTimeout(r, 120));
    }

    let updated = 0;
    const out = base.map(p => {
      const A = series[p.a], B = series[p.b];
      if (!A || !B) return { ...p, live_stale: true };
      const aligned = alignCloses(A, B);
      if (aligned.length < 40) return { ...p, live_stale: true };
      const z = zSeries(aligned, 126).filter(v => v != null);
      if (!z.length) return { ...p, live_stale: true };
      const cur = +z[z.length - 1].toFixed(2);
      if (!isFinite(cur) || Math.abs(cur) > 4) return { ...p, live_stale: true }; // bad/illiquid data → keep snapshot
      const status = Math.abs(cur) > 1.5 ? 'LIVE' : Math.abs(cur) > 1.2 ? 'NEAR' : 'idle';
      updated++;
      return { ...p, cur_z: cur, status, zhist: z.slice(-176).map(v => +v.toFixed(2)), live_stale: false };
    });

    const payload = { pairs: out, updatedAt: new Date().toISOString(), priced: updated, failed };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PAIRS_FILE, JSON.stringify(payload));
    console.log(`[PAIRS] refresh done — ${updated}/${base.length} repriced${failed.length ? ', failed: ' + failed.join(',') : ''}`);
    return payload;
  } finally { PAIRS_RUNNING = false; }
}

app.get('/pairs', (req, res) => {
  try { if (fs.existsSync(PAIRS_FILE)) return res.json(JSON.parse(fs.readFileSync(PAIRS_FILE))); } catch (e) {}
  res.json({ pairs: [], updatedAt: null });
});
app.post('/pairs/seed', (req, res) => {
  try {
    const body = req.body || {};
    const pairs = Array.isArray(body.pairs) ? body.pairs : [];
    if (!pairs.length) return res.status(400).json({ error: 'pairs array required' });
    let existing = null;
    try { if (fs.existsSync(PAIRS_FILE)) existing = JSON.parse(fs.readFileSync(PAIRS_FILE)); } catch (e) {}
    if (existing && existing.pairs && existing.pairs.length && !body.force) return res.json(existing);
    const payload = { pairs, updatedAt: null, priced: 0, seeded: true };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PAIRS_FILE, JSON.stringify(payload));
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/pairs/refresh', async (req, res) => {
  try { res.json(await refreshPairs()); }
  catch (e) { console.log('[PAIRS] refresh failed', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

const PAIRS_LAST_AUTO = DATA_DIR + '/pairs-last-auto.txt';
setInterval(async () => {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return;
    if (now.getHours() !== 18) return;
    const today = now.toISOString().slice(0, 10);
    try { if (fs.existsSync(PAIRS_LAST_AUTO) && fs.readFileSync(PAIRS_LAST_AUTO, 'utf8').trim() === today) return; } catch (e) {}
    fs.writeFileSync(PAIRS_LAST_AUTO, today);
    console.log('[PAIRS] weekday auto-refresh starting');
    await refreshPairs();
  } catch (e) { console.log('[PAIRS] auto-refresh failed', e.message); }
}, 10 * 60 * 1000);

app.post('/research', (req, res) => {
  try {
    if (CAL_TOKEN && req.get('x-cal-token') !== CAL_TOKEN) return res.status(401).json({ error: 'bad token' });
    const body = req.body || {};
    const items = (Array.isArray(body) ? body : (body.items || []))
      .map(x => ({ category: x.category || 'General', title: x.title || '', insight: x.insight || '', url: x.url || x.link || '', source: x.source || '' }))
      .filter(x => x.title);
    const payload = { items, updatedAt: new Date().toISOString() };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RES_FILE, JSON.stringify(payload));
    console.log(`[RESEARCH] stored ${items.length} items`);
    res.json({ ok: true, stored: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/research', (req, res) => {
  try {
    if (fs.existsSync(RES_FILE)) return res.json(JSON.parse(fs.readFileSync(RES_FILE)));
  } catch (e) {}
  res.json({ items: [], updatedAt: null });
});

/* ---- RESEARCH PARAMETERS (the "saved brief" that drives every deep dive) ----
   Stored on the volume so they survive restarts. Editable from the dashboard
   (Portfolio Intelligence card → "edit brief"). The on-demand deep dive below
   and any scheduled task can both read these so research stays consistent.   */
const RES_PARAMS_FILE = DATA_DIR + '/research-params.json';
const RES_DEFAULT_PARAMS = {
  brief: 'You are a research analyst preparing the Portfolio Intelligence briefing for Stuart, a principal at Gerber Goldschmidt Group (gerber.co.za) — a Cape Town private equity group invested in ~20 South African trading, distribution and manufacturing businesses. This briefing is about the GROUP\'S OPERATING COMPANIES and their markets, not personal wealth management.\n\nRESEARCH PRIORITIES (cover each; ~2 items per vertical):\n1. GOLF — wholesale and equipment product developments, brand/distribution moves, golf demand and retail trends. Portfolio company: Seed Sport (premium golf performance equipment & accessories).\n2. JUICE CONCENTRATE — fruit juice concentrate market changes: pricing, harvests and crop conditions (SA citrus, apple, global), supply/demand shifts, major producer and export news. Portfolio company: Gerber Juice (juice processing, ~1m litres/month).\n3. OUTDOOR TEXTILES & UPHOLSTERY — fabric industry news and technology: performance/outdoor fabric innovations, coatings, sustainability shifts, supplier and input-price moves. Portfolio companies: Gerber Textiles (outdoor & indoor fabrics), Cedarbrook Fabrics.\n4. TELEMATICS — fleet management and GPS tracking industry: Geotab global product news, competitor moves, connected-vehicle regulation, video/AI telematics. Portfolio company: Geotab Africa.\n5. VEHICLE SECURITY TECH — vehicle security systems and anti-theft/anti-hijack technology, OEM security trends, SA vehicle-crime tech responses. Portfolio company: Sanji Electronics (manufacturer of vehicle security systems).\n\nACROSS ALL VERTICALS: prioritise items showing how AI directly impacts these businesses — their products, operations, supply chains or competitors. Concrete, recent (last 7-14 days), consequential.\n\nMACRO: at most 1-2 items TOTAL, and only if directly consequential for these businesses (e.g. rand moves hitting importers/exporters, SA rates hitting consumer demand). No generic market or asset-allocation commentary, no property/family-office content.\n\nEach insight must say specifically why the item matters to the named portfolio company — written for an owner-operator, not a fund manager.',
  categories: 'Golf (Seed Sport); Juice Concentrate (Gerber Juice); Textiles (Gerber Textiles / Cedarbrook); Telematics (Geotab); Vehicle Security (Sanji); AI Impact; Macro (max 1-2)',
  itemCount: '10-12'
};
function readResParams() {
  try { if (fs.existsSync(RES_PARAMS_FILE)) return { ...RES_DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(RES_PARAMS_FILE)) }; } catch (e) {}
  return { ...RES_DEFAULT_PARAMS };
}
app.get('/research/params', (req, res) => res.json(readResParams()));
app.post('/research/params', (req, res) => {
  try {
    const b = req.body || {};
    const p = {
      brief: String(b.brief || RES_DEFAULT_PARAMS.brief).slice(0, 4000),
      categories: String(b.categories || RES_DEFAULT_PARAMS.categories).slice(0, 2000),
      itemCount: String(b.itemCount || RES_DEFAULT_PARAMS.itemCount).slice(0, 10)
    };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RES_PARAMS_FILE, JSON.stringify(p));
    console.log('[RESEARCH] params updated');
    res.json({ ok: true, ...p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- ON-DEMAND DEEP DIVE (POST /research/run) ----
   What the dashboard's Portfolio Intelligence ↻ button now calls. Runs a fresh
   Claude web-search deep dive using the saved parameters above, replaces the
   stored research list, and returns it. Takes ~1–2 minutes. One at a time.   */
let RES_RUNNING = false;
async function runDeepDive(ranBy) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY not set on the proxy'), { status: 501 });
  if (RES_RUNNING) throw Object.assign(new Error('A deep dive is already running — give it a minute.'), { status: 409 });
  RES_RUNNING = true;
  console.log(`[RESEARCH/RUN] deep dive started (${ranBy})`);
  try {
    const p = readResParams();

    // Gather what we've already shown so the model doesn't repeat it.
    // `seen` is a rolling list of recent item titles kept in the research file.
    let prev = {};
    try { if (fs.existsSync(RES_FILE)) prev = JSON.parse(fs.readFileSync(RES_FILE)) || {}; } catch (e) {}
    const prevTitles = (prev.items || []).map(i => i.title).filter(Boolean);
    const seen = Array.isArray(prev.seen) ? prev.seen : [];
    const avoid = Array.from(new Set([...prevTitles, ...seen])).slice(-60);

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|of|to|for|and|in|on|as|is|sa|south africa)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const avoidSet = new Set(avoid.map(norm));

    const prompt = p.brief
      + '\n\nFocus areas: ' + p.categories
      + '\n\nToday is ' + dateStr + '.'
      + '\n\nSTRICT REQUIREMENTS:'
      + '\n- Surface only genuinely NEW developments published in the LAST 7 DAYS (14 at the absolute most). Lead every web search with the current month and year, and discard anything older.'
      + '\n- Each item must be a specific, datable event — a launch, deal, result, price move, regulation, court ruling, earnings print, appointment. NO evergreen explainers, "trends", round-ups, or background pieces.'
      + '\n- Prefer primary and reputable trade sources over aggregators. Include the publication date in your reasoning and only keep recent ones.'
      + '\n- Do NOT include anything substantially similar to items already covered (listed below). Find fresh stories, not new framings of the same news.'
      + '\n- If a focus area genuinely has no material news this week, return fewer items rather than padding with stale or generic content. Quality over quantity.'
      + (avoid.length ? ('\n\nALREADY COVERED — do not repeat these or close variants:\n- ' + avoid.slice(-40).join('\n- ')) : '')
      + '\n\nProduce up to ' + (p.itemCount || '8-12') + ' items.'
      + '\n\nRespond with ONLY a raw JSON array (no markdown fences, no commentary) where each item is: '
      + '{"category":"<one of the focus areas, short label>","title":"<specific headline in your own words>","insight":"<1-2 sentences: why it matters to this specific portfolio company>","date":"<YYYY-MM-DD of the news>","url":"<source url>","source":"<publisher name>"}';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: COACH_MODEL,
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const text = await r.text();
    if (!r.ok) { console.log('[RESEARCH/RUN] API error', r.status, text.slice(0, 300)); throw Object.assign(new Error('Claude API ' + r.status), { status: 502 }); }
    const j = JSON.parse(text);
    const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = reply.match(/\[[\s\S]*\]/);
    if (!m) { console.log('[RESEARCH/RUN] no JSON in reply:', reply.slice(0, 200)); throw new Error('Deep dive returned no usable list — try again.'); }
    let items = JSON.parse(m[0])
      .map(x => ({ category: x.category || 'General', title: x.title || '', insight: x.insight || '', date: x.date || '', url: x.url || x.link || '', source: x.source || '' }))
      .filter(x => x.title);
    // Drop anything that matches a recently-shown title (belt-and-braces dedup)
    const before = items.length;
    items = items.filter(x => !avoidSet.has(norm(x.title)));
    if (items.length < before) console.log(`[RESEARCH/RUN] filtered ${before - items.length} repeat item(s)`);
    if (!items.length) throw new Error('Deep dive found nothing new this run — the recent news may already be covered. Try again later.');

    // Update rolling seen-list (keep last ~60 titles)
    const newSeen = Array.from(new Set([...seen, ...items.map(i => i.title)])).slice(-60);
    const payload = { items, updatedAt: new Date().toISOString(), ranBy, seen: newSeen };
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RES_FILE, JSON.stringify(payload));
    console.log(`[RESEARCH/RUN] deep dive stored ${items.length} items (${ranBy})`);
    return payload;
  } finally { RES_RUNNING = false; }
}
app.post('/research/run', async (req, res) => {
  try { res.json(await runDeepDive('on-demand')); }
  catch (e) { console.log('[RESEARCH/RUN] failed', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

/* WEEKLY AUTO-RUN — every Monday morning the server runs the deep dive itself
   using the SAME saved brief, so the weekly list always follows the current
   research direction (the old external scheduled task is no longer needed and
   can be deleted — its POST /research pushes would overwrite this with the old
   focus). Fires Mondays between 06:00-07:00 SAST; once per day max. */
const RES_LAST_AUTO = DATA_DIR + '/research-last-auto.txt';
setInterval(async () => {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
    if (now.getDay() !== 1 || now.getHours() !== 6) return; // Mondays, 06:00-06:59 SAST
    const today = now.toISOString().slice(0, 10);
    try { if (fs.existsSync(RES_LAST_AUTO) && fs.readFileSync(RES_LAST_AUTO, 'utf8').trim() === today) return; } catch (e) {}
    fs.writeFileSync(RES_LAST_AUTO, today);
    console.log('[RESEARCH/AUTO] weekly Monday deep dive starting');
    await runDeepDive('weekly-auto');
  } catch (e) { console.log('[RESEARCH/AUTO] failed', e.message); }
}, 10 * 60 * 1000);

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
// SBH family-portfolio dashboard, embedded in the LifePlatform Finance tab
const FAMILY_FILE = path.join(__dirname, 'family.html');
app.get('/family', (req, res) => {
  if (fs.existsSync(FAMILY_FILE)) return res.sendFile(FAMILY_FILE);
  res.status(404).send('family.html not found in the deploy.');
});
app.get('/status', (req, res) => {
  let persistent = false;
  try { if (DATA_DIR && DATA_DIR !== '.') { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); persistent = true; } } catch (e) {}
  res.json({
    proxy: 'LifePlatform-v2',
    whoopAuthenticated: !!tokens,
    tokenStorage: TOKEN_FILE,
    persistentStorage: persistent,
    persistentStorageWarning: persistent ? undefined : 'Tokens are NOT on a persistent volume — they will be lost on the next restart and sync will 500. Attach a volume and set DATA_DIR.',
    calendar: (() => { try { if (fs.existsSync(CAL_FILE)) { const j = JSON.parse(fs.readFileSync(CAL_FILE)); const fresh = j.updatedAt && (Date.now() - Date.parse(j.updatedAt)) < CAL_MAX_AGE_MS; return `push (${(j.events||[]).length} events, ${fresh ? 'fresh' : 'stale — run sync'})`; } } catch (e) {} return process.env.ICAL_URL ? 'configured (ICAL_URL)' : 'waiting for first push (run sync-calendar.sh)'; })(),
    traffic: process.env.GOOGLE_MAPS_KEY ? 'configured (GOOGLE_MAPS_KEY)' : 'OFF — set GOOGLE_MAPS_KEY',
    coach: process.env.ANTHROPIC_API_KEY ? ('configured (' + COACH_MODEL + ')') : 'OFF — set ANTHROPIC_API_KEY',
    // Voice needs a SECOND provider: Claude cannot transcribe audio, so the
    // recording goes to Whisper first and only the transcript reaches Claude.
    voice: process.env.OPENAI_API_KEY ? ('configured (' + (process.env.WHISPER_MODEL || 'whisper-1') + ')') : 'OFF — set OPENAI_API_KEY',
    push: VAPID ? 'configured' : 'OFF — no VAPID keypair',
    // deliberately no device/reminder counts here: /status is unauthenticated
    expenses: process.env.ANTHROPIC_API_KEY ? ('configured (' + EXP_MODEL + ')') : 'OFF — set ANTHROPIC_API_KEY',
    routes: ['/whoop/recovery','/whoop/sleep','/whoop/workouts','/whoop/cycles','/whoop/profile','/news','/traffic','/calendar','/research','/research/run','/research/params','/vision','/swing','/pairs','/pairs/refresh','/scenario','/scenario/run','/scenario/status','/scenario/profiles',
      '/expenses/slips','/expenses/extract-slip','/expenses/statement',
      '/voice','/reminders','/push/key','/push/subscribe','/manifest.webmanifest','/sw.js'],
    connect: '/auth/login'
  });
});
app.listen(PORT, () => console.log(`LifePlatform proxy listening on port ${PORT}`));

/* ============================================================
   USER DATA SYNC — cross-device persistence for golf rounds,
   tasks, goals, professional focus, coach memory, etc.
   GET  /userdata        → returns saved DB blob
   POST /userdata        → saves DB blob (full replace)
   Single-user system so no auth token required beyond same-origin.
   ============================================================ */
const USER_FILE = DATA_DIR + '/userdata.json';
app.get('/userdata', (req, res) => {
  try {
    if (fs.existsSync(USER_FILE)) {
      const raw = fs.readFileSync(USER_FILE, 'utf8');
      return res.type('json').send(raw);
    }
  } catch (e) { console.log('[USERDATA] read error', e.message); }
  res.json(null);
});
/* Server-side UNION merge. Both the browser save() and this endpoint used to do
   a blind full-replace of userdata.json, so whichever device pushed last won and
   the other device's just-added golf shots/rounds (a range session uploaded from
   the phone, say), tasks, projects or manual calendar entries were silently lost.
   Here the INCOMING push wins for scalar fields (newest edit), but historical
   collections are union-merged with what's already on disk so nothing is dropped
   regardless of push order or clock skew. Mirrors the client's _mergeLost().
   Note: like the client, these collections are treated as append-mostly — a
   delete on one device can be resurrected by a stale push from another. Golf
   history is rarely deleted, so this is the right trade for preventing data loss. */
function mergeUserdata(incoming, existing) {
  if (!existing || typeof existing !== 'object') return incoming;
  const into = incoming; // newest scalar fields win
  // golf: rounds by id, shots by signature
  into.golf = into.golf || { shots: [], rounds: [] };
  const eg = existing.golf || {};
  into.golf.rounds = into.golf.rounds || [];
  const haveR = new Set(into.golf.rounds.map(r => r && r.id));
  (eg.rounds || []).forEach(r => { if (r && r.id && !haveR.has(r.id)) into.golf.rounds.push(r); });
  into.golf.shots = into.golf.shots || [];
  const sig = s => [s.club, s.date, s.carry, s.ballSpeed].join('|');
  const haveS = new Set(into.golf.shots.map(sig));
  (eg.shots || []).forEach(s => { if (s && !haveS.has(sig(s))) into.golf.shots.push(s); });
  // morning: tasks + projects by id, manual calendar entries by time+title
  into.morning = into.morning || {};
  const em = existing.morning || {};
  into.morning.tasks = into.morning.tasks || [];
  const haveT = new Set(into.morning.tasks.map(t => t && t.id));
  (em.tasks || []).forEach(t => { if (t && t.id && !haveT.has(t.id)) into.morning.tasks.push(t); });
  into.morning.projects = into.morning.projects || [];
  const haveP = new Set(into.morning.projects.map(p => p && p.id));
  (em.projects || []).forEach(p => { if (p && p.id && !haveP.has(p.id)) into.morning.projects.push(p); });
  into.morning.calendar = into.morning.calendar || [];
  const haveC = new Set(into.morning.calendar.map(e => e && ((e.time || '') + '|' + (e.title || ''))));
  (em.calendar || []).forEach(e => { if (e && e._manual && !haveC.has((e.time || '') + '|' + (e.title || ''))) into.morning.calendar.push(e); });
  // expenses: slips + statements by id. A slip photographed on the phone must
  // survive a push from the laptop that never saw it.
  into.expenses = into.expenses || { slips: [], statements: [] };
  const ee = existing.expenses || {};
  into.expenses.slips = into.expenses.slips || [];
  const haveSl = new Set(into.expenses.slips.map(s => s && s.id));
  (ee.slips || []).forEach(s => { if (s && s.id && !haveSl.has(s.id)) into.expenses.slips.push(s); });
  into.expenses.statements = into.expenses.statements || [];
  const haveSt = new Set(into.expenses.statements.map(s => s && s.id));
  (ee.statements || []).forEach(s => { if (s && s.id && !haveSt.has(s.id)) into.expenses.statements.push(s); });
  return into;
}
app.post('/userdata', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'body must be JSON object' });
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    let existing = null;
    try { if (fs.existsSync(USER_FILE)) existing = JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); }
    catch (e) { console.log('[USERDATA] existing parse skipped', e.message); }
    const merged = mergeUserdata(req.body, existing);
    const payload = JSON.stringify(merged);
    // Safety: don't save obviously corrupt payloads (< 100 bytes)
    if (payload.length < 100) return res.status(400).json({ error: 'payload too small — likely corrupt' });
    fs.writeFileSync(USER_FILE, payload);
    res.json({ ok: true, bytes: payload.length, savedAt: new Date().toISOString() });
  } catch (e) { console.log('[USERDATA] write error', e.message); res.status(500).json({ error: e.message }); }
});

/* ============================================================
   REFERENCE SWINGS — heavy base64 video frames, kept OUT of the
   synced userdata blob so that blob stays small (browsers cap
   localStorage at ~5MB and oversized POSTs 500). Stored on the
   volume in their own file, fetched on demand.
   GET  /refswings  → saved { angle: [f0..f5] } object (or {})
   POST /refswings  → full replace
   ============================================================ */
const REFSWINGS_FILE = DATA_DIR + '/refswings.json';
app.get('/refswings', (req, res) => {
  try {
    if (fs.existsSync(REFSWINGS_FILE)) {
      return res.type('json').send(fs.readFileSync(REFSWINGS_FILE, 'utf8'));
    }
  } catch (e) { console.log('[REFSWINGS] read error', e.message); }
  res.json({});
});
app.post('/refswings', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'body must be JSON object' });
    if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(req.body);
    fs.writeFileSync(REFSWINGS_FILE, payload);
    res.json({ ok: true, bytes: payload.length, savedAt: new Date().toISOString() });
  } catch (e) { console.log('[REFSWINGS] write error', e.message); res.status(500).json({ error: e.message }); }
});
/* ============================================================
   EXPENSE CLAIMS — credit-card slips + statement reconciliation.

   Slip photos are full-res base64 and must stay OUT of the synced
   userdata blob for the same reason reference swings do (the ~5MB
   localStorage cap and the POST limit). Each slip image gets its own
   file on the volume; the light metadata (merchant, amount, the
   required explanation, match state) rides along in userdata so it
   syncs across devices.

   GET    /expenses/slips        → { ids: [...] } (index only, no images)
   GET    /expenses/slips/:id    → { image, media_type }
   POST   /expenses/slips        → { id, image, media_type } save one slip
   DELETE /expenses/slips/:id    → remove one slip image
   POST   /expenses/extract-slip → Claude reads a slip photo
   POST   /expenses/statement    → Claude reads a statement PDF
   ============================================================ */
const EXP_DIR = DATA_DIR + '/expense-slips';
const EXP_MODEL = process.env.EXPENSE_MODEL || 'claude-opus-5';
const safeSlipId = id => /^[A-Za-z0-9_-]{1,64}$/.test(String(id || '')) ? String(id) : null;

app.get('/expenses/slips', (req, res) => {
  try {
    if (!fs.existsSync(EXP_DIR)) return res.json({ ids: [] });
    const ids = fs.readdirSync(EXP_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
    res.json({ ids });
  } catch (e) { console.log('[EXPENSES] index error', e.message); res.json({ ids: [] }); }
});

app.get('/expenses/slips/:id', (req, res) => {
  const id = safeSlipId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const f = EXP_DIR + '/' + id + '.json';
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'not found' });
    res.type('json').send(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.log('[EXPENSES] read error', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/expenses/slips', (req, res) => {
  try {
    const { id, image, media_type = 'image/jpeg' } = req.body || {};
    const sid = safeSlipId(id);
    if (!sid) return res.status(400).json({ error: 'id required (alphanumeric)' });
    if (!image) return res.status(400).json({ error: 'image field required (base64)' });
    fs.mkdirSync(EXP_DIR, { recursive: true });
    const payload = JSON.stringify({ image, media_type, savedAt: new Date().toISOString() });
    fs.writeFileSync(EXP_DIR + '/' + sid + '.json', payload);
    res.json({ ok: true, id: sid, bytes: payload.length });
  } catch (e) { console.log('[EXPENSES] write error', e.message); res.status(500).json({ error: e.message }); }
});

app.delete('/expenses/slips/:id', (req, res) => {
  const id = safeSlipId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const f = EXP_DIR + '/' + id + '.json';
    if (fs.existsSync(f)) fs.unlinkSync(f);
    res.json({ ok: true });
  } catch (e) { console.log('[EXPENSES] delete error', e.message); res.status(500).json({ error: e.message }); }
});

/* Shared caller for the two extraction endpoints. Structured outputs pin the
   reply to the schema, so the response is always parseable — no regex rescue.
   Thinking is off at low effort: these are transcription jobs, and the schema
   (not reasoning depth) is what keeps them honest. */
async function claudeExtract({ content, schema, max_tokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('ANTHROPIC_API_KEY not set on the proxy'); e.status = 501; throw e; }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: EXP_MODEL,
      max_tokens,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }]
    })
  });
  const text = await r.text();
  if (!r.ok) { console.log('[EXPENSES] API error', r.status, text.slice(0, 400)); const e = new Error(`Claude API ${r.status}`); e.status = 502; throw e; }
  const j = JSON.parse(text);
  if (j.stop_reason === 'refusal') { const e = new Error('request declined'); e.status = 502; throw e; }
  const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return JSON.parse(reply);
}

const SLIP_SCHEMA = {
  type: 'object',
  properties: {
    merchant:   { type: 'string', description: 'Trading name on the slip, or "" if illegible' },
    date:       { type: 'string', description: 'Transaction date as YYYY-MM-DD, or "" if not visible' },
    amount:     { type: 'number', description: 'Total actually paid, as a positive number. 0 if illegible' },
    currency:   { type: 'string', description: 'ISO code, e.g. ZAR. Default ZAR if the slip shows R with no other clue' },
    vat:        { type: 'number', description: 'VAT/tax portion of the total, 0 if not shown' },
    cardLast4:  { type: 'string', description: 'Last 4 digits of the card if printed, else ""' },
    lineItems:  { type: 'array', items: { type: 'string' }, description: 'Purchased items, up to 12. Empty if the slip only shows a total' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How legible the slip was' }
  },
  required: ['merchant', 'date', 'amount', 'currency', 'vat', 'cardLast4', 'lineItems', 'confidence'],
  additionalProperties: false
};

app.post('/expenses/extract-slip', async (req, res) => {
  try {
    const { image, media_type = 'image/jpeg' } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image field required (base64)' });
    const out = await claudeExtract({
      max_tokens: 4000,
      schema: SLIP_SCHEMA,
      content: [
        { type: 'image', source: { type: 'base64', media_type, data: image } },
        { type: 'text', text: 'This is a photograph of a credit-card slip or till receipt. Transcribe exactly what is printed — do not infer, round, or invent values. If a field is genuinely not legible, return the empty/zero default for it rather than a guess. The amount must be the final total paid, not a subtotal.' }
      ]
    });
    res.json(out);
  } catch (e) { console.log('[EXPENSES] slip extract failed', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

const STATEMENT_SCHEMA = {
  type: 'object',
  properties: {
    account:     { type: 'string', description: 'Account or card description, masked as printed. "" if absent' },
    periodStart: { type: 'string', description: 'Statement period start as YYYY-MM-DD, or ""' },
    periodEnd:   { type: 'string', description: 'Statement period end as YYYY-MM-DD, or ""' },
    transactions: {
      type: 'array',
      description: 'Every transaction line on the statement, in the order printed',
      items: {
        type: 'object',
        properties: {
          date:        { type: 'string', description: 'YYYY-MM-DD' },
          description: { type: 'string', description: 'Narrative exactly as printed' },
          amount:      { type: 'number', description: 'Positive for a purchase/charge, negative for a payment, credit or refund' },
          currency:    { type: 'string', description: 'ISO code, e.g. ZAR' }
        },
        required: ['date', 'description', 'amount', 'currency'],
        additionalProperties: false
      }
    }
  },
  required: ['account', 'periodStart', 'periodEnd', 'transactions'],
  additionalProperties: false
};

app.post('/expenses/statement', async (req, res) => {
  try {
    const { pdf } = req.body || {};
    if (!pdf) return res.status(400).json({ error: 'pdf field required (base64)' });
    const out = await claudeExtract({
      max_tokens: 16000,
      schema: STATEMENT_SCHEMA,
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
        { type: 'text', text: 'This is a credit-card statement. Extract every transaction line exactly as printed — do not summarise, merge, skip, or reorder lines. Use the statement year to resolve dates printed without one. Purchases are positive; payments, credits and refunds are negative.' }
      ]
    });
    res.json(out);
  } catch (e) { console.log('[EXPENSES] statement extract failed', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

/* ============================================================
   PWA SHELL — manifest + service worker + icons.
   iOS only delivers Web Push to a site installed to the Home
   Screen as a real web app, which needs all three of these. A
   plain "Add to Home Screen" bookmark will NOT receive pushes.
   ============================================================ */
const APP_TZ = process.env.TZ_NAME || 'Africa/Johannesburg';

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'Stuart Harris · Life',
    short_name: 'Life',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#eef4f3',
    theme_color: '#0a8a96',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
});
const ICONS = { '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/apple-touch-icon.png': 'apple-touch-icon.png' };
Object.entries(ICONS).forEach(([route, file]) => {
  app.get(route, (req, res) => {
    try { res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(fs.readFileSync(file)); }
    catch (e) { res.status(404).end(); }
  });
});

/* Deliberately cache nothing. The app is a single ~1MB HTML file that changes
   on every deploy; a caching service worker would serve a stale build and be a
   nightmare to invalidate. This exists purely to receive pushes. */
const SW_JS = `
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
  const title = d.title || 'Life';
  const opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/app', id: d.id || null },
    actions: d.actions || []
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(target); } catch (e) {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
`;
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(SW_JS);
});

/* ============================================================
   WEB PUSH — VAPID keys, subscriptions, delivery.
   Keys come from env if set, otherwise they're generated once and
   kept on the volume so subscriptions survive redeploys without
   anyone having to paste keys into Railway.
   ============================================================ */
const VAPID_FILE = DATA_DIR + '/vapid.json';
const SUBS_FILE  = DATA_DIR + '/push-subs.json';
let VAPID = null;

function initVapid() {
  try {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      VAPID = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    } else if (fs.existsSync(VAPID_FILE)) {
      VAPID = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } else {
      VAPID = webpush.generateVAPIDKeys();
      if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID));
      console.log('[PUSH] generated a new VAPID keypair on the volume');
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:stuarth@gerber.co.za', VAPID.publicKey, VAPID.privateKey);
    console.log('[PUSH] VAPID ready');
  } catch (e) { console.log('[PUSH] VAPID init failed', e.message); VAPID = null; }
}
initVapid();

const readSubs  = () => { try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { return []; } };
const writeSubs = s => { try { if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SUBS_FILE, JSON.stringify(s)); } catch (e) { console.log('[PUSH] save failed', e.message); } };

/* Fan a payload out to every registered device, pruning any the push service
   has retired (410/404) so dead phones don't accumulate forever. */
async function sendPush(payload) {
  if (!VAPID) { console.log('[PUSH] no VAPID configured — skipping'); return { sent: 0, pruned: 0 }; }
  const subs = readSubs();
  if (!subs.length) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  let sent = 0; const dead = [];
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification(s.sub, body); sent++; }
    catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) dead.push(s.sub.endpoint);
      else console.log('[PUSH] send failed', code || e.message);
    }
  }));
  if (dead.length) writeSubs(subs.filter(s => !dead.includes(s.sub.endpoint)));
  return { sent, pruned: dead.length };
}

app.get('/push/key', (req, res) => {
  if (!VAPID) return res.status(501).json({ error: 'push not configured' });
  res.json({ publicKey: VAPID.publicKey });
});
app.get('/push/status', (req, res) => {
  res.json({ configured: !!VAPID, devices: readSubs().length });
});
app.post('/push/subscribe', (req, res) => {
  const { subscription, label } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
  const subs = readSubs().filter(s => s.sub.endpoint !== subscription.endpoint);
  subs.push({ sub: subscription, label: label || 'device', addedAt: new Date().toISOString() });
  writeSubs(subs);
  res.json({ ok: true, devices: subs.length });
});
app.post('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  const subs = readSubs().filter(s => s.sub.endpoint !== endpoint);
  writeSubs(subs);
  res.json({ ok: true, devices: subs.length });
});
app.post('/push/test', async (req, res) => {
  const r = await sendPush({ title: 'Life', body: 'Notifications are working.', tag: 'test', url: '/app' });
  res.json(r);
});

/* ============================================================
   REMINDERS — stored server-side, not in the synced blob, because
   they have to fire when the phone is asleep and the app is shut.
   ============================================================ */
const REM_FILE = DATA_DIR + '/reminders.json';
const readRems  = () => { try { return JSON.parse(fs.readFileSync(REM_FILE, 'utf8')); } catch (e) { return []; } };
const writeRems = r => { try { if (DATA_DIR && DATA_DIR !== '.') fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(REM_FILE, JSON.stringify(r)); } catch (e) { console.log('[REMIND] save failed', e.message); } };

// Local wall-clock in the app's timezone, regardless of the server's TZ (Railway is UTC).
function localParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, dow: p.weekday };
}
// Quiet hours gate non-urgent COACH nudges only. An explicit reminder the user
// asked for at 22:00 must still fire at 22:00 — silencing it would be a bug.
function inQuietHours(d = new Date()) {
  const { h, mi } = localParts(d);
  const t = h * 60 + mi;
  const from = +(process.env.QUIET_FROM_MIN || 21 * 60);
  const to   = +(process.env.QUIET_TO_MIN   || 6 * 60 + 30);
  return from > to ? (t >= from || t < to) : (t >= from && t < to);
}
const localDow = d => new Intl.DateTimeFormat('en-US', { timeZone: APP_TZ, weekday: 'short' }).format(d);
function nextOccurrence(iso, repeat) {
  const d = new Date(iso);
  const addDays = n => new Date(d.getTime() + n * 86400000).toISOString();
  switch (repeat) {
    case 'daily':   return addDays(1);
    case 'weekly':  return addDays(7);
    case 'weekdays': {
      let n = new Date(d);
      do { n = new Date(n.getTime() + 86400000); } while (['Sat', 'Sun'].includes(localDow(n)));
      return n.toISOString();
    }
    case 'monthly': { const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 1); return n.toISOString(); }
    default:        return null;
  }
}

app.get('/reminders', (req, res) => res.json(readRems()));
app.post('/reminders', (req, res) => {
  const { text, at, repeat = 'none', source = 'typed' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  if (!at || isNaN(new Date(at).getTime())) return res.status(400).json({ error: 'valid at (ISO) required' });
  const rems = readRems();
  const rem = { id: 'rem' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: String(text).trim().slice(0, 400), at: new Date(at).toISOString(),
    repeat, source, done: false, firedAt: null, createdAt: new Date().toISOString() };
  rems.push(rem); writeRems(rems);
  res.json(rem);
});
app.patch('/reminders/:id', (req, res) => {
  const rems = readRems(); const r = rems.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const { done, snoozeMin, text, at } = req.body || {};
  if (typeof done === 'boolean') r.done = done;
  if (snoozeMin) { r.at = new Date(Date.now() + snoozeMin * 60000).toISOString(); r.done = false; r.firedAt = null; }
  if (text) r.text = String(text).slice(0, 400);
  if (at && !isNaN(new Date(at).getTime())) { r.at = new Date(at).toISOString(); r.firedAt = null; r.done = false; }
  writeRems(rems); res.json(r);
});
app.delete('/reminders/:id', (req, res) => {
  const rems = readRems(); const i = rems.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  rems.splice(i, 1); writeRems(rems); res.json({ ok: true });
});

// Tick: fire anything due. 30s granularity is plenty for minute-precision reminders.
let _remTicking = false;
setInterval(async () => {
  if (_remTicking) return;
  _remTicking = true;
  try {
    const rems = readRems();
    const now = Date.now();
    const due = rems.filter(r => !r.done && !r.firedAt && new Date(r.at).getTime() <= now);
    if (due.length) {
      for (const r of due) {
        await sendPush({ title: 'Reminder', body: r.text, tag: r.id, url: '/app?remind=' + r.id, id: r.id });
        r.firedAt = new Date().toISOString();
        const nxt = nextOccurrence(r.at, r.repeat);
        if (nxt) { r.at = nxt; r.firedAt = null; }   // recurring: re-arm rather than close out
        else r.done = true;
      }
      writeRems(rems);
      console.log('[REMIND] fired ' + due.length);
    }
  } catch (e) { console.log('[REMIND] tick failed', e.message); }
  _remTicking = false;
}, 30000);

/* ============================================================
   VOICE NOTES — speak an instruction, get a reminder.
   Claude has no speech-to-text, so audio goes to Whisper first,
   then the transcript goes to Claude to work out what was meant.
   ============================================================ */
const VOICE_SCHEMA = {
  type: 'object',
  properties: {
    intent:  { type: 'string', enum: ['reminder', 'note', 'unclear'], description: 'reminder if a time or "remind me" is implied; note if it is just something to record; unclear if unusable' },
    text:    { type: 'string', description: 'The reminder or note, rewritten in clean second person, e.g. "Call the plumber about the Ebony Cottage geyser"' },
    at:      { type: 'string', description: 'Absolute local time as YYYY-MM-DDTHH:MM (no timezone suffix), or "" if none was given' },
    repeat:  { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] },
    reply:   { type: 'string', description: 'One short warm sentence confirming what you understood, in a coach voice' }
  },
  required: ['intent', 'text', 'at', 'repeat', 'reply'],
  additionalProperties: false
};

/* The thinking half, shared by both input routes. Audio is the only thing that
   needs Whisper — once there are words, this is pure Claude. `now` is the
   phone's clock so "tomorrow at 3" resolves against the user's day, not UTC. */
async function interpretNote(transcript, now) {
  const akey = process.env.ANTHROPIC_API_KEY;
  if (!akey) { const e = new Error('ANTHROPIC_API_KEY not set on the proxy'); e.status = 501; throw e; }
  const stamp = now && !isNaN(new Date(now).getTime()) ? new Date(now) : new Date();
  const localNow = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }).format(stamp);
  const ar = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': akey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.VOICE_MODEL || 'claude-opus-5',
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: VOICE_SCHEMA } },
      system: 'You turn a short note from Stuart into a structured reminder for his personal dashboard. ' +
              'It is currently ' + localNow + ' in ' + APP_TZ + '. Resolve relative times ("tomorrow", "in an hour", ' +
              '"Friday morning") against that. Morning defaults to 08:00, afternoon to 14:00, evening to 18:00. ' +
              'If no time at all is implied, return intent "note" with an empty at. Never invent a time that was not implied.',
      messages: [{ role: 'user', content: 'Note: "' + transcript + '"' }]
    })
  });
  const atext = await ar.text();
  if (!ar.ok) { console.log('[NOTE] claude error', ar.status, atext.slice(0, 300)); const e = new Error('Could not interpret that note'); e.status = 502; throw e; }
  const aj = JSON.parse(atext);
  if (aj.stop_reason === 'refusal') { const e = new Error('request declined'); e.status = 502; throw e; }
  const parsed = JSON.parse((aj.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
  const atIso = (parsed.intent === 'reminder' && parsed.at) ? localToInstant(parsed.at) : null;
  return { ...parsed, at: atIso, atLocal: parsed.at || '' };
}

/* Typed or dictated with the phone keyboard's own mic — no transcription
   service involved, so this works on the Claude key alone. */
app.post('/interpret', async (req, res) => {
  try {
    const { text, now } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const transcript = String(text).trim().slice(0, 2000);
    const out = await interpretNote(transcript, now);
    res.json({ transcript, ...out });
  } catch (e) { console.log('[INTERPRET] failed', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/voice', async (req, res) => {
  try {
    const okey = process.env.OPENAI_API_KEY;
    if (!okey) return res.status(501).json({ error: 'OPENAI_API_KEY not set — use the dictation box instead, or add the key' });
    const { audio, media_type = 'audio/webm', now } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio field required (base64)' });

    const ext = /mp4|m4a/.test(media_type) ? 'm4a' : /ogg/.test(media_type) ? 'ogg' : /wav/.test(media_type) ? 'wav' : 'webm';
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(audio, 'base64')], { type: media_type }), 'note.' + ext);
    fd.append('model', process.env.WHISPER_MODEL || 'whisper-1');
    const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: 'Bearer ' + okey }, body: fd
    });
    const wtext = await wr.text();
    if (!wr.ok) { console.log('[VOICE] whisper error', wr.status, wtext.slice(0, 300)); return res.status(502).json({ error: 'Transcription failed (' + wr.status + ')' }); }
    const transcript = (JSON.parse(wtext).text || '').trim();
    if (!transcript) return res.json({ transcript: '', intent: 'unclear', reply: "I couldn't hear anything in that." });

    const out = await interpretNote(transcript, now);
    res.json({ transcript, ...out });
  } catch (e) { console.log('[VOICE] failed', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

/* "2026-08-18T15:00" in APP_TZ -> a real UTC instant. Works out the zone's
   offset at that date (so it survives any future DST change) and subtracts it. */
function localToInstant(local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const asUtc = new Date(guess);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(asUtc).reduce((o, x) => (o[x.type] = x.value, o), {});
  const back = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (back - guess)).toISOString();
}

// redeploy Mon Jun 15 16:12:01 UTC 2026
// redeploy pairs-live Mon Jun 15 16:28:54 UTC 2026
// redeploy scenario Mon Jun 15 18:35:55 UTC 2026
// kick 1781550215
