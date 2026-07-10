/* ============================================================
   Mail digest for LifePlatform  (with learning + actions)
   ------------------------------------------------------------
   Server-side OAuth (client id/secret + rotating refresh token on
   the persistent volume), auto-refresh, gated JSON endpoints.

   Providers:
     - Gmail  (stuarth959 hub + everything forwarded into it)
     - Microsoft Graph / Outlook (gervest.co.uk)

   Learning: every action you take is recorded against the sender in
   a feedback store on the volume, and future ranking is weighted by
   it — senders you spam sink, senders you task/keep rise. Read-only:
   nothing is ever changed in the real mailboxes; "unimportant"/"spam"
   just hide the item here and teach the ranker.

   Routes:
     GET  /auth/google/login | /auth/google/callback
     GET  /auth/ms/login     | /auth/ms/callback
     GET  /mail              JSON: important items from both inboxes
     POST /mail/feedback     { id, sender, verdict }  verdict: spam|unimportant|task|important
     GET  /mail/view         self-contained HTML dashboard
     GET  /mail/status       config / auth diagnostics

   Env (Railway → Variables):
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
     MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI, MS_TENANT
     MAIL_LOOKBACK_DAYS (default 2), MAIL_VIP (comma list), MAIL_LLM ('1')
   ============================================================ */

import fs from 'fs';

export function mountMail(app, { DATA_DIR = '.' } = {}) {
  const dir = (DATA_DIR || '.').replace(/\/+$/, '');
  const GOOGLE_TOKEN_FILE = dir + '/google-tokens.json';
  const MS_TOKEN_FILE     = dir + '/ms-tokens.json';
  const FEEDBACK_FILE     = dir + '/mail-feedback.json';

  const {
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback',
    MS_CLIENT_ID, MS_CLIENT_SECRET,
    MS_REDIRECT_URI = 'http://localhost:3000/auth/ms/callback',
    MS_TENANT = 'common',
    ANTHROPIC_API_KEY,
  } = process.env;

  const LOOKBACK_DAYS = Number(process.env.MAIL_LOOKBACK_DAYS || 2);
  const VIP = (process.env.MAIL_VIP || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const USE_LLM = process.env.MAIL_LLM === '1' && !!ANTHROPIC_API_KEY;

  const GOOGLE_AUTH  = 'https://accounts.google.com/o/oauth2/v2/auth';
  const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
  const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const MS_AUTH  = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`;
  const MS_TOKEN = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;
  const MS_SCOPE = 'offline_access https://graph.microsoft.com/Mail.Read';

  /* ---------- token storage ---------- */
  const readTokens = (file, seedEnv) => {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)); } catch (e) {}
    if (process.env[seedEnv]) return { refresh_token: process.env[seedEnv], access_token: null, obtained_at: 0, expires_in: 0 };
    return null;
  };
  const writeJson = (file, t) => {
    try {
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(t, null, 2));
    } catch (e) { console.log('[MAIL] WARNING could not persist', file, '-', e.message); }
  };

  let gTokens  = readTokens(GOOGLE_TOKEN_FILE, 'GOOGLE_REFRESH_TOKEN');
  let msTokens = readTokens(MS_TOKEN_FILE, 'MS_REFRESH_TOKEN');

  /* ---------- feedback / learning store ---------- */
  let feedback = { senders: {}, dismissed: {}, updatedAt: null };
  try { if (fs.existsSync(FEEDBACK_FILE)) feedback = Object.assign(feedback, JSON.parse(fs.readFileSync(FEEDBACK_FILE))); } catch (e) {}
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const WEIGHT = { spam: -4, unimportant: -2, task: 3, important: 3 };
  function pruneDismissed() {
    const cutoff = Date.now() - (LOOKBACK_DAYS * 2 + 1) * 86400000;
    for (const id in feedback.dismissed) if (feedback.dismissed[id] < cutoff) delete feedback.dismissed[id];
  }
  function applyFeedback({ id, sender, verdict }) {
    sender = (sender || '').toLowerCase();
    if (sender && WEIGHT[verdict] != null) {
      feedback.senders[sender] = clamp((feedback.senders[sender] || 0) + WEIGHT[verdict], -10, 10);
    }
    if (id && (verdict === 'spam' || verdict === 'unimportant' || verdict === 'task')) {
      feedback.dismissed[id] = Date.now();
    }
    feedback.updatedAt = new Date().toISOString();
    pruneDismissed();
    writeJson(FEEDBACK_FILE, feedback);
  }

  async function googleAccessToken() {
    if (!gTokens || !gTokens.refresh_token) throw new Error('Gmail not connected - visit /auth/google/login');
    const ageSec = (Date.now() - (gTokens.obtained_at || 0)) / 1000;
    if (gTokens.access_token && ageSec < ((gTokens.expires_in || 0) - 120)) return gTokens.access_token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: gTokens.refresh_token, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET });
    const r = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw new Error('Gmail token refresh failed (re-connect at /auth/google/login): ' + await r.text());
    const t = await r.json(); t.obtained_at = Date.now();
    if (!t.refresh_token) t.refresh_token = gTokens.refresh_token;
    gTokens = t; writeJson(GOOGLE_TOKEN_FILE, t);
    return t.access_token;
  }

  async function msAccessToken() {
    if (!msTokens || !msTokens.refresh_token) throw new Error('Outlook not connected - visit /auth/ms/login');
    const ageSec = (Date.now() - (msTokens.obtained_at || 0)) / 1000;
    if (msTokens.access_token && ageSec < ((msTokens.expires_in || 0) - 120)) return msTokens.access_token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: msTokens.refresh_token, client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: MS_SCOPE });
    const r = await fetch(MS_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw new Error('Outlook token refresh failed (re-connect at /auth/ms/login): ' + await r.text());
    const t = await r.json(); t.obtained_at = Date.now();
    if (!t.refresh_token) t.refresh_token = msTokens.refresh_token;
    msTokens = t; writeJson(MS_TOKEN_FILE, t);
    return t.access_token;
  }

  /* ---------- OAuth handshakes ---------- */
  app.get('/auth/google/login', (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.status(500).send('Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET first.');
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
    url.searchParams.set('scope', GOOGLE_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', Math.random().toString(36).slice(2));
    res.redirect(url.toString());
  });
  app.get('/auth/google/callback', async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) throw new Error('missing code: ' + (req.query.error_description || ''));
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: GOOGLE_REDIRECT_URI, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET });
      const r = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const text = await r.text();
      if (!r.ok) throw new Error('token exchange failed: ' + text);
      const t = JSON.parse(text); t.obtained_at = Date.now();
      gTokens = t; writeJson(GOOGLE_TOKEN_FILE, t);
      res.send('<h2>Gmail connected</h2><p>You can close this tab and return to LifePlatform -> Mail.</p>');
    } catch (e) { console.log('[MAIL/google] callback failed:', e.message); res.status(500).send(e.message); }
  });
  app.get('/auth/ms/login', (req, res) => {
    if (!MS_CLIENT_ID) return res.status(500).send('Set MS_CLIENT_ID / MS_CLIENT_SECRET first.');
    const url = new URL(MS_AUTH);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', MS_CLIENT_ID);
    url.searchParams.set('redirect_uri', MS_REDIRECT_URI);
    url.searchParams.set('scope', MS_SCOPE);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('state', Math.random().toString(36).slice(2));
    res.redirect(url.toString());
  });
  app.get('/auth/ms/callback', async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) throw new Error('missing code: ' + (req.query.error_description || ''));
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: MS_REDIRECT_URI, client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: MS_SCOPE });
      const r = await fetch(MS_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const text = await r.text();
      if (!r.ok) throw new Error('token exchange failed: ' + text);
      const t = JSON.parse(text); t.obtained_at = Date.now();
      msTokens = t; writeJson(MS_TOKEN_FILE, t);
      res.send('<h2>Outlook connected</h2><p>You can close this tab and return to LifePlatform -> Mail.</p>');
    } catch (e) { console.log('[MAIL/ms] callback failed:', e.message); res.status(500).send(e.message); }
  });

  /* ---------- fetch + normalise ---------- */
  const parseFrom = (raw = '') => {
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
    return { name: '', email: raw.trim().toLowerCase() };
  };

  async function fetchGmail() {
    const token = await googleAccessToken();
    const q = `in:inbox newer_than:${LOOKBACK_DAYS}d -category:promotions -category:social -in:chats`;
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', q);
    listUrl.searchParams.set('maxResults', '40');
    const lr = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (!lr.ok) throw new Error('Gmail list HTTP ' + lr.status + ' ' + await lr.text());
    const lj = await lr.json();
    const ids = (lj.messages || []).map(m => m.id);
    const out = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = ids.slice(i, i + 8).map(async id => {
        const mu = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
        mu.searchParams.set('format', 'metadata');
        ['From', 'Subject', 'Date', 'To', 'Delivered-To'].forEach(h => mu.searchParams.append('metadataHeaders', h));
        const mr = await fetch(mu, { headers: { Authorization: 'Bearer ' + token } });
        if (!mr.ok) return null;
        const mj = await mr.json();
        const H = Object.fromEntries((mj.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
        const account = (H['delivered-to'] || H['to'] || 'stuarth959@gmail.com').toLowerCase();
        return {
          id, source: 'gmail',
          account: (account.match(/[\w.+-]+@[\w.-]+/) || [account])[0],
          from: parseFrom(H['from'] || ''),
          subject: H['subject'] || '(no subject)',
          snippet: mj.snippet || '',
          date: new Date(Number(mj.internalDate) || Date.parse(H['date']) || Date.now()).toISOString(),
          unread: (mj.labelIds || []).includes('UNREAD'),
          link: `https://mail.google.com/mail/u/0/#inbox/${mj.threadId || id}`,
        };
      });
      out.push(...(await Promise.all(batch)).filter(Boolean));
    }
    return out;
  }

  async function fetchOutlook() {
    const token = await msAccessToken();
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages');
    url.searchParams.set('$select', 'subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink');
    url.searchParams.set('$filter', `receivedDateTime ge ${since}`);
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$top', '40');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Graph HTTP ' + r.status + ' ' + await r.text());
    const j = await r.json();
    return (j.value || []).map(m => ({
      id: m.id, source: 'outlook',
      account: (m.toRecipients?.[0]?.emailAddress?.address || 'stuart@gervest.co.uk').toLowerCase(),
      from: { name: m.from?.emailAddress?.name || '', email: (m.from?.emailAddress?.address || '').toLowerCase() },
      subject: m.subject || '(no subject)',
      snippet: m.bodyPreview || '',
      date: m.receivedDateTime,
      unread: m.isRead === false,
      link: m.webLink || 'https://outlook.office.com/mail/',
    }));
  }

  /* ---------- importance heuristics + learning ---------- */
  const AUTOMATED = /(^|[._-])(no-?reply|do-?not-?reply|noreply|donotreply|mailer-daemon|postmaster|bounce|notifications?|newsletter|mailer|updates?|alerts?|marketing|info|support|automated)@|@(.*\.)?(mailchimp|sendgrid|mailgun|amazonses|sparkpostmail|substack)\./i;
  const MONEY = /\b(invoice|payment|overdue|past due|remittance|statement|quote|contract|renewal|deposit|eft|refund|booking|reserv\w*|confirmation|deadline|expir\w+|urgent|action required|balance|outstanding|proforma|purchase order|\bpo\b)\b/i;
  const PROMO = /\b(unsubscribe|% off|\bsale\b|discount|webinar|special offer|limited time|newsletter)\b/i;
  const REPLYISH = /\?|\b(can you|could you|please|let me know|thoughts|confirm|available|when are you|are you able|need your|awaiting|follow up|following up|reply)\b/i;
  const isVip = (email) => VIP.some(v => email === v || email.endsWith('@' + v) || email.endsWith('.' + v) || email.includes(v));

  function classify(item) {
    const from = item.from.email || '';
    const w = feedback.senders[from] || 0;
    const hay = `${item.subject} ${item.snippet}`;
    const automated = AUTOMATED.test(from);
    let res;
    if (w <= -4)                 res = { keep: false, category: 'Learned unimportant', priority: 9, reason: 'You marked this sender unimportant' };
    else if (w >= 3)             res = { keep: true,  category: 'Key people',           priority: 1, reason: 'Learned: you flag this sender' };
    else if (isVip(from))        res = { keep: true,  category: 'Key people',           priority: 1, reason: 'From a key contact' };
    else if (MONEY.test(hay))    res = { keep: true,  category: 'Deadlines & money',    priority: 2, reason: 'Mentions a deadline, payment, or booking' };
    else if (automated)          res = { keep: false, category: 'Automated',            priority: 9, reason: 'Automated / no-reply sender' };
    else if (PROMO.test(hay))    res = { keep: false, category: 'Promotional',          priority: 9, reason: 'Looks promotional' };
    else if (REPLYISH.test(hay) || item.unread)
                                 res = { keep: true,  category: 'Needs a reply',        priority: 3, reason: 'From a person, likely needs a response' };
    else                         res = { keep: false, category: 'Other',                priority: 8, reason: 'No importance signal' };
    // mild nudge from accumulated feedback that hasn't hit a hard threshold
    if (res.keep && w < 0) res.priority += 2;
    if (res.keep && w > 0) res.priority = Math.max(1, res.priority - 1);
    return res;
  }

  async function buildDigest() {
    const sources = {};
    const results = await Promise.allSettled([fetchGmail(), fetchOutlook()]);
    let items = [];
    if (results[0].status === 'fulfilled') { items = items.concat(results[0].value); sources.gmail = 'ok (' + results[0].value.length + ')'; }
    else sources.gmail = 'error: ' + results[0].reason.message;
    if (results[1].status === 'fulfilled') { items = items.concat(results[1].value); sources.outlook = 'ok (' + results[1].value.length + ')'; }
    else sources.outlook = 'error: ' + results[1].reason.message;

    items = items
      .filter(it => !feedback.dismissed[it.id])
      .map(it => ({ ...it, ...classify(it) }));
    const important = items.filter(it => it.keep)
      .sort((a, b) => (a.priority - b.priority) || (Date.parse(b.date) - Date.parse(a.date)));
    return { generatedAt: new Date().toISOString(), lookbackDays: LOOKBACK_DAYS, sources, count: important.length, items: important, learned: Object.keys(feedback.senders).length };
  }

  /* ---------- endpoints ---------- */
  app.get('/mail', async (req, res) => {
    try { res.json(await buildDigest()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/mail/feedback', (req, res) => {
    try {
      const { id, sender, verdict } = req.body || {};
      if (!['spam', 'unimportant', 'task', 'important'].includes(verdict)) return res.status(400).json({ error: 'bad verdict' });
      applyFeedback({ id, sender, verdict });
      res.json({ ok: true, senderWeight: feedback.senders[(sender || '').toLowerCase()] || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/mail/status', (req, res) => {
    res.json({
      gmailConnected: !!(gTokens && gTokens.refresh_token),
      outlookConnected: !!(msTokens && msTokens.refresh_token),
      lookbackDays: LOOKBACK_DAYS, vipCount: VIP.length, llm: USE_LLM,
      learnedSenders: Object.keys(feedback.senders).length,
      dismissed: Object.keys(feedback.dismissed).length,
      connectGmail: '/auth/google/login', connectOutlook: '/auth/ms/login',
    });
  });

  app.get('/mail/view', (req, res) => { res.set('Content-Type', 'text/html').send(DASHBOARD_HTML); });

  console.log('[MAIL] mounted /mail (+feedback/learning) | gmail=' +
    (!!(gTokens && gTokens.refresh_token)) + ' outlook=' + (!!(msTokens && msTokens.refresh_token)) +
    ' learned=' + Object.keys(feedback.senders).length);
}

/* self-contained dashboard with per-item actions (task / not important / spam) */
const DASHBOARD_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Mail · Life</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Libre Franklin',system-ui,sans-serif;min-height:100vh;background:#eef4f3;color:#15302f;
 background-image:radial-gradient(1200px 600px at 100% 0%,rgba(10,138,150,.14),transparent 55%),radial-gradient(900px 700px at 0% 100%,rgba(31,155,88,.12),transparent 52%);padding:28px 18px 60px}
.wrap{max-width:760px;margin:0 auto}
header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.lbl{font-family:'Spline Sans Mono',monospace;font-size:11px;letter-spacing:.5px;color:#6f8a88;text-transform:uppercase}
h1{font-size:26px;font-weight:700;letter-spacing:-.3px}
.sub{color:#4b6b69;font-size:13px;margin:2px 0 18px}
button.reload{font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:8px 14px;border:none;border-radius:10px;background:#0a8a96;color:#fff}
button.reload:hover{background:#055058}
.group{margin:22px 0 6px;font-family:'Spline Sans Mono',monospace;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:#0a6a72}
.card{background:#fbfdfd;border:1px solid #d2e2e0;border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 2px 8px rgba(12,60,58,.05)}
.row1{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.from{font-weight:600;font-size:15px}
.time{color:#7d9694;font-size:12px;white-space:nowrap}
.subj{font-size:14px;margin:3px 0 4px}
.subj a{color:inherit;text-decoration:none}.subj a:hover{text-decoration:underline}
.reason{font-size:12px;color:#4b6b69}
.badge{display:inline-block;font-family:'Spline Sans Mono',monospace;font-size:10px;padding:2px 7px;border-radius:999px;background:#e2efed;color:#0a6a72;margin-left:6px;vertical-align:middle}
.dot{width:7px;height:7px;border-radius:50%;background:#0a8a96;display:inline-block;margin-right:6px}
.acts{display:flex;gap:8px;margin-top:10px}
.acts button{font-family:'Spline Sans Mono',monospace;font-size:11px;cursor:pointer;padding:5px 10px;border-radius:8px;border:1px solid #cADDDA;background:#f2f8f7;color:#0a6a72}
.acts button:hover{background:#e2efed}
.acts .spam{color:#b0463c;border-color:#ecc7c3;background:#fbf1f0}
.empty,.err{background:#fbfdfd;border:1px solid #d2e2e0;border-radius:14px;padding:24px;text-align:center;color:#4b6b69}
.err{color:#cb463c}
.foot{margin-top:18px;font-size:11px;color:#7d9694;font-family:'Spline Sans Mono',monospace}
.connect{color:#0a8a96;font-weight:600}
</style></head><body><div class="wrap">
<header><div><div class="lbl">Stuart Harris</div><h1>Important Mail</h1></div>
<button class="reload" onclick="load()">Reload</button></header>
<div class="sub" id="sub">Loading…</div>
<div id="out"></div>
<div class="foot" id="foot"></div>
</div>
<script>
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const attr=s=>(s||'').replace(/"/g,'&quot;');
function timeAgo(iso){const d=(Date.now()-Date.parse(iso))/6e4;if(d<60)return Math.round(d)+'m';if(d<1440)return Math.round(d/60)+'h';return Math.round(d/1440)+'d';}
let BY={};
async function act(btn,verdict){
  const id=btn.getAttribute('data-id'), it=BY[id]||{};
  try{ await fetch('/mail/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,sender:it.from&&it.from.email,verdict})}); }catch(e){}
  if(verdict==='task'){ try{ if(window.parent&&window.parent!==window) window.parent.postMessage({type:'lp-add-task',subject:it.subject,sender:it.from&&(it.from.name||it.from.email),link:it.link},'*'); }catch(e){} }
  const card=document.getElementById('c_'+id); if(card) card.remove();
}
function card(it){
  const id=it.id; BY[id]=it;
  return '<div class="card" id="c_'+attr(id)+'">'
    +'<div class="row1"><div class="from">'+(it.unread?'<span class=dot></span>':'')+esc(it.from.name||it.from.email)
    +'<span class="badge">'+esc(it.account)+'</span></div><div class="time">'+timeAgo(it.date)+'</div></div>'
    +'<div class="subj"><a href="'+attr(it.link)+'" target="_blank" rel="noopener">'+esc(it.subject)+'</a></div>'
    +(it.reason?'<div class="reason">'+esc(it.reason)+'</div>':'')
    +'<div class="acts"><button data-id="'+attr(id)+'" onclick="act(this,\\'task\\')">→ Task</button>'
    +'<button data-id="'+attr(id)+'" onclick="act(this,\\'unimportant\\')">not important</button>'
    +'<button class="spam" data-id="'+attr(id)+'" onclick="act(this,\\'spam\\')">spam</button></div></div>';
}
async function load(){
  const out=document.getElementById('out'),sub=document.getElementById('sub'),foot=document.getElementById('foot');
  sub.textContent='Loading…';out.innerHTML='';foot.textContent='';BY={};
  try{
    const r=await fetch('/mail',{headers:{'Accept':'application/json'}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    sub.textContent=d.count+' item'+(d.count===1?'':'s')+' need attention · last '+d.lookbackDays+' day'+(d.lookbackDays===1?'':'s');
    if(!d.items.length){out.innerHTML='<div class="empty">Nothing urgent right now. 🎉</div>';}
    else{
      const order=['Needs a reply','Key people','Deadlines & money','Other'];
      const groups={};d.items.forEach(it=>{(groups[it.category]=groups[it.category]||[]).push(it)});
      const keys=Object.keys(groups).sort((a,b)=>order.indexOf(a)-order.indexOf(b));
      out.innerHTML=keys.map(k=>'<div class="group">'+esc(k)+'</div>'+groups[k].map(card).join('')).join('');
    }
    const s=d.sources||{};
    foot.innerHTML='gmail: '+esc(s.gmail||'?')+' &nbsp;·&nbsp; outlook: '+esc(s.outlook||'?')+' &nbsp;·&nbsp; learned senders: '+(d.learned||0)
      +((/not connected|visit/i.test(JSON.stringify(s)))?' &nbsp;·&nbsp; <a class=connect href="/auth/google/login">connect gmail</a> / <a class=connect href="/auth/ms/login">connect outlook</a>':'');
  }catch(e){out.innerHTML='<div class="err">Couldn\\'t load mail: '+esc(e.message)+'</div>';sub.textContent='';}
}
load();
</script></body></html>`;
