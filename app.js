/* ZOBO web app — machinery sourcing and industry expert. Talks to the ZOBO API (Google Apps Script). */
'use strict';

const STEPS = [['Keywords', 'Keywords'], ['Searching', 'Search Baidu and B2B'], ['Identifying', 'Identify companies'], ['Vetting', 'Vet: gates, evidence, score'], ['Writing report', 'Write report']];
let pending = null, polling = null, running = false, dash = null, keep = {}, current = null, draft = null, canApprove = false;
let lastReport = null, chatHist = [], reportOffered = '', dashRefreshedAt = 0;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* ---------- server connection (the ZOBO API in Google Apps Script) ---------- */
const CFG = window.JARVIS_CONFIG || {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: stay signed in for this tab only */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};
let TOKEN = store.get('jarvis_token') || '', ME = null;
/** Call the ZOBO API. Sends text/plain so the browser needs no pre-check request (Apps Script cannot answer one). */
/** True when Apps Script serves this page itself: then requests go through google.script.run to zoboApi. */
const GAS = !!(window.google && google.script && google.script.run);
/*
 * How the app reaches the script. Some office networks change the app's requests: one turns the POST into a plain page
 * visit (Google then answers with its "ZOBO API is running" page), another breaks Google's answer on the way back (404).
 * Three routes, in this order, and the one that works is remembered on this computer:
 *   post    the normal request (fetch POST)
 *   get     the same request as a page visit (fetch GET ?q=...)
 *   script  the answer loaded like a script file (?q=...&cb=...), which behaves exactly like opening the address in a tab
 * A request is repeated another way only when it certainly did not run (the page answer) or when it only reads.
 * Long requests (files) can only go the first way.
 */
const PAGE_REPLY = /ZOBO API is running/;
const GET_MAX = 6000;
const READ_ONLY = /^(ping|me|jobResult|boot|getBoot|getStatus|getDashboard|listReports|listQuotations|photo|photos|progress|getNews|searchMemory|negotiation|vResults|vResult|cart|listUsers|googleNonce|pump)$/;
const ROUTES = ['post', 'get', 'script'];
let TX = store.get('zobo_tx') || (store.get('zobo_get') === '1' ? 'get' : 'post');
if (ROUTES.indexOf(TX) === -1) TX = 'post';
function setTx(t) { TX = t; store.set('zobo_tx', t); }
/** A shorter conversation, so a request fits into an address. */
function slimArgs(args) {
  return (args || []).map(a => Array.isArray(a) && a.length && a.every(x => x && typeof x === 'object' && 'role' in x && 'text' in x)
    ? a.slice(-4).map(x => ({ role: x.role, text: String(x.text || '').slice(0, 500) })) : a);
}
function getUrl(body) { return CFG.apiUrl + (CFG.apiUrl.indexOf('?') === -1 ? '?' : '&') + 'q=' + encodeURIComponent(body); }
const isJson = raw => { try { JSON.parse(raw); return true; } catch (e) { return false; } };
async function viaPost(body) { const res = await fetch(CFG.apiUrl, { method: 'POST', redirect: 'follow', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body }); return { res, raw: await res.text(), status: res.status, how: 'post' }; }
async function viaGet(body) { const res = await fetch(getUrl(body), { method: 'GET', redirect: 'follow', cache: 'no-store' }); return { res, raw: await res.text(), status: res.status, how: 'get' }; }
let scriptN = 0;
function viaScript(body, ms) {
  return new Promise((ok, fail) => {
    const name = '__zobo' + (++scriptN) + '_' + Date.now().toString(36);
    const sc = document.createElement('script');
    let done = false;
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); window[name] = () => { /* a late answer is ignored */ }; sc.remove(); fn(v); };
    window[name] = data => end(ok, { raw: JSON.stringify(data), status: 200, how: 'script' });
    sc.onerror = () => end(fail, new Error('The script route could not load'));
    const timer = setTimeout(() => end(fail, new Error('No answer on the script route')), ms);
    sc.src = getUrl(body) + '&cb=' + name;
    document.head.appendChild(sc);
  });
}
/** Send one request by the route that works here. Returns {raw, status, how} or a failure {err | raw, unsure, tooBig}. */
async function sendApi(action, args, extra) {
  const make = a => JSON.stringify(Object.assign({ action, args: a || [], token: TOKEN }, extra || {}));
  const full = make(args);
  const short = getUrl(full).length <= GET_MAX ? full : make(slimArgs(args));
  const fits = getUrl(short).length <= GET_MAX;
  let last = null;
  for (let i = fits ? ROUTES.indexOf(TX) : 0; i < ROUTES.length; i++) {
    const how = ROUTES[i];
    if (how !== 'post' && !fits) { last = Object.assign(last || {}, { tooBig: true }); break; }
    let r;
    const t0 = Date.now();
    // the script route cannot be cut short by the network, so a long answer is not waited for there more than 2 minutes:
    // the server keeps working and keeps the answer, and the page then fetches it with short requests (job id)
    try { r = how === 'post' ? await viaPost(full) : how === 'get' ? await viaGet(short) : await viaScript(short, action === 'ping' ? 25000 : jobIn(args) ? 120000 : 360000); }
    catch (e) { r = { err: e, how }; }
    if (r.raw && isJson(r.raw)) { if (how !== TX) setTx(how); return r; }
    last = r;
    const notRun = !!(r.raw && PAGE_REPLY.test(r.raw));   // the network turned it into a page visit: it did not run
    // Google answered with a page of its own (a script error, a sign-in page, a removed deployment): not a network cut, so say what it is
    if (!notRun && r.raw && !READ_ONLY.test(action) && /^(script|access|auth|old|limit)$/.test(explainBadReply(r.raw, r.status || 0).kind)) { r.googlePage = true; last = r; break; }
    // never send a change twice. A quick failure means this route does not work here: the next request uses the next route.
    // A failure after a long wait, or a gateway time-out, means the network cut a long answer: the route itself is fine, so it is kept.
    if (!notRun && !READ_ONLY.test(action)) { if (navigator.onLine !== false && fits && i + 1 < ROUTES.length && Date.now() - t0 < 45000 && [502, 503, 504, 524].indexOf(r.status) === -1) setTx(ROUTES[i + 1]); r.unsure = true; r.waited = Date.now() - t0; r.action = action; break; }
  }
  return last || { err: new Error('No route') };
}
/** What to tell the person when no route brought an answer. */
function routeDiag(r) {
  if (r && r.tooBig) return { kind: 'network', title: 'This network does not let the app send large requests', fix: 'The office network changes the app\'s requests, so only short messages get through. Files and long requests work from another network (for example a mobile hotspot). Short questions keep working here.', detail: '' };
  if (r && r.googlePage) return explainBadReply(r.raw || '', r.status || 0);
  if (r && r.unsure) return { kind: 'network', title: 'The network interrupted ZOBO\'s answer', fix: 'ZOBO now uses another route on this computer. Please check whether your last action went through (for example in Reports or Quotations), then try again.',
    detail: 'Action: ' + (r.action || '?') + ' · route: ' + (r.how || '?') + ' · HTTP ' + (r.status || 0) + ' · after ' + Math.round((r.waited || 0) / 1000) + ' s' + (r.err ? ' · ' + String(r.err.message || r.err).slice(0, 120) : '') + (r.raw ? ' · reply: ' + stripTags(r.raw).slice(0, 160) : '') };
  if (r && r.raw && PAGE_REPLY.test(r.raw)) return { kind: 'old', title: 'The server script needs the newest API file', fix: 'This network changes the app\'s requests. The newest script release (2026.10.25 or later) can answer them another way: paste the new API file from the setup guide, then Deploy › Manage deployments › pencil › Version: New version › Deploy.', detail: '' };
  if (r && r.err && !r.raw) return Object.assign(explainNetwork(), { detail: 'Tried: ' + ROUTES.join(', ') + '. Server address: ' + (CFG.apiUrl || '(not set)') });
  return explainBadReply((r && r.raw) || '', (r && r.status) || 0);
}
async function api(action, args, quiet, extra) {
  let res, j;
  if (!GAS && !TOKEN && !LOGIN_CALLS.test(action) && action !== 'ping') throw new Error('Signed out');   // nothing is sent for a person who signed out
  const body = JSON.stringify(Object.assign({ action, args: args || [], token: TOKEN }, extra || {}));
  if (GAS) {
    let text;
    try { text = await new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).zoboApi(body)); }
    catch (e) { if (!quiet) toast('Cannot reach the ZOBO server. Reload the page and try again.'); throw e; }
    try { j = JSON.parse(text); }
    catch (e) { if (!quiet) toast('The server sent an unexpected reply. If the script was just changed, deploy a new version.'); throw e; }
  } else {
    const started = Date.now();
    let r = await sendApi(action, args, extra);
    // A long answer whose wait the network cut: the server keeps it, so fetch it with short requests instead of failing.
    const job = jobIn(args), sess = SESSION;
    const neverRan = r.tooBig || r.googlePage || !!(r.raw && PAGE_REPLY.test(r.raw));   // certainly not run (too big for this network, or turned into a page visit): no waiting
    if (!(r.raw && isJson(r.raw)) && !neverRan && job && action !== 'jobResult') {
      let got = await waitJob(job, started, true, sess);
      // The server says the request never arrived (the network dropped it on the way): send it once more, by the route that works now,
      // but only for the same person: after a sign-out nothing of theirs is sent again.
      if (got && got._resend) {
        got = null;
        if (sess !== SESSION) throw new Error('Signed out');
        const again = await sendApi(action, args, extra);
        if ((again.raw && isJson(again.raw)) || again.tooBig) r = again; else got = await waitJob(job, Date.now(), false, sess);
      }
      if (got) r = { raw: JSON.stringify(got), status: 200, how: 'job' };
    }
    try { j = JSON.parse(r.raw); }
    catch (e) { const d = routeDiag(r); if (!quiet || LOGIN_CALLS.test(action)) problem(d); const er = new Error(d.title + '. ' + d.fix); er.diag = d; throw er; }
  }
  if (j.auth === false) { signOut('Your session has ended. Please sign in again.'); throw new Error(j.error); }
  if (!j.ok) { if (!quiet) toast(j.error); throw new Error(j.error); }
  lastApiAt = Date.now();
  if (STALES[action]) paint.drop(STALES[action]);
  return j.data;
}
function call(fn, ...args) { return api(fn, args); }
/** The job id a long request carries (its last plain-object argument), or ''. */
function jobIn(args) { const o = (args || []).filter(a => a && typeof a === 'object' && !Array.isArray(a)).pop(); return o && typeof o.job === 'string' ? o.job : ''; }
/**
 * Ask every few seconds for the kept answer of a long request, for up to about 7 minutes from its start. Returns {ok, data|error},
 * {_resend: true} when the server says the request never arrived (only if mayResend), or null.
 */
async function waitJob(job, started, mayResend, sess) {
  const t1 = Date.now();
  let unknown = 0;
  while ((sess === undefined || sess === SESSION) && Date.now() - started < 420000) {
    await sleep(unknown ? 4000 : 5000);
    let q = null;
    try { q = await sendApi('jobResult', [job]); } catch (e) { q = null; }
    if (!(q && q.raw && isJson(q.raw))) continue;
    const jj = JSON.parse(q.raw);
    if (jj.auth === false) return jj;
    if (jj.ok === false) return null;   // an older server script keeps no answers
    if (!jj.ok || !jj.data) continue;
    if (jj.data._job === 'running') { unknown = 0; continue; }
    if (jj.data._job === 'unknown') { if (mayResend && ++unknown >= 3 && Date.now() - t1 > 10000) return { _resend: true }; continue; }
    return jj.data;
  }
  return null;
}

/* ---------- speed: remembered answers, shared requests, small helpers ---------- */
let lastApiAt = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Runs the same read once at a time: a second caller waits for the first answer instead of making a second trip to the server. */
const inflight = {};
function once(key, make) { return inflight[key] || (inflight[key] = make().finally(() => { delete inflight[key]; })); }
/** Runs fn over items with at most n at the same time. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
/**
 * The last answers are kept in this browser, for this person only, so a page can draw at once and then refresh itself.
 * Everything is removed when the person signs out. Nothing here is needed: if the browser refuses to store it, pages simply load as before.
 */
const PAINT = 'zobo_pc:', PAINT_AGE = 3 * 24 * 3600 * 1000, PAINT_MAX = 900000;
const paint = {
  key(k) { return PAINT + (store.get('zobo_who') || '') + ':' + k; },
  get(k) { const t = store.get(this.key(k)); if (!t) return null; try { const o = JSON.parse(t); return o && Date.now() - o.t < PAINT_AGE ? o : null; } catch (e) { return null; } },
  set(k, v) {
    let t; try { t = JSON.stringify({ t: Date.now(), v }); } catch (e) { return; }
    if (t.length > PAINT_MAX) return;
    try { localStorage.setItem(this.key(k), t); }
    catch (e) { this.prune(); try { localStorage.setItem(this.key(k), t); } catch (e2) { /* full or private mode: no harm */ } }
  },
  keys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(PAINT) === 0) out.push(k); } } catch (e) { /* ignore */ } return out; },
  /** Forget the remembered answers whose name starts with one of these. */
  drop(prefixes) { const who = PAINT + (store.get('zobo_who') || '') + ':'; this.keys().forEach(k => { if (prefixes.some(p => k.indexOf(who + p) === 0)) store.del(k); }); },
  /** Free room: remove the oldest half. */
  prune() {
    const all = this.keys().map(k => { let t = 0; try { t = JSON.parse(localStorage.getItem(k)).t; } catch (e) { /* unreadable: oldest */ } return [k, t]; }).sort((a, b) => a[1] - b[1]);
    all.slice(0, Math.max(1, Math.ceil(all.length / 2))).forEach(x => store.del(x[0]));
  },
  clear() { this.keys().forEach(k => store.del(k)); }
};
/** Which remembered answers go out of date when an action changes the data. */
const STALES = { proceed: ['dash:', 'reports'], feedback: ['dash:'], savePayback: ['dash:'], runDebate: ['dash:'], runImport: ['dash:'], refreshMedia: ['dash:'],
  submitRequirement: ['quotes'], sendRfq: ['quotes', 'dash:'], sendCounter: ['quotes'], negotiate: ['quotes'], startSourcing: ['reports'], stopRun: ['reports'] };
/**
 * Stale-while-revalidate: draws the remembered answer at once (show(value, true)), asks the server, and draws again only if the answer changed (show(value, false)).
 * Resolves with the fresh answer; rejects only when the server failed and nothing was remembered.
 */
async function swr(key, fetcher, show) {
  const old = paint.get(key);
  let shown = null;
  if (old) { shown = JSON.stringify(old.v); show(old.v, true); }
  let fresh;
  try { fresh = await once('swr:' + key, () => fetcher(!!old)); }
  catch (e) { if (old) return old.v; throw e; }
  paint.set(key, fresh);
  if (JSON.stringify(fresh) !== shown) show(fresh, false);
  return fresh;
}
function toast(t, good) { const el = $('toast'); el.textContent = t; el.classList.toggle('good', !!good); el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 7000); }

/* ---------- server check: says exactly what is wrong when the server does not answer with data ---------- */
const LOGIN_CALLS = /^(me|boot|requestCode|verifyCode|googleNonce|googleSignIn|ping)$/;
const APP_BUILD = '2026.10.38';   // this page's own release
const WANT_BUILD = '2026.10.05';   // Google sign-in and the People page need 2026.10.15; older scripts simply do not offer them   // the oldest script release this app works with (the server reports its own as "build")
const stripTags = h => String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function explainNetwork() {
  if (navigator.onLine === false) return { kind: 'offline', title: 'No internet connection', fix: 'Check the internet connection and press Check again.', detail: '' };
  return { kind: 'network', title: 'The browser could not read the server\'s answer',
    fix: 'Open the server address below in a private window. If it says "ZOBO API is running", press Check again. If Google asks you to sign in, set the web app to "Who has access: Anyone" (Deploy › Manage deployments › pencil). If you see an error page, the address in config.js is not a deployed web app address ending in /exec.',
    detail: 'Server address: ' + (CFG.apiUrl || '(not set)') };
}
function explainBadReply(raw, status) {
  const t = stripTags(raw), d = (t || '(empty reply)').slice(0, 320) + ' [HTTP ' + status + ']';
  const mk = (kind, title, fix) => ({ kind, title, fix, detail: d });
  if (/ServiceLogin|accounts\.google\.com|Sign in|Choose an account/i.test(raw)) return mk('access', 'Google is asking for a sign-in instead of answering', 'Open the Apps Script editor, then Deploy › Manage deployments › pencil on the Web app. Set "Execute as: Me" and "Who has access: Anyone", choose Version "New version", and press Deploy.');
  if (/Script function not found/i.test(t)) return mk('old', 'The deployed script is an old version', 'The live deployment has no doPost. In the editor choose Deploy › Manage deployments › pencil on the Web app › Version: New version › Deploy. Do not use "New deployment" (it makes a different address).');
  if (/authori[sz]ation (is )?required|needs? (your )?(permission|authori)|Review permissions/i.test(t)) return mk('auth', 'The script needs permission to run', 'In the Apps Script editor pick the function authorize, press Run and click Allow. Then Deploy › Manage deployments › pencil › New version › Deploy.');
  if (/unable to open the file|file you have requested|does not exist|Page Not Found|Error 404|No script found/i.test(t)) return mk('address', 'The server address is wrong or its deployment was removed', 'In the editor open Deploy › Manage deployments, copy the Web app URL (ending in /exec) and paste it into config.js on GitHub, between the quotation marks.');
  if (/SyntaxError|ReferenceError|TypeError|RangeError|is not defined|already been declared|before initialization|Unexpected (token|identifier)/i.test(t)) return mk('script', 'The script has an error and does not start', 'Each of the six files must be pasted whole, once: Code, AI, Agent, Web, API, Advanced (delete the old Index file). Save with Ctrl+S, run authorize, then deploy a New version. The detail below names the line.');
  if (/Exceeded maximum execution time|Service invoked too many times|quota|too many (requests|simultaneous)|rate limit/i.test(t)) return mk('limit', 'Google\'s free limit was reached for a moment', 'Wait a minute and press Check again. Google resets these limits by itself.');
  if (/Exception:|Error:/i.test(t)) return mk('script', 'The script stopped with an error', 'Open the Apps Script editor › Executions to see the same message with its line. Fix or re-paste that file, then deploy a New version.');
  return mk('other', 'Google sent a web page instead of data', 'Press Check again. If it repeats, open the Apps Script editor › Deploy › Manage deployments and deploy a New version, then run authorize once.');
}
function problem(d) {
  const b = $('netbanner');
  if (!b) { toast(d.title + '. ' + d.fix); return; }
  $('nbTitle').textContent = d.title; $('nbFix').textContent = d.fix;
  $('nbDetail').textContent = d.detail || ''; $('nbDetailWrap').style.display = d.detail ? 'block' : 'none';
  b.style.display = 'block'; b._diag = d;
  try { console.error('[ZOBO server]', d.kind, d.title, d.detail); } catch (e) { /* ignore */ }
}
function closeBanner() { const b = $('netbanner'); if (b) b.style.display = 'none'; }
function copyDiag() {
  const b = $('netbanner'), d = (b && b._diag) || {};
  const text = ['ZOBO server check', 'Problem: ' + (d.title || ''), 'Advice: ' + (d.fix || ''), 'Detail: ' + (d.detail || ''), 'Time: ' + new Date().toISOString(), 'App release: ' + APP_BUILD + ' · server release: ' + (SERVER_BUILD || 'unknown')].join('\n');
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it into your message.'), () => toast('Could not copy. Select the text and copy it.'));
  else toast('Could not copy. Select the text and copy it.');
}
/** Asks the server's ping and says what it found. Shown on the sign-in page and by the banner's Check again button. */
let PING = null;   // the server's last ping answer (release, Google sign-in client ID)
async function serverCheck(fromBanner) {
  const line = $('serverLine');
  if (line) { line.className = 'srvline'; line.textContent = 'Checking the server…'; }
  let res, raw = '', j, diag = null;
  const sent = await sendApi('ping', [], {});
  raw = sent.raw || '';
  try { j = JSON.parse(raw); } catch (e) { diag = routeDiag(sent); }
  if (!diag && !(j && j.ok)) diag = { kind: 'api', title: 'The server answered with an error', fix: String((j && j.error) || 'Unknown error'), detail: '' };
  if (!diag) {
    const build = String((j.data && j.data.build) || '');
    if (build && build < WANT_BUILD) diag = { kind: 'old', title: 'The server script is older than this app', fix: 'Server script release ' + build + ', the app needs ' + WANT_BUILD + ' or newer. Paste the newest script files, then Deploy › Manage deployments › pencil › Version: New version › Deploy.', detail: '' };
  }
  if (diag) {
    if (line) { line.className = 'srvline bad'; line.textContent = 'Server problem: ' + diag.title + '.'; }
    problem(diag);
    return false;
  }
  PING = j.data || {};
  if (line) { line.className = 'srvline ok'; line.textContent = 'Server connected' + (j.data.build ? ' (script release ' + j.data.build + ')' : '') + '.'; }
  closeBanner();
  if (fromBanner) toast('The server is answering. You can carry on.');
  return true;
}
const VIEWS = ['login', 'setup', 'assist', 'reports', 'dash', 'form', 'email', 'done', 'expert', 'quotes', 'people', 'mine', 'vexpert', 'cart'];
const NAV_OF = { assist: 'assist', reports: 'reports', dash: 'dash', form: 'dash', email: 'dash', done: 'dash', expert: 'expert', quotes: 'quotes', people: 'people', mine: 'mine', vexpert: 'vexpert', cart: 'cart' };
function show(v) {
  VIEWS.forEach(x => { const el = $(x); if (el) el.classList.toggle('on', x === v); });
  document.body.classList.toggle('authed', v !== 'login' && v !== 'setup');
  document.querySelectorAll('[data-nav]').forEach(b => { const on = b.dataset.nav === NAV_OF[v]; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const titles = { assist: 'Assistant', reports: 'Reports', dash: 'Report', form: 'Request a quotation', email: 'Quotation email', done: 'Sent', expert: 'Industry Expert', quotes: 'Quotations', people: 'People', mine: 'My results', vexpert: 'Expert', cart: 'Cart' };
  document.title = (titles[v] ? titles[v] + ' · ' : '') + 'ZOBO';
}

/* ---------- conversation ---------- */
function say(text, from, links, files) {
  if ((from || 'agent') === 'agent') hideTyping();
  const d = msgEl(text, from, links, files);
  $('msgs').appendChild(d); $('msgs').scrollTop = 1e9;
  if ((from || 'agent') === 'agent') speak(text);
  return d;
}
/** One chat bubble: the text, the person's attached files, and clickable numbered sources. */
function msgEl(text, from, links, files) {
  const d = document.createElement('div'); d.className = 'msg ' + (from || 'agent'); d.textContent = text;
  if (files && files.length) {   // what the person attached: small pictures and file names
    const row = document.createElement('div'); row.className = 'msgfiles';
    files.forEach(f => {
      const c = document.createElement('span'); c.className = 'msgfile';
      if (f.thumb) { const im = document.createElement('img'); im.src = f.thumb; im.alt = ''; c.appendChild(im); }
      c.appendChild(document.createTextNode(f.name)); row.appendChild(c);
    });
    d.appendChild(row);
  }
  const ok = (links || []).filter(l => l && /^https?:\/\//i.test(String(l.url || '')));
  if (ok.length) {   // numbered sources the person can open
    const box = document.createElement('div'); box.className = 'srcs';
    box.appendChild(document.createTextNode('Sources: '));
    ok.forEach((l, i) => {
      const a = document.createElement('a'); a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = '[' + (l.n || i + 1) + '] ' + String(l.site || l.title || '').slice(0, 60); a.title = String(l.title || '');
      box.appendChild(a); if (i < ok.length - 1) box.appendChild(document.createTextNode(' '));
    });
    d.appendChild(box);
  }
  return d;
}
let voiceInput = false;
function setVoiceState(state) {   // state: 'speaking' | 'listening' | ''
  document.body.classList.toggle('speaking', state === 'speaking');
  document.body.classList.toggle('listening', state === 'listening');
  const pip = $('voicePip');
  const lab = $('orbLabel');
  if (lab) { if (state) { if (!lab.dataset.prev) lab.dataset.prev = lab.textContent; lab.textContent = state === 'speaking' ? 'SPEAKING' : 'LISTENING'; } else if (lab.dataset.prev) { lab.textContent = lab.dataset.prev; delete lab.dataset.prev; } }
  if (pip) { pip.hidden = !state || $('assist').classList.contains('on'); $('pipText').textContent = state === 'speaking' ? 'ZOBO is speaking' : state === 'listening' ? 'Listening…' : ''; }
}
const IDENTITY_RE = /\b(who\s+are\s+(you|u)|what\s+are\s+you|what('|\s+i)?s\s+your\s+name|your\s+name|introduce\s+yourself|who\s+is\s+zobo|what\s+is\s+zobo|tell\s+me\s+about\s+yourself|(aap|tum)\s+kaun)\b/i;
const IDENTITY_LINE = 'I am ZOBO, the AI agent for Zonac Knitting Production, an India-based company in Greater Noida. How can I help you today?';
function hud(label, head, sub, live) {
  if (label !== 'THINKING') hideTyping();
  const lab = $('orbLabel');
  if (lab.dataset.prev) lab.dataset.prev = label; else lab.textContent = label;   // while speaking or listening, the new label shows when that ends
  $('headline').textContent = head; $('subline').textContent = sub;
  $('orb').className = 'orb' + (live ? ' live' : '') + (running ? ' run' : '');
}
/* bumped at sign-out: an answer that arrives later belongs to the person who asked, not to the next one */
let SESSION = 0;
async function sendText(byVoice) {
  const t = $('cmd').value.trim();
  if (ATTACH.some(f => f.busy)) { toast('One moment: the file is still being read.'); return; }
  const files = ATTACH.slice();
  if (!t && !files.length) return;
  $('cmd').value = '';
  say(t || (files.length > 1 ? 'Files attached' : 'File attached'), 'you', null, files);
  clearAttach();
  if (isViewer() && viewerUiReady()) return viewerSend(t, files, byVoice);
  if (!modesReady()) {   // the server script is older than the three modes: the earlier behaviour
    if (files.length) say('Reading files needs the new server script (release ' + MODES_BUILD + '). Ask the admin to paste the new script files and deploy a New version.');
    if (t) return legacySend(t, byVoice);
    return;
  }
  return modeSend(t, files, byVoice);
}
/** The earlier Assistant (one mode, deep research as a switch), used while the server script is older than release 2026.10.16. */
async function legacySend(t, byVoice) {
  const sess = SESSION;
  voiceInput = !!byVoice;
  if (isIdentity(t)) { say(identityLine(t)); hud('ONLINE', 'How can I help you today?', SUB_LINE); return; }
  const dc = deepCommand(t);
  if (dc && dc.mode !== 'once') { deepApply(dc, false, wantsHindi(t)); return; }
  const deepNow = deepMode || !!dc, q = dc ? dc.q : t;
  if (!running && !(pending && isYes(t))) showTyping(deepNow ? 'Deep research: planning' : '');
  if (running) { const s = await call('getStatus'); say(s ? s.message : 'Working on it.'); return; }
  if (pending && isYes(t)) return go();
  // With a report available (and no request waiting for a yes), ZOBO first checks whether this is a question about it.
  if (!pending) {
    hud('THINKING', deepNow ? 'Deep research' : 'Thinking', deepNow ? 'Planning the research' : '', true);
    let a, stopWatch = null;
    const job = newJob();   // every answer carries a job id, so a reply the network cuts can still be fetched
    if (deepNow) stopWatch = watchProgress(job, p => { hud('THINKING', 'Deep research', p.text, true); typingLabel('Deep research: ' + p.text); });
    try { a = await call('askJarvis', q, lastReport || (dash && dash.reqId) || null, chatHist, deepNow ? { deep: true, job } : { job }); }
    catch (e) { if (stopWatch) stopWatch(); if (sess === SESSION) { hud('ONLINE', 'Ask me anything', 'about the report, or name anything to buy'); say(wantsHindi(t) ? 'माफ़ कीजिए, अभी जवाब नहीं मिल पाया। कृपया फिर से पूछिए।' : 'Sorry, I could not get an answer just now. Please ask again.'); } return; }
    if (sess !== SESSION) { if (stopWatch) stopWatch(); return; }
    if (a.type === 'industry') {
      hud('THINKING', deepNow ? 'Deep research' : 'Researching', deepNow ? 'Searching the web in several rounds' : 'Checking the latest industry sources', true);
      let x;
      try { x = await call('askExpert', q, chatHist, deepNow ? { deep: true, job } : null); } catch (e) { if (stopWatch) stopWatch(); if (sess === SESSION) { hud('ONLINE', 'Ask me anything', ''); say(wantsHindi(t) ? 'माफ़ कीजिए, अभी जवाब नहीं मिल पाया। कृपया फिर से पूछिए।' : 'Sorry, I could not get an answer just now. Please ask again.'); } return; }
      if (stopWatch) stopWatch();
      if (sess !== SESSION) return;
      chatHist.push({ role: 'user', text: q }, { role: 'jarvis', text: x.answer });
      say(x.answer + sourcesLine(x, 'Full links in the Industry Expert tab.') + (x.deep ? '\n' + deepMeta(x) : ''));
      expertItems.push({ q, x });
      hud('ONLINE', 'Ask me anything', 'any product, the industry, or the report');
      return;
    }
    if (stopWatch) stopWatch();
    if (a.type === 'answer') {
      chatHist.push({ role: 'user', text: q }, { role: 'jarvis', text: a.answer });
      say(a.answer + (a.deep ? sourcesLine(a) + '\n' + deepMeta(a) : ''));
      hud('ONLINE', 'Ask me anything', 'about the report, or name anything to buy');
      return;
    }
  }
  if (ME && !ME.can.start) { say('Your role is ' + ME.role + ': you can ask me anything, but only buyers can start a new supplier search. Ask your admin if you need that.'); hud('ONLINE', 'Ask me anything', ''); return; }
  hud('THINKING', 'Reading your request', '', true);
  try {
    const said = pending && pending.said ? pending.said + '. ' + q : q;   // more details for the request waiting for a yes are added to it, not a new request
    const r = await call('interpretRequest', said);
    if (sess !== SESSION) return;                                          // signed out meanwhile: not for this person
    r.said = said;
    if (deepNow || (pending && pending.deep)) r.deep = true;
    if (!r.machine && pending) { say(wantsHindi(t) ? 'मैंने अनुरोध में यह जोड़ने की कोशिश की, पर यह समझ नहीं आया कि क्या खरीदना है। पिछला अनुरोध बना हुआ है: ' + pending.machine + '। शुरू करने के लिए "हाँ" कहिए।' : 'I could not add that to the request. The request is still: ' + pending.machine + '. Say yes to start, or tell me the full request again.'); hud('ONLINE', 'Shall I start?', pending.machine); return; }
    if (!r.machine) { pending = null; $('confirm').style.display = 'none'; say(wantsHindi(t) ? 'मुझे समझ नहीं आया कि क्या खरीदना है। आपको कौन-सी मशीन या कौन-सा प्रोडक्ट चाहिए?' : 'I did not catch what to buy. Which machine or product do you need?'); hud('ONLINE', 'What do you need to buy?', SUB_LINE); return; }
    pending = r;
    let m = r.readback || ('I heard: ' + r.machine);
    const hiR = isHindi(m) || wantsHindi(t);
    if (r.key_specs_missing && r.key_specs_missing.length) m += '\n' + (r.question || ((hiR ? 'सही मॉडल चुनने के लिए मुझे ये चाहिए: ' : 'To pick the right model I need: ') + r.key_specs_missing.join(', ') + '.')) + (hiR ? ' ये जोड़कर पूरी रिक्वेस्ट दोबारा बताइए, या ऐसे ही शुरू करने के लिए "हाँ" कहिए।' : ' Tell me the full request again with these, or say yes to start anyway.');
    else if (r.missing && r.missing.length) m += hiR ? '\nयह भी बता दें तो बेहतर होगा: ' + r.missing.join(', ') + '। बताइए, या शुरू करने के लिए "हाँ" कहिए।' : '\nIt would help to know: ' + r.missing.join(', ') + '. Tell me, or say yes to start anyway.';
    else m += hiR ? '\nक्या मैं शुरू करूँ?' : '\nShall I start?';
    if (r.deep) m += hiR ? '\n(डीप रिसर्च मोड: ज़्यादा गहरी जाँच, आमतौर पर 5 से 10 मिनट।)' : '\n(Deep research mode: a deeper check that usually takes 5 to 10 minutes.)';
    say(m);
    $('confirm').style.display = 'flex'; $('quickBtn').style.display = 'none';
    hud('ONLINE', 'Shall I start?', r.machine);
  } catch (e) { if (sess === SESSION) { hud('ONLINE', 'What do you need to buy?', SUB_LINE); say(wantsHindi(t) ? 'माफ़ कीजिए, मैं अनुरोध पढ़ नहीं पाया। कृपया फिर से बताइए।' : 'Sorry, I could not read the request just now. Please say it again.'); } }
}
/** Stop the running supplier search (the report so far is kept if it is already written). */
async function stopSourcing() {
  if (!running || !confirm('Stop the supplier search that is running now?')) return;
  const b = $('stopRunBtn'); if (b) b.disabled = true;
  try { const s = await call('stopRun'); if (s) render(s); }
  catch (e) { /* the message is shown by call */ }
  finally { if (b) b.disabled = false; }
}
function changeReq() { $('confirm').style.display = 'none'; pending = null; say('Sure. Tell me the full request again with the change.'); }

/* ---------- the three modes: Chat, Deep research and Advanced (chosen only with the buttons) ---------- */
const MODES_BUILD = '2026.10.16';   // the script release with the three modes and file reading
const modesReady = () => !!SERVER_BUILD && SERVER_BUILD >= MODES_BUILD;
let MODE = 'chat';
const modeKey = () => 'zobo_mode:' + (store.get('zobo_who') || '');
const MODE_INFO = {
  chat: { head: 'Ask me anything', sub: 'Chat mode: quick answers on any topic', place: 'Ask anything, or attach a file or photo',
    hint: 'Chat: answers any question quickly, and looks things up on Google when needed.',
    hi: 'चैट मोड: किसी भी विषय पर तुरंत जवाब।', on: 'Chat mode: I answer any question quickly, and look things up on Google when needed.' },
  deep: { head: 'Deep research', sub: 'Any product, machine, material or industry topic, with sources', place: 'Ask about any product, machine, material or topic',
    hint: 'Deep research: several rounds of web search in English and Chinese, the best pages read, every fact with its source. About 1 to 3 minutes.',
    hi: 'डीप रिसर्च मोड: कोई भी प्रोडक्ट, मशीन, मटीरियल या उद्योग की जानकारी, स्रोतों के साथ। जवाब में 1 से 3 मिनट।', on: 'Deep research mode: I research any product, machine, material or industry topic on the web in English and Chinese, and give every fact with its source. An answer takes about 1 to 3 minutes.' },
  advanced: { head: 'Advanced: top five, compared, final pick', sub: 'Name the task, or attach a photo, spec sheet or quotation', place: 'Tell me the task, or attach a photo or file',
    hint: 'Advanced: finds the top five, compares them and gives a final choice. Anything to buy (a machine, spare parts, yarn, elastic, packaging or any product) runs the full Chinese supplier search (usually 5 to 10 minutes). Attach a photo, label, spec sheet or quotation and say what to do.',
    hi: 'एडवांस्ड मोड: टॉप पाँच ढूँढकर तुलना और अंतिम चुनाव। फ़ोटो या फ़ाइल जोड़कर बताइए क्या करना है।', on: 'Advanced mode: I find the top five, compare them and give a final choice. For anything to buy (a machine, spare parts, yarn, elastic, packaging or any other product) I run the full supplier search: the top five Chinese makers found, vetted and compared, with the committee\'s final pick (usually 5 to 10 minutes). You can attach a photo, a spec sheet or a quotation and tell me what to do with it.' }
};
function idleHud() {
  if (isViewer()) { hud('ONLINE', 'Ask me anything', 'Questions, web search and shopping'); return; }
  const m = MODE_INFO[MODE]; hud('ONLINE', pending ? 'Shall I start?' : m.head, pending ? pending.machine : m.sub);
}
function modeUi() {
  document.querySelectorAll('.modebar [data-mode]').forEach(b => { const on = b.dataset.mode === MODE; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
  const m = MODE_INFO[MODE], v = isViewer();
  if ($('modeHint')) $('modeHint').textContent = v ? 'Ask anything, or tell me what you want to buy: I search the web and show products you can add to your cart and buy on the seller\'s own site.' : m.hint;
  if ($('cmd')) $('cmd').placeholder = v ? 'Ask anything, or what do you want to buy?' : m.place;
  document.body.dataset.mode = MODE;
  if ($('steps')) $('steps').style.display = !isViewer() && (MODE === 'advanced' || running || !modesReady()) ? '' : 'none';   // the supplier-search steps belong to Advanced
  deepChipState();
  if (!running && $('assist').classList.contains('on')) idleHud();
}
/** The mode this person used last on this computer (an earlier "deep research on" counts as Deep research). */
function loadMode() {
  const m = store.get(modeKey());
  MODE = MODE_INFO[m] ? m : store.get(deepKey()) === '1' ? 'deep' : 'chat';
  deepMode = MODE !== 'chat';
  modeUi();
}
function setMode(m, quiet, hindi) {
  if (!MODE_INFO[m]) return;
  const changed = m !== MODE;
  MODE = m; deepMode = m !== 'chat';
  store.set(modeKey(), m); store.set(deepKey(), deepMode ? '1' : '0');
  modeUi();
  if (quiet || !changed) return;
  if (!modesReady() && SERVER_BUILD) toast('The three modes need server script release ' + MODES_BUILD + ' (the server has ' + SERVER_BUILD + '). Until it is updated, ZOBO works as before.');
  if ($('assist').classList.contains('on')) say(hindi || LANG === 'hi-IN' ? MODE_INFO[m].hi : MODE_INFO[m].on);
}
/** Arrow keys move between the three mode buttons (a radio group). */
document.addEventListener('keydown', e => {
  const b = e.target.closest && e.target.closest('.modebar [data-mode]');
  if (!b || !/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key)) return;
  e.preventDefault();
  const order = ['chat', 'deep', 'advanced'], i = order.indexOf(MODE);
  const next = e.key === 'Home' ? 'chat' : e.key === 'End' ? 'advanced' : order[(i + (/Right|Down/.test(e.key) ? 1 : 2)) % 3];
  setMode(next, true);   // the hint under the buttons (read out by screen readers) says what the mode does
  const nb = document.querySelector('.modebar [data-mode="' + next + '"]'); if (nb) nb.focus();
});

/** One message in the chosen mode. A "deep research on X" message is one deep answer, whatever the mode. */
async function modeSend(t, files, byVoice) {
  const sess = SESSION;
  voiceInput = !!byVoice;
  if (t && !files.length && isIdentity(t)) { say(identityLine(t)); idleHud(); return; }
  const dc = t && !files.length ? deepCommand(t) : null;
  if (dc && dc.mode !== 'once') { deepApply(dc, false, wantsHindi(t)); return; }
  if (pending && t && !files.length && isYes(t)) return go();
  const mode = dc ? 'deep' : MODE, q = dc ? dc.q : t;
  // While a supplier search runs, a status question gets the status; anything else is answered as usual (a new search then waits its turn).
  if (mode === 'advanced' && running && !files.length && /^\s*(status|progress|update|how far|is it done|kitna hua|kahan tak|kya hua|kab tak|स्टेटस|कितना हुआ|कहाँ तक)\b/i.test(q || '')) {
    const s = await call('getStatus');
    say(s ? s.message : 'Working on it.');
    return;
  }
  if (mode === 'advanced' && pending && !files.length && q) return advancedRequest(pending.said + '. ' + q, pending.from_file || '');   // more details for the request waiting for a yes
  return modeAsk(mode, q, files, sess, null);
}
async function modeAsk(mode, q, files, sess, task, look) {   // look: {prefix} = a quick look shown while a full supplier search runs
  const label = mode === 'advanced' ? 'Advanced' : mode === 'deep' ? 'Deep research' : 'Thinking';
  showTyping(files.length ? 'Reading the file' + (files.length > 1 ? 's' : '') : mode === 'chat' ? '' : label + ': planning');
  hud('THINKING', label, files.length ? 'Reading the files' : mode === 'chat' ? '' : 'Planning the research', true);
  const job = newJob();   // Chat too: a reply the network cuts can still be fetched
  const stopWatch = mode !== 'chat' ? watchProgress(job, p => { hud('THINKING', label, p.text, true); typingLabel(label + ': ' + p.text); }) : null;
  let a;
  try { a = await api('assist', [mode, q, files.map(f => f.payload), chatHist.slice(-10), { job, reqId: lastReport || (dash && dash.reqId) || null, task }], true); }
  catch (e) {
    if (stopWatch) stopWatch();
    if (sess !== SESSION) return;
    hideTyping(); idleHud();
    const m = String((e && e.message) || '');
    if (look) return;   // a quick look that failed is simply left out: the full search goes on
    if (e && e.diag && e.diag.kind !== 'network') problem(e.diag);   // a server-side problem (script error, sign-in page): show what it is
    say(/file|Gemini|big|read|attach/i.test(m) ? m : wantsHindi(q) ? 'माफ़ कीजिए, अभी जवाब नहीं मिल पाया। कृपया फिर से पूछिए।' : 'Sorry, I could not get an answer just now. Please ask again.');
    return;
  }
  if (stopWatch) stopWatch();
  if (sess !== SESSION) return;
  if (a && a.type === 'new_request') { hideTyping(); if (look) return; return advancedRequest(a.said, a.fromFile || ''); }
  const asked = q || 'Files: ' + files.map(f => f.name).join(', ');
  chatHist.push({ role: 'user', text: asked + (a.fileNote ? '\n[' + a.fileNote + ']' : '') }, { role: 'jarvis', text: a.answer });
  if (chatHist.length > 20) chatHist = chatHist.slice(-20);
  say((look ? look.prefix : '') + a.answer + (a.deep ? '\n\n' + deepMeta(a) : ''), 'agent', a.sources);
  if (mode !== 'chat') expertItems.push({ q: asked, x: a });   // also listed on the Industry Expert page
  idleHud();
}
/** Advanced mode, a machine to buy: read the request (with what the file showed), then ask "Shall I start?". */
async function advancedRequest(said, fromFile) {
  const sess = SESSION;
  if (ME && !ME.can.start) {
    say('Your role is ' + ME.role + ': only buyers can start the full supplier search. Here is a researched top-five comparison instead.');
    return modeAsk('advanced', said, [], sess, 'compare');
  }
  showTyping('Reading your request'); hud('THINKING', 'Reading your request', '', true);
  let r;
  try { r = await call('interpretRequest', said); }
  catch (e) { if (sess === SESSION) { hideTyping(); idleHud(); say('Sorry, I could not read the request just now. Please say it again.'); } return; }
  if (sess !== SESSION) return;
  hideTyping();
  r.said = said; r.deep = true; if (fromFile) r.from_file = fromFile;
  if (!r.machine) { pending = null; $('confirm').style.display = 'none'; say(isHindi(said) ? 'मुझे समझ नहीं आया कि क्या ढूँढना है। आपको कौन-सी मशीन या कौन-सा प्रोडक्ट चाहिए?' : 'I did not catch what to find. Which machine or product do you need? You can also attach a photo, label or spec sheet.'); idleHud(); return; }
  pending = r;
  let m = r.readback || ('I heard: ' + r.machine);
  const hiR = isHindi(m) || wantsHindi(said);
  if (r.key_specs_missing && r.key_specs_missing.length) m += '\n' + (r.question || ((hiR ? 'सही मॉडल चुनने के लिए मुझे ये चाहिए: ' : 'To pick the right model I need: ') + r.key_specs_missing.join(', ') + '.')) + (hiR ? ' बताइए, या ऐसे ही शुरू करने के लिए "हाँ" कहिए।' : ' Tell me, or say yes to start anyway.');
  else if (r.missing && r.missing.length) m += hiR ? '\nयह भी बता दें तो बेहतर होगा: ' + r.missing.join(', ') + '। बताइए, या शुरू करने के लिए "हाँ" कहिए।' : '\nIt would help to know: ' + r.missing.join(', ') + '. Tell me, or say yes to start anyway.';
  else m += hiR ? '\nक्या मैं शुरू करूँ?' : '\nShall I start?';
  m += hiR ? '\n(पूरी सप्लायर खोज: टॉप पाँच चीनी निर्माता ढूँढकर जाँच, तुलना और कमेटी का अंतिम चुनाव, आमतौर पर 5 से 10 मिनट। जल्दी चाहिए तो "Quick top-5 comparison" दबाइए, 2 से 3 मिनट।)'
    : '\n(The full supplier search finds the top five Chinese makers, vets and compares them, and the committee makes the final pick: usually 5 to 10 minutes. For a quick researched comparison instead, press "Quick top-5 comparison": 2 to 3 minutes.)';
  say(m);
  $('confirm').style.display = 'flex'; $('quickBtn').style.display = '';
  hud('ONLINE', 'Shall I start?', r.machine);
}
/** Instead of the full supplier search: a researched top-five comparison of the waiting request, in a few minutes. */
function quickCompare() {
  if (!pending) return;
  const f = pending; pending = null;
  $('confirm').style.display = 'none';
  say('Quick top-5 comparison', 'you');
  modeAsk('advanced', f.said || f.machine, [], SESSION, 'compare');
}

/* ---------- attach files and photos (button, paste or drag and drop) ---------- */
let ATTACH = [];
const ATTACH_MAX = 4, FILE_MAX = 10 * 1024 * 1024;
function pickFiles() { if (!modesReady() && SERVER_BUILD) { toast('Attaching files needs server script release ' + MODES_BUILD + '. Ask the admin to update the script.'); return; } $('fileIn').click(); }
function clearAttach() { ATTACH = []; drawAttach(); }
function removeAttach(id) { ATTACH = ATTACH.filter(x => x.id !== id); drawAttach(); }
function drawAttach() {
  const row = $('attachRow'); if (!row) return;
  row.style.display = ATTACH.length ? 'flex' : 'none';
  row.innerHTML = ATTACH.map(f => '<span class="achip' + (f.busy ? ' busy' : '') + '">' + (f.thumb ? '<img src="' + esc(f.thumb) + '" alt="">' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4"/></svg>') +
    '<span class="aname">' + esc(f.name) + '</span><span class="asize">' + (f.busy ? 'reading…' : fmtSize(f.size)) + '</span>' +
    '<button type="button" aria-label="Remove ' + esc(f.name) + '" onclick="removeAttach(\'' + f.id + '\')">×</button></span>').join('');
}
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
async function addFiles(list) {
  const sess = SESSION;
  for (const file of Array.from(list || [])) {
    if (sess !== SESSION) return;   // signed out meanwhile: nothing carries over to the next person
    if (ATTACH.length >= ATTACH_MAX) { toast('Up to ' + ATTACH_MAX + ' files at a time.'); break; }
    if (file.size > FILE_MAX) { toast(file.name + ' is bigger than 10 MB. Please send a smaller file.'); continue; }
    const item = { id: newJob(), name: file.name || 'Pasted picture.png', size: file.size, busy: true, thumb: '' };
    ATTACH.push(item); drawAttach();
    try { item.payload = await readForZobo(file, item); }
    catch (e) { ATTACH = ATTACH.filter(x => x !== item); if (sess === SESSION) toast(e.message || 'Could not read ' + item.name + '.'); }
    if (sess !== SESSION) { ATTACH = ATTACH.filter(x => x !== item); drawAttach(); return; }
    item.busy = false; drawAttach();
  }
  if ($('fileIn')) $('fileIn').value = '';
  if ($('cmd')) $('cmd').focus();
}
function b64Of(blob) { return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => fail(new Error('Could not read the file.')); r.readAsDataURL(blob); }); }
/** Photos are made smaller (at most 1600 pixels, JPEG) so they travel fast; a picture the browser cannot open goes as it is. */
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return { type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.86).split(',')[1] };
  } catch (e) { return { type: (file.type || 'image/jpeg').toLowerCase(), data: await b64Of(file) }; }
}
const libs = {};
function loadLib(src, name) {
  return libs[src] || (libs[src] = new Promise((ok, fail) => {
    if (window[name]) { ok(); return; }
    const sc = document.createElement('script'); sc.src = src; sc.async = true;
    sc.onload = () => (window[name] ? ok() : fail(new Error('reader missing')));
    sc.onerror = () => { delete libs[src]; fail(new Error('The file reader could not load. Save the file as PDF and attach that.')); };
    document.head.appendChild(sc);
  }));
}
/** What is sent for one file: photos and PDFs as they are (base64); Word, Excel and text files as their text. */
async function readForZobo(file, item) {
  const name = item.name, type = String(file.type || '').toLowerCase(), ext = (name.split('.').pop() || '').toLowerCase();
  if (/^image\/(jpeg|png|webp|gif|bmp)$/.test(type) || /^(jpe?g|png|webp|gif|bmp)$/.test(ext)) {
    const im = await shrinkImage(file);
    if (im.type === 'image/jpeg') item.thumb = 'data:image/jpeg;base64,' + im.data;
    else if (!/^image\/(png|webp)$/.test(im.type)) throw new Error(name + ': this picture could not be opened. Save it as JPG or PNG and attach that.');
    return { name, type: im.type, data: im.data };
  }
  if (/hei[cf]/.test(type) || /^hei[cf]$/.test(ext)) return { name, type: 'image/heic', data: await b64Of(file) };
  if (type === 'application/pdf' || ext === 'pdf') return { name, type: 'application/pdf', data: await b64Of(file) };
  if (/^text\//.test(type) || /^(txt|csv|tsv|md|json|log|xml)$/.test(ext)) return { name, text: (await file.text()).slice(0, 40000) };
  if (ext === 'docx') {
    await loadLib('vendor/mammoth-1.13.0.min.js', 'mammoth');
    const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { name, text: String(r.value || '').slice(0, 40000) };
  }
  if (/^(xlsx|xlsm|xls|ods)$/.test(ext)) {
    await loadLib('vendor/xlsx-0.18.5.full.min.js', 'XLSX');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return { name, text: wb.SheetNames.slice(0, 6).map(n => '--- Sheet: ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join('\n').slice(0, 40000) };
  }
  if (ext === 'doc') throw new Error(name + ': old Word files (.doc) cannot be read here. Save it as .docx or PDF and attach that.');
  throw new Error(name + ': this kind of file cannot be read. Use a photo, a PDF, a Word or Excel file, or a text file.');
}
(function wireAttach() {
  const cmd = $('cmd'), box = document.querySelector('#assist aside.chat');
  if (cmd) cmd.addEventListener('paste', e => { const fs = Array.from((e.clipboardData && e.clipboardData.files) || []); if (fs.length && modesReady()) { e.preventDefault(); addFiles(fs); } });
  if (box) {
    box.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1) { e.preventDefault(); box.classList.add('dropping'); } });
    box.addEventListener('dragleave', e => { if (e.target === box) box.classList.remove('dropping'); });
    box.addEventListener('drop', e => { box.classList.remove('dropping'); if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); if (modesReady()) addFiles(e.dataTransfer.files); else toast('Attaching files needs server script release ' + MODES_BUILD + '.'); } });
  }
})();
async function go() {
  if (!pending) return;
  $('confirm').style.display = 'none'; say('Yes, go', 'you');
  const f = pending; pending = null;
  f.deep = !!(f.deep || deepMode);
  running = true; reportOffered = ''; $('steps').style.display = ''; hud('WORKING', f.deep ? 'Deep research in progress' : 'Sourcing in progress', 'Starting', true); renderSteps('Keywords', f.deep);
  const hiG = isHindi(f.readback || '') || LANG === 'hi-IN';
  say(f.deep
    ? (hiG ? 'डीप रिसर्च मोड में शुरू कर रहा हूँ। मैं Baidu, Bing China और Google पर ज़्यादा खोज करूँगा, ट्रेड प्लेटफ़ॉर्म और जानी-मानी कंपनियों को नाम से जाँचूँगा, सबसे भरोसेमंद पेज पढ़ूँगा, कमी वाले तथ्यों के लिए दो राउंड तक खोजूँगा, और हर तथ्य को दो अलग AI से जाँचूँगा। इसमें आमतौर पर 5 से 10 मिनट लगते हैं। आप यह पेज बंद करके बाद में आ सकते हैं।'
          : 'Starting in deep research mode. I will search wider on Baidu, Bing China and Google, check trade platforms and the best-known makers by name, read the most trustworthy pages, run up to two rounds for missing facts, and have two different AIs check every fact. This usually takes 5 to 10 minutes. You can close this page and come back.')
    : (hiG ? 'अभी शुरू कर रहा हूँ। मैं Baidu पर चीनी भाषा में खोजूँगा, हर कंपनी को सरकारी रिकॉर्ड में जाँचूँगा और बची हुई कंपनियों को स्कोर दूँगा। इसमें आमतौर पर 3 से 5 मिनट लगते हैं; आप यह पेज बंद करके बाद में आ सकते हैं।' : 'Starting now. I will search Baidu in Chinese, check every company in the official records, and score the survivors. This usually takes 3 to 5 minutes; you can close this page and come back.'));
  try { await api('startSourcing', [f], true); }
  catch (e) {
    if (/already in progress/i.test(String(e && e.message))) {   // someone else's search is running: this one waits its turn and starts by itself
      waitingTurn = f;
      say(hiG ? 'अभी एक और सप्लायर खोज चल रही है। आपकी खोज उसके तुरंत बाद अपने-आप शुरू होगी। तब तक नीचे उसकी प्रगति दिखेगी, और आपके लिए एक झलक (quick look) तैयार कर रहा हूँ।'
        : 'Another supplier search is running right now. Yours is next and starts by itself the moment it finishes. Meanwhile its progress shows below, and I am preparing a quick look for you.');
      poll(); quickLook(f, hiG);
      return;
    }
    running = false; hud('ONLINE', 'What do you need to buy?', ''); toast(e.message); return;
  }
  poll(); quickLook(f, hiG);
}
let waitingTurn = null;
/** While the full search runs (5 to 10 minutes), a researched top-five comparison arrives in 2 to 3 minutes, clearly marked as a first look. */
function quickLook(f, hi) {
  modeAsk('advanced', f.said || f.machine, [], SESSION, 'compare', { prefix: hi ? 'झलक (2-3 मिनट की रिसर्च; जाँचा हुआ पूरा रिपोर्ट इसके बाद आएगा):\n' : 'Quick look (2 to 3 minutes of research; the full checked report with scores follows):\n' });
}
function renderSteps(stage, deep) {
  const idx = stage === 'Done' ? 99 : STEPS.findIndex(s => s[0] === stage);
  const list = deep ? STEPS.map(s => s[0] === 'Searching' ? [s[0], 'Search Baidu, Bing, B2B and leaders'] : s[0] === 'Vetting' ? [s[0], 'Vet: rounds of research, two-AI check'] : s) : STEPS;
  $('steps').classList.toggle('deepsteps', !!deep);
  $('steps').innerHTML = list.map((s, i) => '<li class="' + (i < idx ? 'done' : i === idx ? 'now' : '') + '"><span class="mono" style="font-size:12px;margin-right:6px">0' + (i + 1) + '</span>' + esc(s[1]) + '</li>').join('');
}
function render(s) {
  if (!s) return;
  $('counts').style.display = 'flex'; $('cFound').textContent = s.found; $('cRej').textContent = s.rejected; $('cScored').textContent = s.scored;
  renderSteps(s.stage, s.deep);
  const sb = $('stopRunBtn'); if (sb) sb.style.display = running && s.stage !== 'Done' && s.stage !== 'Error' && ME && ME.can && ME.can.start ? 'inline-block' : 'none';
  if (s.stage === 'Done') {
    if (!running) return;
    clearInterval(polling); running = false;
    const early = reportOffered === s.reqId;
    hud('READY', 'Shortlist ready for review', s.message, false);
    $('openDashBtn').style.display = 'inline-block';
    lastReport = s.reqId; chatHist = [];
    say(early ? 'All the checks are finished and added to the report. ' + s.message
      : s.message + ' Open the dashboard, or ask me anything about the results: for example, which company should we choose and why.');
    if (early) refreshDash(s.reqId, true); else prefetchDash(s.reqId, true);
    startWaiting();
  } else if (s.stage === 'Error') {
    if (!running) return;
    clearInterval(polling); running = false;
    hud('ONLINE', 'The run stopped', s.message, false);
    say('The run stopped: ' + s.message);
    startWaiting();
  } else {
    hud('WORKING', s.deep ? 'Deep research in progress' : 'Sourcing in progress', s.message, true);
    // The report is already written while the photo, certificate, import-duty and committee checks continue: let the team open it now.
    if (s.reportReady && running) {
      if (reportOffered !== s.reqId) {
        reportOffered = s.reqId; lastReport = s.reqId; chatHist = [];
        $('openDashBtn').style.display = 'inline-block';
        say('The report is ready, so you can open the dashboard now. I am still running the photo, certificate, import-duty and committee checks, and they appear in the report as each one finishes.');
        prefetchDash(s.reqId, true);
      } else if (Date.now() - dashRefreshedAt > 25000) refreshDash(s.reqId);   // a report that is open picks up each finished check
    }
  }
}
/* While the page is open it drives the work itself (pump), so nothing waits for the 1-minute timer.
   A pump that did real work is followed by the next one at once; one that returned straight away (the timer was busy) waits a moment. */
let pumping = false;
async function pumpLoop() {
  if (pumping) return;
  pumping = true;
  while (running) {
    const t0 = Date.now();
    try { render(await api('pump', [], true)); } catch (e) { await sleep(4000); }   // the 1-minute timer carries on meanwhile
    if (running) await sleep(Date.now() - t0 > 3500 ? 150 : 2500);
  }
  pumping = false;
}
/** A search that waited for another one starts now. */
function startWaiting() { if (!waitingTurn) return; pending = waitingTurn; waitingTurn = null; say('Now starting your search: ' + (pending.machine || ''), 'agent'); setTimeout(go, 1500); }
function poll() {
  clearInterval(polling);
  const tick = async () => { let s; try { s = await call('getStatus'); } catch (e) { return; } render(s); };
  tick(); polling = setInterval(tick, 5000);
  pumpLoop();
}


/* ---------- industry expert ---------- */
let expertItems = [], expertBusy = false;
const EXPERT_IDEAS = [
  ['Today', ["What is today's news in the socks and textile industry?", 'Any new technology launched in sock manufacturing this week?']],
  ['Socks industry', ['What are the latest technologies in sock manufacturing?', 'How can our sock factory upgrade to Industry 4.0?']],
  ['Quality and productivity', ['Explain Six Sigma DMAIC with a sock factory example', 'How do we implement 5S in our yarn store?', 'How to calculate OEE for our sock knitting machines?', 'Which Lean wastes are common in sock manufacturing?', 'Explain Cp and Cpk for sock length with an example']],
  ['Machines', ['Italian vs Chinese sock knitting machines: which should we buy?', 'Automatic toe closing and linking machines: options and payback', 'What is new in Chinese textile machinery this year?']],
  ['Yarn and materials', ['Latest trends in sock yarns: recycled, bamboo, functional', 'What is happening to cotton and nylon yarn prices?']],
  ['Business', ['Government schemes in India for textile machinery upgrades', 'How do Chinese sock clusters like Zhuji Datang stay so competitive?']]
];
function openExpert() { location.hash = '#/expert'; }
function openExpertView() {
  show('expert');
  if (!NEWS || NEWS.date !== new Date().toISOString().slice(0, 10)) loadNews(); else renderNews();
  if (!$('xIdeas').innerHTML) $('xIdeas').innerHTML = EXPERT_IDEAS.map(g => '<div class="xgrp"><span class="label">' + esc(g[0]) + '</span><div class="ideas">' +
    g[1].map(q => '<button class="chipbtn" onclick="expertSend(this.textContent)">' + esc(q) + '</button>').join('') + '</div></div>').join('');
  renderExpert();
  setTimeout(() => { $('xq').focus({ preventScroll: true }); $('expert').scrollTop = 0; }, 50);
}
function renderExpert() {
  $('xThread').innerHTML = expertItems.map(it => '<article class="card xitem"><div class="q">' + esc(it.q) + '</div>' +
    (it.x == null ? '<div class="xthinking"><span class="typing" style="padding:0!important"><i></i><i></i><i></i></span>' + esc(it.status || 'Thinking…') + '</div>' +
        (it.deep ? '<div class="dprog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + (it.pct || 3) + '"><i style="width:' + Math.max(3, Math.min(100, it.pct || 3)) + '%"></i></div>' : '')
      : (it.x.deep ? '<span class="deeptag">Deep research</span>' : '') + '<div class="a">' + esc(it.x.answer) + '</div>' +
        (it.x.sources && it.x.sources.length ? '<div class="xsrc"><span class="label">Sources</span><ol>' + it.x.sources.map((s, i) => '<li' + (s.n ? ' value="' + Number(s.n) + '"' : '') + '>' +
          (links(s.url).length ? '<a class="ext" href="' + esc(links(s.url)[0]) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>' : esc(s.title)) +
          ' <span class="muted">· ' + esc(s.site || '') + (s.date ? ' · ' + esc(s.date) : '') + (s.tier && s.tier !== 'Other' ? ' · ' + esc(s.tier) : '') + '</span></li>').join('') + '</ol></div>' : '') +
        (it.x.steps && it.x.steps.length ? '<details class="dsteps"><summary>How ZOBO researched this</summary><ol>' + it.x.steps.map(t => '<li>' + esc(t) + '</li>').join('') + '</ol></details>' : '') +
        (it.x.note ? '' : '<div class="muted" style="font-size:12px">' + (it.x.deep ? esc(deepMeta(it.x)) : it.x.searched ? 'Searched the web just now (' + it.x.searched + ' search' + (it.x.searched > 1 ? 'es' : '') + ')' : it.x.sources && it.x.sources.length ? 'From this morning\'s news brief' : 'From ZOBO\'s own knowledge; no web search needed') + '</div>')) +
    '</article>').reverse().join('');
  const last = expertItems.filter(i => i.x && i.x.usage !== '' && i.x.usage != null).pop();
  if (last) $('xUsage').textContent = 'Web searches used this month: ' + last.x.usage + ' of ' + last.x.limit + ' (shared with machine sourcing). Questions that need no news use no searches.' +
    (last.x.backups && last.x.backups.length ? ' Backup search is ready.' : '') + (Number(last.x.usage) >= Number(last.x.limit) ? ' This month\'s searches are used up, so ZOBO is using the backup search.' : '');
}
async function expertSend(q, byVoice) {
  q = String(q == null ? $('xq').value : q).trim(); if (!q || expertBusy) return;
  voiceInput = !!byVoice;
  if (isIdentity(q)) { const idl = identityLine(q); $('xq').value = ''; expertItems.push({ q, x: { answer: idl, sources: [], searched: 0, usage: '', limit: 250 } }); renderExpert(); speak(idl); return; }
  const dc = deepCommand(q);
  if (dc && dc.mode !== 'once') { $('xq').value = ''; deepApply(dc, false, wantsHindi(q)); return; }
  const deepNow = deepMode || !!dc;
  if (dc) q = dc.q;
  $('xq').value = ''; expertBusy = true; $('xsend').disabled = true;
  const item = { q, deep: deepNow, pct: 3, x: null, status: deepNow ? 'Deep research: planning the research… (about 1 to 3 minutes)' : 'Thinking, and searching the latest sources if needed… (about 20 seconds)' };
  expertItems.push(item); renderExpert();
  const hist = [];
  expertItems.filter(i => i.x).slice(-4).forEach(i => hist.push({ role: 'user', text: i.q }, { role: 'jarvis', text: i.x.answer }));
  const job = newJob();
  const stopWatch = deepNow ? watchProgress(job, p => { item.status = 'Deep research: ' + p.text; item.pct = p.pct || item.pct; if (!item.x) renderExpert(); }) : null;
  const sess = SESSION;
  try { const x = await call('askExpert', q, hist, deepNow ? { deep: true, job } : { job }); if (sess !== SESSION) return; item.x = x; speak(x.answer); }
  catch (e) { if (stopWatch) stopWatch(); if (sess !== SESSION) return; item.x = { answer: 'Sorry, I could not answer just now' + (e && e.message ? ': ' + e.message : '. Please try again in a minute.'), sources: [], searched: 0, usage: '?', limit: 250 }; speak(item.x.answer); }
  if (stopWatch) stopWatch();
  expertBusy = false; $('xsend').disabled = false; renderExpert();
}

/* ---------- dashboard ---------- */
let dtab = 'overview', profIdx = null;
const cmp = { hideEmpty: true, diffOnly: false, q: '', sort: null, hidden: {} };
const F = (src, h, kind, label) => ({ src, h, kind: kind || 'text', label: label || h });
const SECTIONS = [
  ['Verdict', [F('cp', 'Total score (auto)', 'num+', 'Total score /100'), F('cp', 'Verdict (auto)', 'text', 'Verdict'), F('pi', 'Why buy this one, not the others', 'text', 'Why buy this one'),
    F('cp', 'Research confidence', 'text', 'Research confidence'), F('pi', 'Pros'), F('pi', 'Cons and risks'), F('pi', 'Recommendation'), F('pi', 'Asset or liability'), F('pi', 'Reason', 'text', 'Asset or liability: why')]],
  ['Scores', 'SCORES'],
  ['Company and history', [F('cp', 'Company name (Chinese)', 'text', 'Chinese name'), F('cp', 'City, province'), F('cp', 'Company type'), F('cp', 'Founded year'),
    F('cp', 'Years in business (auto)', 'num+', 'Years in business'), F('cp', 'Registered capital (RMB)', 'num+'), F('cp', 'Paid-in capital (RMB)', 'num+'), F('cp', 'Stock code', 'text', 'Stock code (listed)'),
    F('cp', 'USCC', 'text', 'Credit code (USCC)'), F('cp', 'Factory address'), F('cp', 'Website', 'link'), F('pi', 'Manufacturer summary: history, scale, service, reputation', 'text', 'About the maker')]],
  ['Plant, scale and expertise', [F('cp', 'Insured employees', 'num+'), F('cp', 'Plant area (m²)', 'num+'), F('cp', 'Annual production capacity'), F('cp', 'Factories (count)', 'num+'),
    F('cp', 'R&D centre'), F('cp', 'Patents (count)', 'num+'), F('cp', 'Standards drafted'), F('cp', 'High-Tech / Little Giant status'), F('pi', "Manufacturer's other product lines", 'text', 'Other product lines')]],
  ['Quality and licences', [F('cp', 'Mandatory China licence and grade', 'text', 'China manufacturing licence'), F('cp', 'Certifications'), F('cp', 'Third-party audit')]],
  ['Product and specifications', [F('pi', 'Model'), F('pi', 'Product type'), F('pi', 'Product description'), F('pi', 'Key specifications'), F('pi', 'Capacity'), F('pi', 'Minimum order (MOQ)'), F('pi', 'Samples', 'text', 'Samples'), F('pi', 'Pressure / power / speed'),
    F('pi', 'Fuel or energy type'), F('pi', 'Rated efficiency', 'num+'), F('pi', 'Footprint and weight'), F('pi', 'Utilities needed (power, water, air)', 'text', 'Utilities needed'),
    F('pi', 'Voltage and frequency match', 'text', '415 V / 50 Hz match'), F('pi', 'Brochure link', 'link')]],
  ['Technology', [F('pi', 'Core technology'), F('pi', 'Control system (PLC brand)'), F('pi', 'Automation and remote monitoring'), F('pi', 'Branded key components'),
    F('pi', 'Safety systems'), F('pi', 'Standout features'), F('pi', 'English HMI and manuals')]],
  ['What makes it different', [F('pi', 'Features this has that the others lack', 'text', 'Has that others lack'), F('pi', 'Features the others have that this lacks', 'text', 'Others have that this lacks'),
    F('pi', 'Advantage vs other models'), F('pi', 'Best alternative and why', 'text', 'Best alternative'), F('pi', 'Proven installations')]],
  ['Price and terms', [F('pi', '', 'price', 'Price (quoted or indicative)'), F('pi', 'Price in INR (auto)', 'num-', 'Price in INR'), F('pi', '', 'landed', 'Landed cost in INR (estimate)'),
    F('pi', 'Price basis'), F('pi', 'What is included'), F('pi', 'Lead time (weeks)', 'num-'), F('pi', 'Payment terms'), F('pi', 'Warranty (months)', 'num+')]],
  ['Running cost and efficiency', [F('pi', 'Energy or fuel use per hour'), F('pi', 'Annual running cost (INR)', 'num-'), F('pi', 'Maintenance schedule'), F('pi', 'Expected life (years)', 'num+'),
    F('pi', 'Total cost of ownership (INR, auto)', 'num-', 'Total cost of ownership (INR)'), F('pi', 'Payback (years, auto)', 'num-', 'Payback (years)'), F('pi', 'Energy saving vs current machine (INR/yr)', 'num+')]],
  ['Service and reliability', [F('cp', 'Response time promised'), F('cp', 'Overseas service points'), F('cp', 'India agent or service partner'), F('pi', 'Local service available', 'text', 'Service in India'),
    F('pi', 'Spare parts in India'), F('cp', 'Spare-parts policy'), F('pi', 'Installation and commissioning'), F('pi', 'Operator training'), F('pi', 'Remote support'),
    F('pi', 'Factory test and inspection offered'), F('cp', 'English-speaking team')]],
  ['Customers and worldwide reach', [F('cp', 'Export countries (count)', 'num+'), F('cp', 'Nearest seaport for shipping', 'text', 'Ships from (seaport)'), F('cp', 'Main markets'), F('cp', 'India customers or projects'), F('cp', 'Named reference customers'),
    F('cp', 'Awards'), F('cp', 'Trade shows')]],
  ['Risks and India compliance', [F('cp', 'Lawsuits as defendant'), F('cp', 'Penalties or abnormal records'), F('cp', 'Red flags found'), F('cp', 'Verified by', 'text', 'Fact check by a second AI'), F('pi', 'Indian compliance needed')]],
  ['Videos and contact', [F('pi', 'Video links', 'link'), F('pi', 'Video type'), F('pi', 'Video language'), F('cp', 'Sales contact'), F('cp', 'Email'), F('cp', 'Phone / WeChat')]]
];
const num = v => { if (v === '' || v == null) return null; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const inr = n => n == null ? '' : '₹' + Math.round(n).toLocaleString('en-IN');
const links = v => String(v || '').split(/[\s,;]+/).map(u => /^www\./i.test(u) ? 'http://' + u : u).filter(u => /^https?:\/\/[^\s"'<>]+$/i.test(u));
/* A report can be for a machine or for anything else (yarn, parts, packaging, products): machine-only rows are left out for the others,
   and a few rows get the name that fits. Old reports have no kind and are machines. */
const MACHINE_ONLY = new Set(['Pressure / power / speed', 'Fuel or energy type', 'Rated efficiency', 'Footprint and weight', 'Utilities needed (power, water, air)', 'Voltage and frequency match',
  'Control system (PLC brand)', 'Automation and remote monitoring', 'Safety systems', 'English HMI and manuals', 'Energy or fuel use per hour', 'Annual running cost (INR)',
  'Energy saving vs current machine (INR/yr)', 'Payback (years, auto)', 'Total cost of ownership (INR, auto)', 'Expected life (years)', 'Installation and commissioning', 'Operator training',
  'Remote support', 'Spare parts in India', 'Maintenance schedule', 'Factory test and inspection offered', 'Proven installations']);
const ITEM_ONLY = new Set(['Key specifications', 'Minimum order (MOQ)', 'Samples']);
const ITEM_LABEL = { 'Model': 'Item, grade or model', 'Capacity': 'Supply capacity', 'Response time promised': 'Complaint response time', 'Overseas service points': 'Offices or agents outside China',
  'Spare-parts policy': 'Replacement and claim policy', 'Product description': 'Product description' };
const KIND_WORD = { machine: 'machine', part: 'spare part', material: 'material', product: 'product' };
const isItem = () => !!(dash && dash.kind && dash.kind !== 'machine');
function kindFields(list) {
  const item = isItem();
  return list.filter(f => item ? !MACHINE_ONLY.has(f.h) : !ITEM_ONLY.has(f.h)).map(f => item && ITEM_LABEL[f.h] && f.label === f.h ? Object.assign({}, f, { label: ITEM_LABEL[f.h] }) : f);
}
function fields(sec) {
  if (sec[1] !== 'SCORES') return kindFields(sec[1]);
  return dash.labels.map((l, j) => ({ src: 'score', j, kind: 'num+', label: l + ' /' + dash.max[j] }));
}
function val(c, f) {
  if (f.src === 'score') return c.scores[f.j] === '' ? '' : String(c.scores[f.j]);
  if (f.kind === 'price') { const p = c.pi['Indicative price']; return p ? (c.pi['Currency'] || '') + ' ' + p + (/quoted/i.test(c.pi['Price basis'] || '') ? '' : ' (estimate)') : ''; }
  if (f.kind === 'landed') { const n = num(c.pi['Price in INR (auto)']); return n != null && dash.landedPct !== '' ? inr(n * (1 + dash.landedPct / 100)) : ''; }
  return String((c[f.src] || {})[f.h] || '').trim();
}
function cellHtml(v, f) {
  if (!v) return '<span class="muted">—</span>';
  if (f.kind === 'link') { const ls = links(v); if (ls.length) return ls.map(u => '<a class="ext" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)) + '</a>').join('<br>'); }
  return '<div class="clamp" onclick="this.classList.toggle(\'open\')">' + esc(v) + '</div>';
}
/** Indexes of the companies with the best value in this row (ties all count); [] when not comparable. */
function bestIdx(cos, f) {
  if (!/^num/.test(f.kind)) return [];
  const ns = cos.map(c => num(val(c, f)));
  const have = ns.filter(n => n != null);
  if (have.length < 2 || have.every(n => n === have[0])) return [];
  const target = f.kind === 'num-' ? Math.min.apply(null, have) : Math.max.apply(null, have);
  return ns.map((n, i) => n === target ? i : -1).filter(i => i !== -1);
}
const cidx = c => dash.companies.indexOf(c);
const nameBtn = (c, txt) => '<button class="lb" onclick="openProfile(' + cidx(c) + ')">' + esc(txt || c.name) + '</button>';

/** Open a report by its address (#/report/REQ-...), so the back button and shared links work. */
function openDash(reqId) {
  const id = reqId || (dash && dash.reqId) || lastReport || '';
  const target = '#/report/' + encodeURIComponent(id);
  if (location.hash === target) loadDash(id); else location.hash = target;
}
const byScore = (a, b) => (Number(b.total) || 0) - (Number(a.total) || 0);
let dashSeq = 0, dashRaw = '', dashShown = false;
/** Draws the report from this browser's remembered copy at once, then replaces it only if the server's copy is different. */
async function loadDash(reqId) {
  const seq = ++dashSeq, id = reqId || lastReport || '', key = 'dash:' + (id || 'latest');
  show('dash');
  if (!paint.get(key)) { dashShown = false; $('dash').innerHTML = '<div class="empty">Loading the dashboard…</div>'; }
  const apply = (d, remembered) => {
    if (seq !== dashSeq || !$('dash').classList.contains('on')) return;
    if (!d) { dash = null; dashRaw = ''; dashShown = false; $('dash').innerHTML = '<div class="empty">No report yet. Ask the assistant for a machine or any product first.</div>'; return; }
    if (!remembered && dashShown && dash && dash.reqId === d.reqId) { adoptDash(d); return; }   // the remembered copy is on screen: keep the person's place
    dashRaw = JSON.stringify(d); dash = d;
    dash.companies.sort(byScore);
    keep = {}; dash.companies.forEach(c => keep[c.name] = dash.approved ? c.selected : true);
    pbInputs = null;
    dtab = 'overview'; profIdx = null; cmp.hidden = {}; cmp.sort = null;
    dashShown = true; renderDash();
  };
  try { await swr(key, quiet => api('getDashboard', [reqId || null], quiet), apply); }
  catch (e) { if (seq === dashSeq) { dashShown = false; $('dash').innerHTML = '<div class="empty">Could not load the report just now. Check the connection and open it again.</div>'; } }
}
/** Takes a newer copy of the open report without losing the person's place (tab, company, ticks, comparison settings). */
function adoptDash(d) {
  if (!d || !dash || d.reqId !== dash.reqId) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && $('dash').contains(ae)) return;   // never redraw under someone who is typing
  const raw = JSON.stringify(d);
  if (raw === dashRaw) return;
  const pname = profIdx != null && dash.companies[profIdx] ? dash.companies[profIdx].name : null, wasApproved = dash.approved;
  dashRaw = raw; dash = d; dash.companies.sort(byScore);
  const k2 = {};
  dash.companies.forEach(c => { k2[c.name] = dash.approved && !wasApproved ? c.selected : (c.name in keep ? keep[c.name] : (dash.approved ? c.selected : true)); });
  keep = k2;
  profIdx = pname ? dash.companies.findIndex(c => c.name === pname) : null;
  if (profIdx === -1) profIdx = null;
  const sc = $('dash').scrollTop;
  renderDash(); $('dash').scrollTop = sc;
}
/** Fetches a report in the background and remembers it, so opening it later draws at once. */
async function prefetchDash(reqId, force) {
  if (!reqId) return;
  const key = 'dash:' + reqId, old = paint.get(key);
  if (!force && old && Date.now() - old.t < 5 * 60 * 1000) return;
  try { paint.set(key, await once('swr:' + key, () => api('getDashboard', [reqId], true))); } catch (e) { /* it loads when it is opened */ }
}
/** Refreshes the report in the background; when it is the one on screen the new facts are drawn in place. */
async function refreshDash(reqId) {
  dashRefreshedAt = Date.now();
  try {
    const d = await api('getDashboard', [reqId], true);
    paint.set('dash:' + reqId, d);
    if ($('dash').classList.contains('on') && dash && dash.reqId === reqId) adoptDash(d);
  } catch (e) { /* the next refresh tries again */ }
}
function cellStyle(v, max) {
  const a = Math.max(0.08, ((Number(v) || 0) / (max || 1) - 0.5) * 2);
  const k = Math.min(1, Math.max(0, (Number(v) || 0) / (max || 1)));   // solid blues: pale for low scores, deep for full marks
  const mix = (x, y) => Math.round(x + (y - x) * k);
  const rgb = 'rgb(' + mix(224, 3) + ',' + mix(242, 105) + ',' + mix(254, 161) + ')';
  return 'background:' + rgb + ';color:' + (k > 0.55 ? '#fff' : '#08233D');
}
function setTab(t) { dtab = t; profIdx = null; renderDash(); $('dash').scrollTop = 0; }
function openProfile(i) { profIdx = i; renderDash(); $('dash').scrollTop = 0; }
function renderDash() {
  const d = dash;
  const check = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let head;
  if (d.approved) head = '<div class="status ok">' + check + '<div><b>Approved</b><span>by ' + esc(d.approvedBy) + '. Scores are locked and quotation requests are open.</span></div></div>';
  else if (canApprove) head = '<div class="status act"><div><b>Ready for approval</b><span>Untick any company you do not want in Overview, then proceed.</span></div><button class="btn primary big" onclick="doProceed()">Proceed</button></div>';
  else head = '<div class="status wait"><div><b>Waiting for approval</b><span>An approver reviews this shortlist and presses Proceed.</span></div></div>';
  const tabs = [['overview', 'Overview'], ['products', 'Products'], ['compare', 'Compare companies'], ['check', 'Buying checklist'], ['decision', 'Decision room']];
  let body;
  if (profIdx != null) body = profileHtml(profIdx);
  else if (dtab === 'compare') body = compareHtml();
  else if (dtab === 'products') body = productsHtml();
  else if (dtab === 'check') body = checklistHtml();
  else if (dtab === 'decision') body = decisionHtml();
  else body = overviewHtml();
  const rq = d.request || {};
  const money = v => { const n = num(v); return n == null ? v : '₹' + n.toLocaleString('en-IN'); };
  const facts = [['Purpose', rq.purpose], ['Fuel or power', rq.fuel], ['Budget', rq.budget ? money(rq.budget) : ''], ['Needed by', rq.neededBy], ['Site', rq.site], ['Must have', rq.mustHave], ['Researched', d.researchedOn]].filter(x => x[1]);
  const showSetup = (d.setup || []).length && ME && ME.can.start;
  const setup = showSetup ? '<div class="notice"><b>Complete the Settings tab before sending quotation requests.</b> Missing: ' + esc(d.setup.join(', ')) + '.</div>' : '';
  const t = d.tiles;
  const step = (n, label, cls) => { const v = n === '' || n == null ? 0 : n; return '<li class="' + (cls || '') + '"><b data-count="' + esc(v) + '">' + esc(v) + '</b><span>' + esc(label) + '</span></li>'; };
  const funnel = '<ol class="funnel" aria-label="How the companies were narrowed down">' + step(t.found, 'companies found') + step(t.rejected, 'rejected at the gates', 'neg') + step(t.scored, 'scored') +
    step(t.shortlisted, 'shortlisted (' + d.shortlist + '+ points)', 'pos') + '</ol>';
  $('dash').innerHTML =
    '<header class="pghead"><div class="pgmain"><a class="crumb" href="#/reports">Reports</a><span class="crumbsep" aria-hidden="true">/</span><span class="crumbid">' + esc(d.reqId) + '</span>' +
    '<h1>' + esc(d.machine) + (d.capacity ? ', ' + esc(d.capacity) : '') + '</h1>' +
    (facts.length > 1 ? '<dl class="facts-row">' + facts.map(x => '<div><dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd></div>').join('') + '</dl>'
      : '<p class="sub">' + (isItem() ? 'Only the item and quantity were given. Specifications (for yarn: count, composition, colour), budget and needed-by date help ZOBO pick the right grade next time.'
        : 'Only the machine and capacity were given. Fuel, pressure and budget help ZOBO pick the right model next time.') + '</p>') + '</div>' + head + '</header>' +
    setup + funnel +
    '<nav class="subtabs" aria-label="Report views">' + tabs.map(x => '<button class="subtab' + (profIdx == null && dtab === x[0] ? ' on' : '') + '" onclick="setTab(\'' + x[0] + '\')">' + x[1] + '</button>').join('') +
    (profIdx != null ? '<button class="subtab on">' + esc(d.companies[profIdx].name) + '</button>' : '') + '</nav>' + askBarHtml() + body;
  if (profIdx == null && dtab === 'compare') renderCmpTable();
  const key = d.reqId + '|' + dtab + '|' + profIdx;
  $('dash').classList.toggle('settled', key === renderDash.lastKey);   // re-drawing the same view does not replay the entrance animation
  if (renderDash.lastReq !== d.reqId) countUp($('dash'));
  renderDash.lastKey = key; renderDash.lastReq = d.reqId;
  loadPhotos();
}
/* Ask ZOBO on the dashboard: questions about this report, answered from everything in the sheet. */
let dashQA = [];
const ASK_IDEAS = ['Which company should we choose, and why?', 'Compare the top two products', 'What are the biggest risks?', 'What must we ask the suppliers before buying?', 'Write a short summary for the boss'];
function askBarHtml() {
  const qa = dashQA.filter(x => x.reqId === dash.reqId).slice(-3);
  return '<section class="card askbar"><form onsubmit="event.preventDefault();dashAsk($(\'dq\').value)" style="display:flex;gap:8px;align-items:center">' +
    '<span class="askname">Ask ZOBO</span>' +
    '<label for="dq" class="sr">Ask a question about this report</label><input id="dq" class="fld" style="height:42px" placeholder="Ask anything about these companies and products…" autocomplete="off">' +
    '<button class="btn primary" id="dqBtn" style="height:42px">Ask</button></form>' +
    '<div class="askdeep"><button type="button" class="chipbtn convoBtn deepBtn' + (deepMode ? ' on' : '') + '" aria-pressed="' + deepMode + '" onclick="setDeep(!deepMode, true);renderDash()"><span class="cl">' + (deepMode ? 'Deep research on' : 'Deep research') + '</span></button>' +
    '<span class="muted">' + (deepMode ? 'Answers combine this report with fresh research on the web, in English and Chinese, with sources (1 to 3 minutes).' : 'Switch on for answers researched on the web as well, with sources.') + '</span></div>' +
    (qa.length ? '' : '<div class="ideas">' + ASK_IDEAS.map(q => '<button class="chipbtn" onclick="dashAsk(this.textContent)">' + esc(q) + '</button>').join('') + '</div>') +
    qa.map(x => '<div class="qa"><div class="q">' + esc(x.q) + '</div><div class="a">' + (x.a == null ? '<span class="muted qastat" data-k="' + dashQA.indexOf(x) + '">' + esc(x.status || 'Thinking…') + '</span>' : esc(x.a)) + '</div>' +
      (x.src && x.src.length ? '<div class="xsrc"><span class="label">Sources</span><ol>' + x.src.map(s => '<li' + (s.n ? ' value="' + Number(s.n) + '"' : '') + '>' + (links(s.url).length ? '<a class="ext" href="' + esc(links(s.url)[0]) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>' : esc(s.title)) + ' <span class="muted">· ' + esc(s.site || '') + '</span></li>').join('') + '</ol></div>' : '') +
      (x.meta ? '<div class="muted" style="font-size:12px">' + esc(x.meta) + '</div>' : '') + '</div>').reverse().join('') +
    (qa.length ? '<div class="ideas">' + ASK_IDEAS.slice(0, 3).map(q => '<button class="chipbtn" onclick="dashAsk(this.textContent)">' + esc(q) + '</button>').join('') +
      '<button class="chipbtn" onclick="dashQA=dashQA.filter(x=>x.reqId!==dash.reqId);renderDash()">Clear</button></div>' : '') + '</section>';
}
async function dashAsk(q) {
  q = String(q || '').trim();
  if (!q) { if (dashQA.some(x => x.pendingDraw)) { dashQA.forEach(x => { delete x.pendingDraw; }); renderDash(); } return; }
  const dc = deepCommand(q);
  if (dc && dc.mode !== 'once') { deepApply(dc, true); renderDash(); return; }
  const deepNow = deepMode || !!dc;
  if (dc) q = dc.q;
  const item = { reqId: dash.reqId, q, a: null, status: deepNow ? 'Deep research: planning…' : 'Thinking…' };
  dashQA.push(item); renderDash();
  const hist = [];
  dashQA.filter(x => x.reqId === dash.reqId && x.a).slice(-4).forEach(x => hist.push({ role: 'user', text: x.q }, { role: 'jarvis', text: x.a }));
  const job = newJob();
  const stopWatch = deepNow ? watchProgress(job, p => { item.status = 'Deep research: ' + p.text; const el = document.querySelector('.qastat[data-k="' + dashQA.indexOf(item) + '"]'); if (el) el.textContent = item.status; }) : null;
  try {
    const r = await call('askJarvis', q, dash.reqId, hist, deepNow ? { deep: true, job } : { job });
    item.a = r.type === 'answer' ? r.answer : r.type === 'industry' ? 'That is a general industry question. Ask it in the Industry Expert tab and I will research it there.' : 'That sounds like something new to source. Open the Assistant tab and tell me there, and I will start a new search.';
    if (r.deep) { item.src = r.sources || []; item.meta = deepMeta(r); }
  } catch (e) { item.a = 'Sorry, I could not answer just now. Please try again.'; }
  if (stopWatch) stopWatch();
  // redraw only the same report, and never under someone who is typing (their half-written question would be lost)
  if (!dash || dash.reqId !== item.reqId || !$('dash').classList.contains('on')) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && $('dash').contains(ae) && ae.value) { item.pendingDraw = true; const el = document.querySelector('.qastat[data-k="' + dashQA.indexOf(item) + '"]'); if (el) el.textContent = 'Answer ready: press Enter on an empty box or reopen the tab to see it.'; return; }
  renderDash();
}
function actionBtn(c) {
  const i = cidx(c);
  if (c.rfqStatus) return '<div class="sent">RFQ ' + esc(c.rfqStatus.toLowerCase()) + '</div>';
  if (dash.approved && c.selected && ME && ME.can.start) return '<button class="btn primary" onclick="openForm(' + i + ')">Request quotation</button>';
  if (dash.approved && c.selected) return '<button class="btn primary" disabled title="Only buyers can request quotations">Request quotation</button>';
  return '<button class="btn primary" disabled>' + (dash.approved ? 'Not approved' : 'Request quotation') + '</button>';
}

/* overview: who is best at what, score heat table, company cards */
/** "High (82/100): 9 of 11 key facts confirmed; …" as a small coloured badge with the reason on hover. */
function confBadge(t) {
  t = String(t || ''); const m = t.match(/(High|Medium|Low)\s*\((\d+)\/100\)/);
  if (!m) return '';
  return '<p class="conf ' + m[1].toLowerCase() + '" title="' + esc(t) + '"><b>Research confidence: ' + esc(m[1]) + '</b> <span class="mono">' + esc(m[2]) + '/100</span>' + (/^Deep research/.test(t) ? ' <span class="deeptag">Deep research</span>' : '') + '<small>' + esc(t.replace(/^.*?\/100\):\s*/, '')) + '</small></p>';
}
function overviewHtml() {
  const d = dash, cos = d.companies;
  const W = [['Highest score', F('cp', 'Total score (auto)', 'num+'), ' /100'], ['Longest history', F('cp', 'Years in business (auto)', 'num+'), ' years'],
    ['Largest workforce', F('cp', 'Insured employees', 'num+'), ' insured staff'], ['Biggest plant', F('cp', 'Plant area (m²)', 'num+'), ' m²'],
    ['Most export countries', F('cp', 'Export countries (count)', 'num+'), ' countries'], ['Most patents', F('cp', 'Patents (count)', 'num+'), ' patents'],
    ['Lowest price in INR', F('pi', 'Price in INR (auto)', 'num-'), ''], ['Shortest lead time', F('pi', 'Lead time (weeks)', 'num-'), ' weeks'],
    ['Longest warranty', F('pi', 'Warranty (months)', 'num+'), ' months'], ['Highest stated efficiency', F('pi', 'Rated efficiency', 'num+'), '%']];
  const wins = W.map(([label, f, unit]) => {
    const have = cos.filter(c => num(val(c, f)) != null);
    if (!have.length) return '';
    const best = have.slice().sort((a, b) => f.kind === 'num-' ? num(val(a, f)) - num(val(b, f)) : num(val(b, f)) - num(val(a, f)))[0];
    const v = num(val(best, f));
    return '<button class="card win" onclick="openProfile(' + cidx(best) + ')"><small>' + esc(label) + '</small><b>' + esc(best.name) + '</b><span>' +
      esc(unit === '' ? inr(v) : v.toLocaleString('en-IN') + unit) + '</span></button>';
  }).join('');
  const rows = cos.map(c => '<tr><td style="font-weight:500;padding:6px 0">' + (d.approved ? '' : '<input type="checkbox" aria-label="Keep ' + esc(c.name) + '" ' + (keep[c.name] ? 'checked' : '') + ' onchange="keep[this.dataset.n]=this.checked" data-n="' + esc(c.name) + '" style="margin-right:8px;accent-color:var(--c1)">') + nameBtn(c) + '</td>' +
    c.scores.map((v, j) => '<td class="cell" style="' + cellStyle(v, d.max[j]) + '" title="' + esc(c.reasons[j] || '') + '">' + esc(v) + '</td>').join('') +
    '<td><div style="display:flex;align-items:center;gap:8px"><div class="bar"><i style="width:' + (Number(c.total) || 0) + '%"></i></div><span class="mono">' + esc(c.total) + '</span></div></td>' +
    '<td style="color:' + (c.verdict === 'Shortlist' ? 'var(--good)' : 'var(--warn)') + '">' + esc(c.verdict) + '</td></tr>').join('');
  const fact = (label, v) => '<div><span>' + esc(label) + '</span>' + (v ? esc(v) : '<i class="muted">not found</i>') + '</div>';
  const cards = cos.map(c => {
    const lic = c.cp['Mandatory China licence and grade'] || '';
    return '<article class="card co2">' + gallery(c) + '<div style="display:flex;justify-content:space-between;gap:12px"><div><h3>' + nameBtn(c) + '</h3><div style="font-size:13px;color:var(--ink3);margin-top:4px">' +
      esc(c.nameZh) + ' · ' + esc(c.city) + '</div></div><div class="ring">' + esc(c.total) + '<small>' + esc(c.verdict) + '</small></div></div>' +
      '<div class="facts">' + fact('In business', c.cp['Years in business (auto)'] ? c.cp['Years in business (auto)'] + ' years' : '') + fact('Insured staff', c.cp['Insured employees']) +
      fact('Exports to', c.cp['Export countries (count)'] ? c.cp['Export countries (count)'] + ' countries' : '') + fact('Patents', c.cp['Patents (count)']) +
      fact('Model', c.pi['Model']) + fact('Capacity', c.pi['Capacity']) + fact('Price', val(c, F('pi', '', 'price')) || 'Quotation needed') + fact('Asset or liability', c.pi['Asset or liability']) + '</div>' +
      confBadge(c.cp['Research confidence']) +
      (lic ? '<p><b style="color:var(--ink)">Licence:</b> ' + esc(lic.slice(0, 120)) + '</p>' : '') +
      '<p><b style="color:var(--ink)">Why buy:</b> ' + esc(c.whyBuy || c.why || '—') + '</p>' +
      (c.pi['Features this has that the others lack'] ? '<p><b style="color:var(--ink)">Different because:</b> ' + esc(c.pi['Features this has that the others lack']) + '</p>' : '') +
      '<div style="display:grid;gap:8px;margin-top:auto"><button class="btn" onclick="openProfile(' + cidx(c) + ')">Full profile</button>' + actionBtn(c) + '</div></article>';
  }).join('');
  return (wins ? '<section><h2 class="h2">Who leads on what</h2><div class="wins">' + wins + '</div></section>' : '') +
    '<section class="card" style="padding:18px 22px"><div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap"><h2 class="h2" style="margin:0">Score breakdown</h2><span style="font-size:12px;color:var(--ink3)">Brighter cell = closer to full marks. Facts not found online score 0, so scores rise as suppliers answer. Hover a cell for the reason.</span></div>' +
    '<div style="overflow-x:auto"><table><thead><tr><th>Company</th>' + d.labels.map((l, j) => '<th>' + esc(l) + '<br><span class="mono" style="color:var(--ink3)">/' + d.max[j] + '</span></th>').join('') + '<th>Total /100</th><th>Verdict</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>' +
    '<h2 class="h2">The companies</h2><div class="cards2">' + cards + '</div>' + rejectedHtml();
}
function rejectedHtml() {
  const r = dash.rejected || [];
  if (!r.length) return '<section class="card" style="padding:16px 20px;font-size:14px;color:var(--ink2)"><b style="color:var(--ink)">Rejected companies:</b> none in this run. Every company the agent picked passed the gates (real manufacturer, active, not blacklisted, licensed).</section>';
  return '<section class="card" style="padding:18px 22px"><b style="font-size:16px">Rejected companies (' + r.length + ')</b><div style="font-size:12px;color:var(--ink3);margin:4px 0 10px">Dropped by the agent: traders posing as factories, blacklisted, unlicensed or with too many red flags.</div>' +
    '<div style="overflow-x:auto"><table class="evt"><thead><tr><th>Company</th><th>Failed</th><th>Detail</th><th>Evidence</th></tr></thead><tbody>' + r.map(x =>
      '<tr><td>' + esc(x.name) + '<div class="muted">' + esc(x.nameZh) + '</div></td><td><span class="st bad">✕ ' + esc(x.failed) + '</span></td><td>' + esc(x.detail) + '</td><td>' +
      (links(x.link).length ? '<a class="ext" href="' + esc(links(x.link)[0]) + '" target="_blank" rel="noopener">source</a>' : '') + '</td></tr>').join('') + '</tbody></table></div></section>';
}

/* compare side by side: every field, best value highlighted, filters, sort by any number row */
function compareHtml() {
  const chips = dash.companies.map((c, i) => '<button class="chipbtn' + (cmp.hidden[i] ? '' : ' on') + '" aria-pressed="' + !cmp.hidden[i] + '" onclick="cmpToggle(' + i + ')">' + esc(c.name.replace(/ Co\.?,? Ltd\.?| Corporation Ltd\.?/i, '')) + '</button>').join('');
  return '<section style="display:flex;flex-direction:column;gap:12px">' +
    '<div class="ctrl"><span class="label">Show</span>' + chips + '</div>' +
    '<div class="ctrl"><label><input type="checkbox" ' + (cmp.hideEmpty ? 'checked' : '') + ' onchange="cmp.hideEmpty=this.checked;renderCmpTable()"> Hide rows nobody has data for</label>' +
    '<label><input type="checkbox" ' + (cmp.diffOnly ? 'checked' : '') + ' onchange="cmp.diffOnly=this.checked;renderCmpTable()"> Only rows where they differ</label>' +
    '<label for="cmpQ" class="sr">Find a field</label><input id="cmpQ" class="fld" style="width:240px;height:36px" placeholder="Find: price, efficiency, IBR…" value="' + esc(cmp.q) + '" oninput="cmp.q=this.value;renderCmpTable()">' +
    '<span class="muted">▲ best = best value in the row · Sort = order companies by that row · click long text to expand</span></div>' +
    '<div class="cmpwrap" id="cmpTable"></div></section>';
}
function cmpToggle(i) {
  const shown = dash.companies.filter((c, k) => !cmp.hidden[k]).length;
  if (!cmp.hidden[i] && shown <= 2) { toast('Keep at least two companies to compare.'); return; }
  cmp.hidden[i] = !cmp.hidden[i]; renderDash();
}
function cmpSort(id) { cmp.sort = cmp.sort === id ? null : id; renderCmpTable(); }
function renderCmpTable() {
  const el = $('cmpTable'); if (!el) return;
  let cos = dash.companies.filter((c, i) => !cmp.hidden[i]);
  const all = [];
  SECTIONS.forEach((sec, si) => fields(sec).forEach((f, fi) => all.push(Object.assign({ id: si + '.' + fi, sec: sec[0] }, f))));
  if (cmp.sort) {
    const f = all.find(x => x.id === cmp.sort);
    cos = cos.slice().sort((a, b) => { const x = num(val(a, f)), y = num(val(b, f)); if (x == null) return 1; if (y == null) return -1; return f.kind === 'num-' ? x - y : y - x; });
  }
  const q = cmp.q.trim().toLowerCase();
  let html = '<table class="cmp"><thead><tr><th class="rl">Field</th>' + cos.map(c => '<th>' + nameBtn(c) + '<div class="muted" style="font-weight:400;font-size:12px;margin-top:4px">' + esc(c.total) + '/100 · ' + esc(c.verdict) + '</div></th>').join('') + '</tr></thead><tbody>';
  let shownRows = 0;
  SECTIONS.forEach(sec => {
    const rows = all.filter(f => f.sec === sec[0]).filter(f => {
      const vs = cos.map(c => val(c, f));
      if (cmp.hideEmpty && vs.every(v => !v)) return false;
      if (cmp.diffOnly && vs.every(v => v === vs[0])) return false;
      if (q && f.label.toLowerCase().indexOf(q) === -1 && sec[0].toLowerCase().indexOf(q) === -1 && !vs.some(v => v.toLowerCase().indexOf(q) !== -1)) return false;
      return true;
    });
    if (!rows.length) return;
    html += '<tr class="sec"><td class="rl">' + esc(sec[0]) + '</td><td colspan="' + cos.length + '"></td></tr>';
    rows.forEach(f => {
      shownRows++;
      const b = bestIdx(cos, f);
      const tip = f.src === 'score' ? (i => ' title="' + esc(cos[i].reasons[f.j] || '') + '"') : () => '';
      html += '<tr><td class="rl">' + esc(f.label) + (/^num/.test(f.kind) ? '<button class="sortb' + (cmp.sort === f.id ? ' on' : '') + '" onclick="cmpSort(\'' + f.id + '\')" aria-label="Sort companies by ' + esc(f.label) + '">Sort</button>' : '') + '</td>' +
        cos.map((c, i) => '<td' + (b.indexOf(i) !== -1 ? ' class="best"' : '') + tip(i) + '>' + cellHtml(val(c, f), f) + '</td>').join('') + '</tr>';
    });
  });
  el.innerHTML = shownRows ? html + '</tbody></table>' : '<div class="empty" style="padding:40px">No field matches “' + esc(cmp.q) + '”.</div>';
}

/* buying checklist: what a foreign machinery purchase must confirm, per company */
const ok = t => ['ok', t], warn = t => ['warn', t], bad = t => ['bad', t], unk = t => ['unk', t || 'Not found online'];
const yesNo = (v, ifUnknown) => /^yes/i.test(v) ? ok(v) : /^no/i.test(v) ? bad(v) : unk(ifUnknown);
const CHECKS = [
  ['Real, healthy manufacturer', [
    ['Manufacturer, not a trader', 'Agent', c => { const t = c.cp['Company type']; return /trader/i.test(t) ? bad(t) : /manufactur/i.test(t) ? ok(t) : unk(); }],
    ['Registered with a credit code', 'Agent', c => c.cp['USCC'] ? ok(c.cp['USCC']) : unk()],
    ['Facts confirmed by a second AI', 'Agent', c => { const t = c.cp['Verified by'] || ''; const m = t.match(/(\d+) of (\d+) facts confirmed/); if (!m) return unk(t || 'Not checked'); const r = +m[1] / Math.max(1, +m[2]); return r >= 0.8 ? ok(t) : r >= 0.5 ? warn(t) : bad(t); }],
    ['20+ years in business', 'Agent', c => { const y = num(c.cp['Years in business (auto)']); return y == null ? unk() : y >= 20 ? ok(y + ' years') : y >= 10 ? warn(y + ' years') : bad(y + ' years'); }],
    ['Large workforce (300+ insured staff)', 'Agent', c => { const n = num(c.cp['Insured employees']); return n == null ? unk() : n >= 300 ? ok(n + ' staff') : n >= 100 ? warn(n + ' staff') : bad(n + ' staff'); }],
    ['No court cases as defendant', 'Agent', c => { const t = c.cp['Lawsuits as defendant']; return !t ? unk('None found') : /^(none|no|0)\b/i.test(t) ? ok(t) : warn(t); }],
    ['No red flags', 'Agent', c => { const t = c.cp['Red flags found']; if (!t) return ok('None found'); const n = t.split(';').filter(Boolean).length; return n >= 2 ? bad(t) : warn(t); }]]],
  ['Fits our need', [
    ['Capacity matches our request', 'Agent', c => { const want = num(dash.request.capacity || dash.capacity), have = num(c.pi['Capacity']); if (want == null || have == null) return unk(c.pi['Capacity'] || ''); return Math.abs(have - want) / want <= 0.15 ? ok(c.pi['Capacity']) : warn(c.pi['Capacity'] + ' (we asked ' + (dash.request.capacity || dash.capacity) + ')'); }],
    ['Efficiency stated', 'Quotation', c => c.pi['Rated efficiency'] ? ok(c.pi['Rated efficiency']) : unk('Ask in the quotation')],
    ['415 V / 50 Hz power', 'Agent', c => yesNo(c.pi['Voltage and frequency match'], 'Ask in the quotation')],
    ['Utilities known (power, water, air)', 'Quotation', c => c.pi['Utilities needed (power, water, air)'] ? ok(c.pi['Utilities needed (power, water, air)']) : unk('Ask in the quotation')]]],
  ['Technology and quality', [
    ['Branded key components', 'Agent', c => c.pi['Branded key components'] && !/^(yes|no)$/i.test(c.pi['Branded key components']) ? ok(c.pi['Branded key components']) : unk('Ask which brands')],
    ['China manufacturing licence', 'Agent', c => c.cp['Mandatory China licence and grade'] ? ok(c.cp['Mandatory China licence and grade']) : warn('Not confirmed')],
    ['International certificates (ASME, CE)', 'Agent', c => { const t = c.cp['Certifications']; return /ASME|\bCE\b/.test(t) ? ok(t) : /ISO/.test(t) ? warn('ISO only: ' + t) : unk(); }],
    ['English control screen and manuals', 'Quotation', c => yesNo(c.pi['English HMI and manuals'], 'Ask in the quotation')]]],
  ['Proof it works', [
    ['Exports to 30+ countries', 'Agent', c => { const n = num(c.cp['Export countries (count)']); return n == null ? unk() : n >= 30 ? ok(n + ' countries') : n >= 10 ? warn(n + ' countries') : bad(n + ' countries'); }],
    ['Customers or projects in India', 'Agent', c => c.cp['India customers or projects'] ? ok(c.cp['India customers or projects']) : unk('Ask for India references')],
    ['Named reference customers', 'Quotation', c => c.cp['Named reference customers'] ? ok(c.cp['Named reference customers']) : unk('Ask for two references')],
    ['Real factory or installation video', 'Agent', c => links(c.pi['Video links']).length ? (/real/i.test(c.pi['Video type']) ? ok(c.pi['Video type']) : warn('Video found, type not clear')) : unk()]]],
  ['Price and value', [
    ['Price known', 'Quotation', c => val(c, F('pi', '', 'price')) ? ok(val(c, F('pi', '', 'price')) + ' ' + (c.pi['Price basis'] || '')) : unk('Quotation needed')],
    ['Landed cost in INR', 'Your team', c => { const v = val(c, F('pi', '', 'landed')); return v ? ok(v) : unk(dash.landedPct === '' ? 'Set the landed-cost % in Settings' : 'After the quotation'); }],
    ['Within our budget', 'Quotation', c => { const b = num((dash.request || {}).budget); const landed = num(val(c, F('pi', '', 'landed'))), inrP = num(c.pi['Price in INR (auto)']); const cost = landed || inrP;
      if (!b) return unk('No budget given in the request'); if (cost == null) return unk('After the quotation'); return cost <= b ? ok(inr(cost) + ' of ' + inr(b)) : bad(inr(cost) + ', over ' + inr(b)); }],
    ['Lead time', 'Quotation', c => c.pi['Lead time (weeks)'] ? ok(c.pi['Lead time (weeks)'] + ' weeks') : unk('Ask in the quotation')],
    ['Warranty 12+ months', 'Quotation', c => { const n = num(c.pi['Warranty (months)']); return n == null ? unk('Ask: from commissioning') : n >= 12 ? ok(n + ' months') : warn(n + ' months'); }],
    ['Asset, not a liability', 'Agent', c => { const t = c.pi['Asset or liability']; return /^asset/i.test(t) ? ok(t) : /liab/i.test(t) ? bad(t) : t ? warn(t + ': ' + (c.pi['Reason'] || '')) : unk(); }]]],
  ['After-sales service', [
    ['Service engineer or agent in India', 'Agent', c => c.cp['India agent or service partner'] ? ok(c.cp['India agent or service partner']) : yesNo(c.pi['Local service available'], 'Ask in the quotation')],
    ['Spare parts stocked in India', 'Quotation', c => yesNo(c.pi['Spare parts in India'], 'Ask for a 2-year spares list')],
    ['Fast response promised', 'Agent', c => c.cp['Response time promised'] ? ok(c.cp['Response time promised']) : unk()],
    ['Remote support', 'Agent', c => c.pi['Remote support'] ? (/^no/i.test(c.pi['Remote support']) ? bad(c.pi['Remote support']) : ok(c.pi['Remote support'])) : unk()]]],
  ['Inspection and payment safety', [
    ['Factory test or third-party inspection', 'Quotation', c => c.pi['Factory test and inspection offered'] ? ok(c.pi['Factory test and inspection offered']) : unk('Ask for a witnessed factory test')],
    ['Safe payment terms (letter of credit)', 'Your team', c => { const t = c.pi['Payment terms']; return !t ? unk('Prefer a letter of credit') : /L\/?C|letter of credit/i.test(t) ? ok(t) : warn(t + ' (prefer a letter of credit)'); }]]],
  ['Indian approvals', [
    ['Approvals needed before running it', 'Your team', c => c.pi['Indian compliance needed'] ? warn(c.pi['Indian compliance needed']) : unk('Check with your consultant')]]]
];
/* the same checklist for yarn, parts, packaging and other products: machine-only checks out, supply and quality checks in */
const ITEM_SKIP = new Set(['Capacity matches our request', 'Efficiency stated', '415 V / 50 Hz power', 'Utilities known (power, water, air)', 'Branded key components',
  'International certificates (ASME, CE)', 'English control screen and manuals', 'Spare parts stocked in India', 'Remote support', 'Warranty 12+ months', 'Factory test or third-party inspection']);
const ITEM_ADD = {
  'Fits our need': [
    ['Enough supply capacity', 'Agent', c => { const want = num(dash.request.capacity || dash.capacity), have = num(c.pi['Capacity']); if (have == null) return unk(c.pi['Capacity'] || 'Ask their monthly capacity'); if (want == null) return ok(c.pi['Capacity']); return have >= want ? ok(c.pi['Capacity']) : bad(c.pi['Capacity'] + ', we need ' + (dash.request.capacity || dash.capacity)); }],
    ['Specifications stated', 'Agent', c => c.pi['Key specifications'] ? ok(c.pi['Key specifications']) : unk('Ask for the technical data sheet')],
    ['Minimum order fits', 'Quotation', c => c.pi['Minimum order (MOQ)'] ? warn(c.pi['Minimum order (MOQ)'] + ' (check against our quantity)') : unk('Ask for the MOQ')],
    ['Samples available', 'Quotation', c => c.pi['Samples'] ? ok(c.pi['Samples']) : unk('Ask for samples')]],
  'Technology and quality': [
    ['Quality certificates (OEKO-TEX, GRS, ISO…)', 'Agent', c => { const t = c.cp['Certifications']; return /OEKO|GRS|BCI|GOTS|REACH|bluesign|RCS/i.test(t) ? ok(t) : t ? warn(t) : unk('Ask for certificates'); }],
    ['Test report or COA for a recent lot', 'Quotation', c => unk('Ask in the quotation')]],
  'Inspection and payment safety': [['Pre-shipment inspection or lot test', 'Quotation', c => unk('Ask for SGS, BV or TUV inspection')]]
};
function activeChecks() {
  if (!isItem()) return CHECKS;
  return CHECKS.map(g => [g[0] === 'After-sales service' ? 'Supply and support' : g[0] === 'Indian approvals' ? 'Indian approvals (BIS, QCO, anti-dumping)' : g[0],
    (ITEM_ADD[g[0]] && g[0] === 'Fits our need' ? ITEM_ADD[g[0]] : []).concat(g[1].filter(it => !ITEM_SKIP.has(it[0]))).concat(ITEM_ADD[g[0]] && g[0] !== 'Fits our need' ? ITEM_ADD[g[0]] : [])]).filter(g => g[1].length);
}
function checklistHtml() {
  const cos = dash.companies;
  const CHECKS = activeChecks();
  const res = cos.map(c => CHECKS.map(g => g[1].map(it => { try { return it[2](c); } catch (e) { return unk(); } })));
  const icon = { ok: '✓', warn: '!', bad: '✕', unk: '?' };
  const label = { ok: 'Confirmed', warn: 'Check', bad: 'Problem', unk: 'Unknown' };
  const st = r => '<span class="st ' + r[0] + '" title="' + label[r[0]] + '"><b aria-hidden="true">' + icon[r[0]] + '</b><span><span class="sr">' + label[r[0]] + ': </span>' + esc(String(r[1]).slice(0, 140)) + '</span></span>';
  const total = CHECKS.reduce((n, g) => n + g[1].length, 0);
  let html = '<section style="display:flex;flex-direction:column;gap:12px"><div class="ctrl"><span class="st ok"><b>✓</b>Confirmed</span><span class="st warn"><b>!</b>Check this</span><span class="st bad"><b>✕</b>Problem</span><span class="st unk"><b>?</b>Not known yet</span>' +
    '<span class="muted">Who answers: <b>Agent</b> = found online · <b>Quotation</b> = asked in the RFQ email · <b>Your team</b> = checked by us</span></div>' +
    '<div class="cmpwrap"><table class="cmp"><thead><tr><th class="rl">What to check</th><th class="whoc">Who answers</th>' +
    cos.map((c, i) => { const n = res[i].flat().filter(r => r[0] === 'ok').length, b = res[i].flat().filter(r => r[0] === 'bad').length;
      return '<th>' + nameBtn(c) + '<div class="muted" style="font-weight:400;font-size:12px;margin-top:4px">' + n + ' of ' + total + ' confirmed' + (b ? ' · ' + b + ' problem' + (b > 1 ? 's' : '') : '') + '</div></th>'; }).join('') + '</tr></thead><tbody>';
  CHECKS.forEach((g, gi) => {
    html += '<tr class="sec"><td class="rl">' + esc(g[0]) + '</td><td colspan="' + (cos.length + 1) + '"></td></tr>';
    g[1].forEach((it, ii) => {
      html += '<tr><td class="rl">' + esc(it[0]) + '</td><td class="whoc"><span class="who">' + it[1] + '</span></td>' + cos.map((c, ci) => '<td>' + st(res[ci][gi][ii]) + '</td>').join('') + '</tr>';
    });
  });
  return html + '</tbody></table></div></section>';
}

/* one company: everything about the company and its product */
function profileHtml(i) {
  const c = dash.companies[i], cos = dash.companies;
  const avg = dash.max.map((m, j) => cos.reduce((s, x) => s + (Number(x.scores[j]) || 0), 0) / cos.length);
  const secs = SECTIONS.filter(s => s[0] !== 'Verdict' && s[0] !== 'Scores' && fields(s).length);
  const id = s => 'p-' + s.replace(/\W+/g, '-').toLowerCase();
  const nav = ['The product', 'Why buy it', 'Scores'].concat(secs.map(s => s[0])).concat(['Evidence']);
  const alt = c.pi['Best alternative and why'] || '';
  const altCo = cos.find(x => x !== c && alt.indexOf(x.name) !== -1);
  const p = (label, v, cls) => v ? '<dt>' + esc(label) + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(v) + '</dd>' : '';
  let html = '<section class="card" style="padding:18px 22px;display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap">' +
    '<div><button class="lb" onclick="setTab(\'' + dtab + '\')">← All companies</button><h1 style="margin-top:10px">' + esc(c.name) + '</h1>' +
    '<div style="color:var(--ink2);font-size:14px;margin-top:6px">' + esc(c.nameZh) + ' · ' + esc(c.city) + (c.cp['Website'] ? ' · <a class="ext" href="' + esc(links(c.cp['Website'])[0] || '#') + '" target="_blank" rel="noopener">' + esc(c.cp['Website'].replace(/^https?:\/\/(www\.)?/, '')) + '</a>' : '') + '</div></div>' +
    '<div style="display:flex;align-items:center;gap:18px"><div class="ring" style="font-size:40px">' + esc(c.total) + '<small>' + esc(c.verdict) + ' · score /100</small></div>' +
    '<div style="display:flex;flex-direction:column;gap:8px">' + actionBtn(c) + '<div style="display:flex;gap:8px">' +
    (i > 0 ? '<button class="btn" style="height:36px" onclick="openProfile(' + (i - 1) + ')">← Previous</button>' : '') +
    (i < cos.length - 1 ? '<button class="btn" style="height:36px" onclick="openProfile(' + (i + 1) + ')">Next →</button>' : '') + '</div></div></div></section>';
  html += '<div class="prof"><nav class="pnav" aria-label="Sections">' + nav.map(n => '<button onclick="document.getElementById(\'' + id(n) + '\').scrollIntoView({behavior:\'smooth\'})">' + esc(n) + '</button>').join('') + '</nav><div style="display:flex;flex-direction:column;gap:14px;min-width:0">';
  html += '<section class="card psec" id="' + id('The product') + '"><h2>' + esc(c.pi['Model'] || 'The product') + '</h2><div class="pmedia"><div>' + gallery(c, 'big') + '</div><div>' + videoBlock(c) + '</div></div><dl class="kv">' +
    p('Product type', c.pi['Product type']) + p('Description', c.pi['Product description']) + p('Capacity', c.pi['Capacity']) + p('Pressure / power', c.pi['Pressure / power / speed']) +
    p('Fuel', c.pi['Fuel or energy type']) + p('Efficiency', c.pi['Rated efficiency']) + p('Core technology', c.pi['Core technology']) + p('Standout features', c.pi['Standout features']) +
    (links(c.pi['Brochure link']).length ? '<dt>Product page</dt><dd>' + cellHtml(c.pi['Brochure link'], { kind: 'link' }) + '</dd>' : '') +
    '</dl><div class="nf"><button class="lb" onclick="setTab(\'products\')">Compare this product with the others →</button></div></section>';
  html += '<section class="card psec" id="' + id('Why buy it') + '"><h2>Why buy it, and what makes it different</h2><dl class="kv">' +
    p('Why buy this one', c.whyBuy || c.why) + p('Has that others lack', c.pi['Features this has that the others lack']) + p('Others have that this lacks', c.pi['Features the others have that this lacks']) +
    (alt ? '<dt>Best alternative</dt><dd>' + (altCo ? nameBtn(altCo) + (alt.trim() !== altCo.name ? '<br>' + esc(alt) : '') : esc(alt)) + '</dd>' : '') +
    p('Pros', c.pi['Pros']) + p('Cons and risks', c.pi['Cons and risks']) + p('Asset or liability', [c.pi['Asset or liability'], c.pi['Reason']].filter(Boolean).join(': ')) + p('Recommendation', c.pi['Recommendation']) + '</dl></section>';
  html += '<section class="card psec" id="' + id('Scores') + '"><h2>Scores against the shortlist</h2><div class="sbar">' + dash.labels.map((l, j) => {
    const v = Number(c.scores[j]) || 0, m = dash.max[j] || 1;
    return '<span>' + esc(l) + '</span><div class="track" role="img" aria-label="' + esc(l) + ' ' + v + ' of ' + m + ', shortlist average ' + avg[j].toFixed(1) + '"><i style="width:' + (v / m * 100) + '%"></i><u style="left:' + (avg[j] / m * 100) + '%" title="Shortlist average ' + avg[j].toFixed(1) + '"></u></div><span class="mono">' + v + ' / ' + m + '</span>' +
      '<p>' + esc((c.reasons[j] || '').replace(/^[^:]+:\s*/, '')) + '</p>';
  }).join('') + '</div><div class="nf">Bar = this company. White tick = average of the ' + cos.length + ' shortlisted companies.</div></section>';
  secs.forEach(sec => {
    const fs = fields(sec);
    const have = fs.filter(f => val(c, f)), miss = fs.filter(f => !val(c, f));
    html += '<section class="card psec" id="' + id(sec[0]) + '"><h2>' + esc(sec[0]) + '</h2>' + (have.length ? '<dl class="kv">' + have.map(f => {
      const v = val(c, f), b = bestIdx(cos, f).indexOf(i) !== -1;
      return '<dt>' + esc(f.label) + '</dt><dd>' + (f.kind === 'link' && links(v).length ? cellHtml(v, f) : esc(v)) + (b ? ' <span class="st ok" style="margin-left:6px">▲ best of the shortlist</span>' : '') + '</dd>';
    }).join('') + '</dl>' : '<p class="muted" style="margin:0">Nothing found online for this section yet.</p>') +
      (miss.length && have.length ? '<div class="nf">Not found online yet (ask the supplier if it matters): ' + esc(miss.map(f => f.label).join(', ')) + '</div>' : '') + '</section>';
  });
  html += '<section class="card psec" id="' + id('Evidence') + '"><h2>Evidence the agent used</h2>' + (c.evidence.length
    ? '<div style="overflow-x:auto"><table class="evt"><thead><tr><th>Fact</th><th>Value</th><th>Source</th><th>Link</th></tr></thead><tbody>' + c.evidence.map(e =>
      '<tr><td>' + esc(e.fact) + '</td><td>' + esc(e.value) + '</td><td>' + esc(e.type) + '</td><td>' + (links(e.url).length ? '<a class="ext" href="' + esc(links(e.url)[0]) + '" target="_blank" rel="noopener">' + esc(e.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)) + '</a>' : esc(e.url)) + '</td></tr>').join('') + '</tbody></table></div>'
    : '<p class="muted" style="margin:0">No evidence rows saved for this company.</p>') + '</section>';
  return html + '</div></div>';
}
/* ---------- product photos and videos ---------- */
const photoCache = {};   // address -> picture data fetched by the script ('' = could not be had)
const DIRECT_IMG = CFG.directPhotos !== false;   // set directPhotos: false in config.js to always fetch photos through the script instead of from the supplier's own site
function callQuiet(fn, ...args) { return api(fn, args, true).catch(() => ''); }
const photosOf = c => links(c.pi['Product photos']);
const videosOf = c => links(c.pi['Video links']);
/** An image placeholder that loadPhotos() fills: straight from the supplier's site when the browser can, otherwise through the script (hotlink blocks, http-only sites). */
function photoTag(url, alt, cls) {
  return '<div class="ph ' + (cls || '') + '"><img data-u="' + esc(url) + '" alt="' + esc(alt) + '" decoding="async" referrerpolicy="no-referrer"><span class="phmsg">Loading photo…</span></div>';
}
function photoShow(it) {
  const d = photoCache[it.u];
  if (d) { it.im.src = d; it.box.classList.add('ok'); }
  else { it.box.classList.add('fail'); const m = it.box.querySelector('.phmsg'); if (m) m.innerHTML = 'Photo blocked by the supplier site. <a class="ext" href="' + esc(it.u) + '" target="_blank" rel="noopener">Open it</a>'; }
}
/** Tries the supplier's own address in the browser (no Referer sent). Resolves true when a real picture appeared. */
function photoDirect(it) {
  return new Promise(done => {
    let over = false;
    const finish = good => { if (over) return; over = true; clearTimeout(t); it.im.onload = it.im.onerror = null; done(good); };
    const t = setTimeout(() => finish(false), 4000);
    it.im.onload = () => { if (it.im.naturalWidth > 8) { it.box.classList.add('ok'); finish(true); } else finish(false); };
    it.im.onerror = () => finish(false);
    it.im.referrerPolicy = 'no-referrer';
    it.im.src = it.u;
  });
}
/** Photos the browser could not load itself: asked from the script in small groups, two groups at the same time. */
async function photosViaScript(items) {
  const urls = [...new Set(items.map(x => x.u))].filter(u => !(u in photoCache));
  const groups = []; for (let i = 0; i < urls.length; i += 6) groups.push(urls.slice(i, i + 6));
  let legacy = false;   // an older script has no "photos" action: ask one by one
  await pool(groups, 2, async g => {
    let got = null;
    if (!legacy) { try { got = await api('photos', [g], true); } catch (e) { if (/unknown action/i.test((e && e.message) || '')) legacy = true; } }
    if (!got) { got = {}; await pool(g, 3, async u => { got[u] = await callQuiet('photo', u); }); }
    g.forEach(u => { photoCache[u] = got[u] || ''; });
    items.filter(x => g.indexOf(x.u) !== -1).forEach(photoShow);   // each group appears as soon as it arrives
  });
}
async function loadPhotos() {
  const items = [...document.querySelectorAll('.ph img[data-u]:not([data-done])')].map(im => { im.setAttribute('data-done', '1'); return { im, u: im.getAttribute('data-u'), box: im.parentElement }; });
  const later = [];
  await pool(items, 12, async it => {
    if (it.u in photoCache) { photoShow(it); return; }
    if (DIRECT_IMG && /^https:/i.test(it.u) && await photoDirect(it)) return;
    later.push(it);
  });
  if (later.length) await photosViaScript(later);
}
function gallery(c, size) {
  const ps = photosOf(c);
  if (!ps.length) return '<div class="ph none ' + (size || '') + '"><span class="phmsg">No product photo found on the website yet</span></div>';
  const id = 'g' + cidx(c) + (size || '');
  return '<div class="gal" id="' + id + '">' + photoTag(ps[0], (c.pi['Model'] || c.name) + ' photo', size) +
    (ps.length > 1 ? '<div class="thumbs">' + ps.map((u, k) => '<button class="thumb' + (k ? '' : ' on') + '" aria-label="Photo ' + (k + 1) + '" onclick="showPhoto(\'' + id + '\',' + k + ',' + cidx(c) + ')">' + (k + 1) + '</button>').join('') + '</div>' : '') + '</div>';
}
function showPhoto(id, k, ci) {
  const c = dash.companies[ci], u = photosOf(c)[k], g = document.getElementById(id);
  const box = g.querySelector('.ph');
  box.outerHTML = photoTag(u, (c.pi['Model'] || c.name) + ' photo ' + (k + 1), box.classList.contains('big') ? 'big' : '');
  g.querySelectorAll('.thumb').forEach((t, j) => t.classList.toggle('on', j === k));
  loadPhotos();
}
/** Embeddable player URL for Bilibili, YouTube, Tencent Video and Youku links; '' when it can only be opened. */
function embedUrl(u) {
  let m;
  if ((m = u.match(/(BV[0-9A-Za-z]{10})/))) return 'https://player.bilibili.com/player.html?bvid=' + m[1] + '&autoplay=0&high_quality=1';
  if ((m = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/))) return 'https://www.youtube-nocookie.com/embed/' + m[1];
  if ((m = u.match(/v\.qq\.com\/.*\/([a-z0-9]{11})\.html/i))) return 'https://v.qq.com/txp/iframe/player.html?vid=' + m[1];
  if ((m = u.match(/youku\.com\/v_show\/id_([\w=]+)/))) return 'https://player.youku.com/embed/' + m[1];
  return '';
}
function videoBlock(c) {
  const vs = videosOf(c);
  if (!vs.length) return '<div class="vid none"><span class="phmsg">No video found yet</span></div>';
  const first = vs[0], e = embedUrl(first);
  const site = u => u.replace(/^https?:\/\/(www\.|m\.)?/, '').split('/')[0];
  const play = e ? '<button class="vid play" onclick="this.outerHTML=\'<iframe class=&quot;vidf&quot; src=&quot;' + esc(e) + '&quot; allow=&quot;fullscreen; picture-in-picture&quot; allowfullscreen></iframe>\'" aria-label="Play video"><b>▶</b><span>Play video · ' + esc(site(first)) + '</span></button>'
    : (/^https:\/\/.*\.mp4(\?|$)/i.test(first) ? '<video class="vidf" controls preload="none" src="' + esc(first) + '"></video>'
      : '<a class="vid play" href="' + esc(first) + '" target="_blank" rel="noopener"><b>▶</b><span>Watch on ' + esc(site(first)) + '</span></a>');
  return play + (vs.length > 1 ? '<div class="vlinks">More: ' + vs.slice(1).map((u, k) => '<a class="ext" href="' + esc(u) + '" target="_blank" rel="noopener">video ' + (k + 2) + '</a>').join(' · ') + '</div>' : '') +
    (c.pi['Video type'] ? '<div class="vlinks">' + esc(c.pi['Video type']) + (c.pi['Video language'] ? ' · ' + esc(c.pi['Video language']) : '') + '</div>' : '');
}
async function findMedia() {
  const b = $('mediaBtn'); if (b) { b.disabled = true; b.textContent = 'Looking on the company websites…'; }
  try {
    const r = await call('refreshMedia', dash.reqId, false);
    toast('Photos found for ' + r.photos + ' and videos for ' + r.videos + ' of ' + r.companies + ' products.');
    const keepTab = dtab, keepProf = profIdx;
    dash = await call('getDashboard', dash.reqId);
    dash.companies.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
    dtab = keepTab; profIdx = keepProf; renderDash();
  } catch (e) { if (b) { b.disabled = false; b.textContent = 'Find photos and videos'; } }
}

/* products: the machines side by side, with photo, video, description and every spec */
const PF = (h, kind, label) => F('pi', h, kind, label);
const PRODUCT_ROWS = [
  ['The product', [PF('Product type'), PF('Product description', 'text', 'Description'), PF('Brochure link', 'link', 'Product page')]],
  ['Specifications', [PF('Key specifications'), PF('Capacity'), PF('Minimum order (MOQ)'), PF('Samples'), PF('Pressure / power / speed'), PF('Fuel or energy type'), PF('Rated efficiency', 'num+'), PF('Footprint and weight'),
    PF('Utilities needed (power, water, air)', 'text', 'Utilities needed'), PF('Voltage and frequency match', 'text', '415 V / 50 Hz match')]],
  ['Technology', [PF('Core technology'), PF('Control system (PLC brand)'), PF('Automation and remote monitoring'), PF('Branded key components'), PF('Safety systems'),
    PF('Standout features'), PF('English HMI and manuals')]],
  ['Compared with the other products', [PF('Features this has that the others lack', 'text', 'Has that others lack'), PF('Features the others have that this lacks', 'text', 'Others have that this lacks'),
    PF('Advantage vs other models'), PF('Best alternative and why', 'text', 'Best alternative'), PF('Why buy this one, not the others', 'text', 'Why buy this one'), PF('Proven installations')]],
  ['Price and running cost', [PF('', 'price', 'Price (quoted or indicative)'), PF('Price in INR (auto)', 'num-', 'Price in INR'), PF('', 'landed', 'Landed cost in INR (estimate)'),
    PF('What is included'), PF('Lead time (weeks)', 'num-'), PF('Warranty (months)', 'num+'), PF('Energy or fuel use per hour'), PF('Annual running cost (INR)', 'num-'),
    PF('Expected life (years)', 'num+'), PF('Total cost of ownership (INR, auto)', 'num-', 'Total cost of ownership (INR)'), PF('Payback (years, auto)', 'num-', 'Payback (years)'),
    PF('Asset or liability'), PF('Reason', 'text', 'Asset or liability: why')]],
  ['Service for this product', [PF('Installation and commissioning'), PF('Operator training'), PF('Remote support'), PF('Spare parts in India'), PF('Maintenance schedule'),
    PF('Factory test and inspection offered')]]
];
function productsHtml() {
  const cos = dash.companies.filter((c, i) => !cmp.hidden[i]);
  const anyPhoto = dash.companies.some(c => photosOf(c).length), anyVideo = dash.companies.some(c => videosOf(c).length);
  const chips = dash.companies.map((c, i) => '<button class="chipbtn' + (cmp.hidden[i] ? '' : ' on') + '" aria-pressed="' + !cmp.hidden[i] + '" onclick="cmpToggle(' + i + ')">' + esc(c.pi['Model'] ? c.pi['Model'].slice(0, 28) : c.name) + '</button>').join('');
  let html = '<section style="display:flex;flex-direction:column;gap:12px"><div class="ctrl"><span class="label">Show</span>' + chips +
    (ME && ME.can.start ? '<button class="btn" id="mediaBtn" style="height:36px;margin-left:auto" onclick="findMedia()">' + (anyPhoto || anyVideo ? 'Look again for photos and videos' : 'Find photos and videos') + '</button>' : '') + '</div>' +
    (!anyPhoto && !anyVideo ? '<div class="note2">No photos or videos are saved for this report yet. Press <b>Find photos and videos</b>: the agent reads each company\'s website (no searches used, about 20 seconds).</div>' : '') +
    '<div class="cmpwrap" style="max-height:none"><table class="cmp prod"><thead><tr><th class="rl">Product</th>' + cos.map(c =>
      '<th><div style="font-size:15px;line-height:1.35">' + esc(c.pi['Model'] || 'Model not named') + '</div><div class="muted" style="font-weight:400;font-size:12px;margin-top:4px">by ' + nameBtn(c) + ' · ' + esc(c.total) + '/100</div></th>').join('') + '</tr></thead><tbody>' +
    '<tr><td class="rl">Photo</td>' + cos.map(c => '<td>' + gallery(c) + '</td>').join('') + '</tr>' +
    '<tr><td class="rl">Video</td>' + cos.map(c => '<td>' + videoBlock(c) + '</td>').join('') + '</tr>';
  PRODUCT_ROWS.forEach(sec => {
    const rows = kindFields(sec[1]).filter(f => cos.some(c => val(c, f)));
    if (!rows.length) return;
    html += '<tr class="sec"><td class="rl">' + esc(sec[0]) + '</td><td colspan="' + cos.length + '"></td></tr>';
    rows.forEach(f => {
      const b = bestIdx(cos, f);
      html += '<tr><td class="rl">' + esc(f.label) + '</td>' + cos.map((c, i) => '<td' + (b.indexOf(i) !== -1 ? ' class="best"' : '') + '>' + cellHtml(val(c, f), f) + '</td>').join('') + '</tr>';
    });
  });
  return html + '</tbody></table></div><div class="muted" style="font-size:12px">Photos and videos come from each company\'s own website. ▲ best = best value among these products. Click long text to expand.</div></section>';
}

let proceeding = false;
async function doProceed() {
  const names = Object.keys(keep).filter(n => keep[n]);
  if (!names.length) { toast('Keep at least one company.'); return; }
  if (proceeding) return;   // one approval per click, even on a double-click
  proceeding = true;
  try { dash = await call('proceed', dash.reqId, names); } catch (e) { return; } finally { proceeding = false; }
  dash.companies.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  renderDash();
}

/* ---------- purchase form ---------- */
function openForm(i) {
  current = dash.companies[i];
  const c = current;
  const fld = (id, label, val, type, req, span) => '<div class="f' + (span ? ' span2' : '') + '"><label for="' + id + '">' + label + (req ? ' *' : '') + '</label>' +
    (type === 'area' ? '<textarea id="' + id + '" class="fld" rows="2"' + (req ? ' required' : '') + '>' + esc(val) + '</textarea>'
      : '<input id="' + id + '" class="fld" type="' + (type || 'text') + '" value="' + esc(val) + '"' + (req ? ' required' : '') + '>') + '</div>';
  $('form').innerHTML = '<form onsubmit="event.preventDefault();submitForm()" class="formgrid">' +
    '<section class="card" style="padding:24px 28px"><a class="crumb" href="javascript:openDash(dash.reqId)">Back to the report</a><h1 style="margin:8px 0 20px">Request a quotation from ' + esc(c.name) + '</h1><div class="grid2">' +
    fld('f-to', 'Supplier email', c.email, 'email', true) + fld('f-model', 'Model', c.model, 'text', true) +
    fld('f-qty', 'Quantity', '1', 'text', true) + fld('f-date', 'Target delivery date', '', 'date', true) +
    fld('f-specs', 'Required specs and options', (dash.capacity ? dash.capacity + ', ' : ''), 'area', true, true) +
    fld('f-place', 'Delivery place', '', 'text', true) +
    '<div class="f"><label for="f-inco">Incoterm *</label><select id="f-inco" class="fld">' + ['CIF', 'FOB', 'CFR', 'CIP', 'FCA', 'EXW', 'DAP'].map(x => '<option>' + x + '</option>').join('') + '</select></div>' +
    fld('f-pay', 'Payment terms preferred', 'Letter of Credit at sight') + fld('f-war', 'Warranty expected', '24 months from commissioning') +
    fld('f-docs', 'Documents required', 'Test certificates, material certificates, compliance documents for India', 'text', true, true) +
    fld('f-spares', 'Spare parts to quote', '2-year recommended spares list') + fld('f-contact', 'Contact person', '', 'text', true) +
    '<div class="checks span2"><label><input type="checkbox" id="f-install" checked> Installation and commissioning</label><label><input type="checkbox" id="f-train" checked> Operator training</label></div>' +
    '</div><div style="display:flex;justify-content:flex-end;gap:12px;margin-top:22px"><button type="button" class="btn" onclick="openDash(dash.reqId)">Cancel</button><button type="submit" class="btn primary" id="subBtn">Submit and draft email</button></div></section>' +
    '<aside style="display:flex;flex-direction:column;gap:14px"><div class="card" style="padding:18px"><h3 class="h3">Supplier</h3><div style="margin-top:8px;font-size:17px;font-weight:600">' + esc(c.name) + '</div>' +
    '<div style="margin-top:6px;font-size:14px;color:var(--ink2);line-height:1.6">' + esc(c.nameZh) + '<br>' + esc(c.city) + '<br>Score ' + esc(c.total) + ' / 100 · ' + esc(c.verdict) + '</div></div>' +
    '<div class="card" style="padding:18px"><h3 class="h3">What happens next</h3><ol style="margin:10px 0 0;padding-left:20px;font-size:14px;color:var(--ink2);line-height:1.7"><li>Saved to the Requirements tab with an RFQ number</li><li>The agent drafts a professional English email</li><li>You check and edit it, then press Send</li><li>Replies are tracked in the Quotation Log</li></ol></div></aside></form>';
  show('form');
}
async function submitForm() {
  const v = id => $(id).value.trim();
  const f = { reqId: dash.reqId, supplier: current.name, to: v('f-to'), model: v('f-model'), qty: v('f-qty'), date: v('f-date'), specs: v('f-specs'), place: v('f-place'),
    inco: v('f-inco'), pay: v('f-pay'), war: v('f-war'), docs: v('f-docs'), spares: v('f-spares'), contact: v('f-contact'), install: $('f-install').checked, train: $('f-train').checked };
  $('subBtn').disabled = true; $('subBtn').textContent = 'Drafting the email…';
  try { draft = await call('submitRequirement', f); } catch (e) { $('subBtn').disabled = false; $('subBtn').textContent = 'Submit and draft email'; return; }
  $('email').innerHTML = '<section class="card" style="width:min(920px,100%);padding:22px 26px;display:flex;flex-direction:column;gap:12px">' +
    '<div style="display:flex;justify-content:space-between"><h1 style="margin:0;font-size:24px">Quotation email, ready to send</h1><span class="mono" style="color:var(--cyan)">' + esc(draft.rfq) + '</span></div>' +
    '<div class="meta"><span>To</span><span>' + esc(draft.to) + ' (' + esc(draft.supplier) + ')</span><span>CC</span><span>' + esc(draft.cc || 'none set in Settings') + '</span>' +
    '<label for="m-sub" style="color:var(--ink3)">Subject</label><input id="m-sub" class="fld" value="' + esc(draft.subject) + '"></div>' +
    (draft.warning ? '<p class="warnline" role="alert">' + esc(draft.warning) + '</p>' : '') +
    '<label for="m-body" style="font-size:13px;color:var(--ink2)">Message (edit any line before sending)</label>' +
    '<textarea id="m-body" class="fld" style="height:440px;line-height:1.55;resize:vertical">' + esc(draft.body) + '</textarea>' +
    '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--ink3)">Sends from your company Gmail. Nothing leaves until you press Send.</span>' +
    '<div style="display:flex;gap:12px"><button class="btn" onclick="show(\'form\')">Back to form</button><button class="btn primary" id="sendBtn" onclick="sendMail()">Send</button></div></div></section>';
  show('email');
}
async function sendMail() {
  $('sendBtn').disabled = true; $('sendBtn').textContent = 'Sending…';
  try { await call('sendRfq', { rfq: draft.rfq, subject: $('m-sub').value, body: $('m-body').value }); }
  catch (e) { $('sendBtn').disabled = false; $('sendBtn').textContent = 'Send'; return; }
  $('done').innerHTML = '<section class="card" style="width:min(560px,100%);text-align:center;padding:38px 34px;border-color:var(--goodline)"><h1>' + esc(draft.rfq) + ' sent to ' + esc(draft.supplier) + '</h1>' +
    '<p style="color:var(--ink2);line-height:1.6">Logged in the Quotation Log. Replies are checked every hour; if there is no answer after the follow-up days in Settings, a polite follow-up waits in your Gmail Drafts for you to send.</p>' +
    '<button class="btn primary" onclick="openDash(dash.reqId)">Back to dashboard</button></section>';
  show('done');
}

/* ---------- calm mode, thinking dots and count-up numbers ---------- */
function setCalm(on) {
  document.body.classList.toggle('calm', on);
  store.set('zobo_calm', on ? '1' : '0');
  const box = $('calmBox'); if (box) box.checked = on;
}
function applyDye() { /* colourways were replaced by the sky theme */ }
const motionOK = () => !document.body.classList.contains('calm') && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
/* "ZOBO is thinking" bubble with bouncing dots */
function showTyping(label) {
  hideTyping();
  const d = document.createElement('div');
  d.className = 'msg agent typing' + (label ? ' deeptyping' : ''); d.id = 'typingDots'; d.setAttribute('aria-label', 'ZOBO is thinking');
  d.innerHTML = '<i></i><i></i><i></i>' + (label ? '<span class="tlabel"></span>' : '');
  if (label) d.querySelector('.tlabel').textContent = label;
  $('msgs').appendChild(d); $('msgs').scrollTop = 1e9;
}
function typingLabel(t) { const d = $('typingDots'); const l = d && d.querySelector('.tlabel'); if (l) l.textContent = t; else showTyping(t); }
function hideTyping() { const t = $('typingDots'); if (t) t.remove(); }
/* numbers count up from 0 when a report opens */
function countUp(root) {
  if (!root || !motionOK()) return;
  root.querySelectorAll('[data-count]').forEach(el => {
    const end = Number(el.dataset.count) || 0, t0 = performance.now(), dur = 900;
    const tick = now => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(end * e); if (p < 1) requestAnimationFrame(tick); };
    el.textContent = '0'; requestAnimationFrame(tick);
  });
}
/* A slower computer starts in calm mode (no moving sky, no glass blur) unless the person chose otherwise: that is where most of the sluggishness on thin clients comes from. */
(function () {
  const pref = store.get('zobo_calm');
  const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const on = pref === '1' || (pref === null && weak);
  document.body.classList.toggle('calm', on);
  const box = $('calmBox'); if (box) box.checked = on;
})();


/* ---------- ZOBO voice: conversation mode (hands-free), Hindi and Hinglish, the clearest voice on the computer ---------- */
const SUB_LINE = 'Speak or type, in English or Hindi';
let LANG = store.get('zobo_lang') === 'hi-IN' ? 'hi-IN' : 'en-IN';   // what the microphone listens for
let convo = false, quietTurns = 0, speakSeq = 0, cancelTurn = false;

const isHindi = t => /[ऀ-ॿ]/.test(String(t || ''));
const HINGLISH_WORDS = /\b(kya|kaun|kaunsi|kaunsa|kaise|kitna|kitni|kitne|mujhe|humein|hamein|hume|batao|bataiye|bataye|chahiye|sabse|accha|achha|acchi|achhi|hai|hain|nahi|nahin|karo|kijiye|aap|apka|aapka|tum|mera|hamara|kyun|kab|kahan|kaha|wala|wali|dikhao|samjhao)\b/gi;
/** True when ZOBO should answer this message in Hindi. */
function wantsHindi(t) { return isHindi(t) || (String(t || '').match(HINGLISH_WORDS) || []).length >= 2 || LANG === 'hi-IN'; }

const IDENTITY_RE_HI = /(आप|तुम)\s*(कौन|क्या)\s*(हो|हैं|है)|(आपका|तुम्हारा|तेरा)\s*नाम|अपना\s*परिचय|(ज़ोबो|जोबो)\s*(कौन|क्या)|\b(aap|tum|ap)\s+(kaun|kya)\s+(ho|hai|hain)\b|\b(aapka|apka|tumhara)\s+naam\b/i;
const IDENTITY_LINE_HI = 'मैं ZOBO हूँ, ज़ोनैक निटिंग प्रोडक्शन का AI एजेंट। ज़ोनैक ग्रेटर नोएडा की एक भारतीय कंपनी है। आज मैं आपकी क्या मदद कर सकता हूँ?';
function isIdentity(t) { return IDENTITY_RE.test(t) || IDENTITY_RE_HI.test(t); }
function identityLine(t) { return wantsHindi(t) ? IDENTITY_LINE_HI : IDENTITY_LINE; }

/* "yes" and "stop" must be the whole message: "ji nahi", "ok but make it 3 ton" or "bas price batao" are not a yes or a stop */
const norm_ = t => String(t || '').toLowerCase().replace(/[.!?।,;:"'“”]+/g, ' ').replace(/\s+/g, ' ').trim();
const NOT_YES = /\b(no|not|nope|nahi|nahin|nai|na|mat|wait|but|back|cancel|rehne|change|instead|later|baad|ruko|stop)\b|नहीं|नही|मत|रुको|रहने|लेकिन|बदल|बाद में/;
/* a yes is a message made only of yes-words, with at least one real "yes" ("haan, shuru karo", "ठीक है, शुरू करो", "yes proceed") */
const YES_CORE = new Set('yes yeah yep yup go start ok okay proceed sure haan han haa ha ji theek thik chalo shuru alright fine हाँ हां जी ठीक चलो शुरू स्टार्ट ओके'.split(' '));
const YES_WORDS = new Set(Array.from(YES_CORE).concat('ahead it now please zobo hai karo kar karein do right sounds good let s lets है करो कीजिए करें दो'.split(' ')));
function isYes(t) { const s = norm_(t); if (!s || NOT_YES.test(s)) return false; const w = s.split(' '); return w.length <= 8 && w.every(x => YES_WORDS.has(x)) && w.some(x => YES_CORE.has(x)); }
const STOP_RE = /^(stop( listening| now)?|that s all|thats all|that is all|thank you( zobo| so much)?|thanks( zobo| a lot)?|bye( bye)?|goodbye|good bye|bas( karo)?|ruk jao|band karo|shukriya|dhanyavaad|dhanyawad|बस( करो)?|रुको|रुक जाओ|बंद करो|धन्यवाद|शुक्रिया|थैंक यू|थैंक्यू)( zobo| ji| जी)?$/;
function isStop(t) { return STOP_RE.test(norm_(t)); }

/* the clearest voice this computer has: natural or online voices first, Indian English for English, Hindi for Hindi */
let VOICES = [];
function loadVoices() { try { VOICES = speechSynthesis.getVoices() || []; } catch (e) { VOICES = []; } }
if (window.speechSynthesis) { loadVoices(); try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch (e) { /* old browser */ } }
function pickVoice(hindi) {
  if (!VOICES.length) loadVoices();
  let best = null, bestScore = -1;
  VOICES.forEach(v => {
    const n = v.name + ' ' + v.lang;
    let s;
    if (hindi) { if (!/^hi/i.test(v.lang)) return; s = 50; }
    else if (/^en[-_]IN/i.test(v.lang)) s = 40;
    else if (/^en[-_]GB/i.test(v.lang)) s = 22;
    else if (/^en/i.test(v.lang)) s = 20;
    else return;
    if (/natural|online|neural/i.test(n)) s += 30;
    if (/Neerja|Swara|Prabhat|Madhur|Heera|Kalpana|Ravi|Google/i.test(n)) s += 8;
    if (s > bestScore) { bestScore = s; best = v; }
  });
  return best;
}

/** Text as it should be spoken: no links or list dashes, a sensible length, and "ZOBO" said as a name, not spelled out. */
function speakable(text, hindi) {
  let t = String(text || '').split(/\n\s*\nSources:/)[0];
  t = t.replace(/https?:\/\/\S+/g, '').replace(/^\s*-\s+/gm, '').replace(/([.!?।:])\s*\n+/g, '$1 ').replace(/\n+/g, '. ').replace(/(\.\s*){2,}/g, '. ').trim();
  const max = 700;
  if (t.length > max) {
    t = t.slice(0, max);
    const k = Math.max(t.lastIndexOf('. '), t.lastIndexOf('।'), t.lastIndexOf('? '));
    if (k > 200) t = t.slice(0, k + 1);
    t += hindi ? ' पूरा जवाब स्क्रीन पर है।' : ' The full answer is on screen.';
  }
  return t.replace(/\bZOBO\b/g, hindi ? 'ज़ोबो' : 'Zobo');
}
/** Short pieces, because some browsers stop reading after about 15 seconds of one long sentence. */
function speechChunks(t) {
  const out = []; let cur = '';
  (t.match(/[^.!?।]+[.!?।]*\s*/g) || [t]).forEach(p => {
    if (cur && (cur + p).length > 220) { out.push(cur.trim()); cur = ''; }
    cur += p;
    while (cur.length > 260) { const c = cur.lastIndexOf(' ', 240); const k = c > 60 ? c : 240; out.push(cur.slice(0, k).trim()); cur = cur.slice(k); }
  });
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/* ZOBO speaks when "Read replies aloud" is on, when the person just used the microphone, or in conversation mode. */
function speak(text, force) {
  if (!force && !convo && !$('speakOn').checked && !voiceInput) return;
  const seq = ++speakSeq;
  if (!window.speechSynthesis) { afterSpeech(seq); return; }
  try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  const hindi = isHindi(text);
  const parts = speechChunks(speakable(text, hindi));
  if (!parts.length) { afterSpeech(seq); return; }
  const v = pickVoice(hindi);
  setVoiceState('speaking');
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = hindi ? 'hi-IN' : 'en-IN';
    if (i === parts.length - 1) u.onend = () => { if (seq === speakSeq) { setVoiceState(''); afterSpeech(seq); } };
    u.onerror = e => { if (seq === speakSeq && e.error !== 'interrupted' && e.error !== 'canceled') { setVoiceState(''); afterSpeech(seq); } };
    try { speechSynthesis.speak(u); } catch (e) { setVoiceState(''); }   // a browser without a voice must never break the app
  });
}
function stopSpeaking() { speakSeq++; try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } setVoiceState(''); }

/** In conversation mode, open the microphone again once ZOBO has finished speaking. */
function afterSpeech(seq) {
  if (!convo || listening) return;
  setTimeout(() => {
    if (!convo || listening || seq !== speakSeq) return;
    if (window.speechSynthesis && speechSynthesis.speaking) return;
    const view = $('expert').classList.contains('on') ? 'xq' : $('assist').classList.contains('on') ? 'cmd' : null;
    if (!view || (view === 'xq' && expertBusy)) return;
    startListening(view);
  }, 350);
}

/** A message on screen that ZOBO does not read aloud. */
function note(text) {
  if ($('assist').classList.contains('on')) { const d = document.createElement('div'); d.className = 'msg agent'; d.textContent = text; $('msgs').appendChild(d); $('msgs').scrollTop = 1e9; }
  else toast(text);
}

/* ---------- microphone ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
let micTarget = 'cmd';
function toggleMic(target) {
  if (typeof live !== 'undefined' && live) { toast('Live talk is on: just speak. Tap Live talk to end it.'); return; }
  if (listening && rec) { try { rec.stop(); } catch (e) { /* ignore */ } return; }
  startListening(target || 'cmd');
}
function startListening(target) {
  if (!SR) { setConvo(false); toast('Voice input is not available in this browser. Use Chrome or Edge, or press Windows key + H to dictate into the box.'); return; }
  if (listening) return;
  micTarget = target || 'cmd';
  const micBtn = $(micTarget === 'cmd' ? 'mic' : 'xmic');
  try { rec = new SR(); } catch (e) { setConvo(false); toast('Voice input is not available here. Please type.'); return; }
  rec.lang = LANG; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  rec.onstart = () => {
    stopSpeaking(); listening = true; setVoiceState('listening');
    micBtn.classList.add('listening'); micBtn.setAttribute('aria-label', 'Stop listening');
    if (micTarget === 'cmd') hud('LISTENING', convo ? 'I am listening' : 'Listening', convo ? (LANG === 'hi-IN' ? 'बोलिए। खत्म करने के लिए "बस" कहिए।' : 'Speak now. Say "stop" to end the conversation.') : 'Speak now', true);
  };
  rec.onresult = e => { $(micTarget).value = Array.from(e.results).map(r => r[0].transcript).join(' '); };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setConvo(false); toast('The microphone is blocked on this page. Click the lock icon next to the web address, allow the microphone and reload. Or press Windows key + H to dictate, or type.'); }
    else if (e.error === 'network') toast('Voice needs the internet: the browser turns speech into text online. Check the connection, or type.');
    else if (e.error === 'audio-capture') { setConvo(false); toast('No microphone was found. Plug in a headset or microphone, or type.'); }
    else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Voice error: ' + e.error);
  };
  rec.onend = () => {
    listening = false; micBtn.classList.remove('listening'); micBtn.setAttribute('aria-label', 'Speak'); setVoiceState('');
    if (cancelTurn) { cancelTurn = false; $(micTarget).value = ''; if (micTarget === 'cmd' && !running) hud('ONLINE', pending ? 'Shall I start?' : 'What do you need to buy?', SUB_LINE); return; }
    const said = $(micTarget).value.trim();
    if (!said) {
      if (convo) {
        if (++quietTurns >= 2) { setConvo(false); note(LANG === 'hi-IN' ? 'कुछ देर से कोई आवाज़ नहीं आई, इसलिए मैंने सुनना बंद कर दिया। फिर से बात करने के लिए Conversation mode दबाइए।' : 'It went quiet, so I stopped listening. Press Conversation mode to talk again.'); }
        else { afterSpeech(speakSeq); return; }
      }
      if (micTarget === 'cmd' && !running) hud('ONLINE', pending ? 'Shall I start?' : 'What do you need to buy?', SUB_LINE);
      return;
    }
    quietTurns = 0;
    if (convo && isStop(said)) {
      $(micTarget).value = ''; setConvo(false);
      const bye = isHindi(said) || LANG === 'hi-IN' ? 'ठीक है, मैं सुनना बंद कर रहा हूँ। ज़रूरत हो तो माइक दबाइए।' : 'Okay, I will stop listening. Press the mic when you need me.';
      if (micTarget === 'cmd') { say(bye); if (!running) hud('ONLINE', 'What do you need to buy?', SUB_LINE); } else speak(bye, true);
      return;
    }
    if (micTarget !== 'cmd') { expertSend(undefined, true); return; }
    if (!running) hud('ONLINE', pending ? 'Shall I start?' : 'What do you need to buy?', SUB_LINE);
    sendText(true);
  };
  try { rec.start(); } catch (e) { listening = false; }
}

/* ---------- conversation mode and language ---------- */
function setConvo(on) {
  convo = !!on; quietTurns = 0;
  document.body.classList.toggle('convo', convo);
  document.querySelectorAll('.convoBtn').forEach(b => {
    b.classList.toggle('on', convo); b.setAttribute('aria-pressed', convo ? 'true' : 'false');
    const l = b.querySelector('.cl'); if (l) l.textContent = convo ? 'Conversation on · tap to end' : 'Conversation mode';
  });
}
function toggleConvo() {
  if (convo) {
    setConvo(false); stopSpeaking();
    if (listening && rec) { cancelTurn = true; try { rec.abort(); } catch (e) { /* ignore */ } }
    return;
  }
  if (!SR) { toast('Conversation mode needs Chrome or Microsoft Edge and a microphone. You can still type, and ZOBO reads replies aloud.'); return; }
  setConvo(true);
  const hello = LANG === 'hi-IN' ? 'कन्वर्सेशन मोड चालू है। बोलिए, मैं सुन रहा हूँ। खत्म करने के लिए "बस" कहिए।' : 'Conversation mode is on. Go ahead, I am listening. Say stop when you are done.';
  if ($('assist').classList.contains('on')) hud('ONLINE', 'Conversation mode', LANG === 'hi-IN' ? 'हिन्दी या अंग्रेज़ी में बोलिए' : 'Talk to me. Say "stop" to end.', true);
  speak(hello, true);   // when it finishes, the microphone opens by itself
}
function setLang(v) {
  LANG = v === 'hi-IN' ? 'hi-IN' : 'en-IN';
  store.set('zobo_lang', LANG);
  document.querySelectorAll('.langSel').forEach(s => { s.value = LANG; });
}
document.querySelectorAll('.langSel').forEach(s => { s.value = LANG; });


/* ---------- deep research mode: a button, or say "deep research mode" (English, Hindi or Hinglish) ---------- */
let deepMode = false, SERVER_BUILD = '';
const DEEP_BUILD = '2026.10.08';   // the script release that has deep research
const deepKey = () => 'zobo_deep:' + (store.get('zobo_who') || '');
const deepReady = () => !SERVER_BUILD || SERVER_BUILD >= DEEP_BUILD;
function deepChipState() {
  document.body.classList.toggle('deep', deepMode);
  document.querySelectorAll('.deepBtn').forEach(b => {
    b.classList.toggle('on', deepMode); b.setAttribute('aria-pressed', deepMode ? 'true' : 'false');
    const l = b.querySelector('.cl'); if (l) l.textContent = deepMode ? 'Deep research on' : 'Deep research';
  });
}
/** Turn deep research mode on or off. It is remembered on this computer for this person. */
function setDeep(on, quiet, hindi) {
  if (modesReady() || !SERVER_BUILD) { setMode(on ? (MODE === 'advanced' ? 'advanced' : 'deep') : 'chat', quiet, hindi); if (modesReady() || quiet) return; }
  deepMode = !!on;
  store.set(deepKey(), deepMode ? '1' : '0');
  deepChipState();
  if (quiet) return;
  const hi = hindi || LANG === 'hi-IN';
  const msg = deepMode
    ? (hi ? 'डीप रिसर्च मोड चालू है। अब हर सवाल और हर सप्लायर सर्च ज़्यादा गहराई से होगी: अंग्रेज़ी और चीनी में ज़्यादा सर्च, सबसे भरोसेमंद पेज पढ़ना, कमी वाले तथ्यों के लिए कई राउंड, और हर तथ्य की दो अलग AI से जाँच। जवाब में एक से तीन मिनट लगेंगे। बंद करने के लिए "डीप रिसर्च बंद करो" कहिए।'
          : 'Deep research mode is on. Every question and supplier search now goes deeper: more searches in English and Chinese, the most trustworthy pages read, several rounds for missing facts, and two different AIs checking every fact. Answers take about 1 to 3 minutes. Say "deep research off" to go back.')
    : (hi ? 'डीप रिसर्च मोड बंद है। अब सामान्य, तेज़ मोड चल रहा है।' : 'Deep research mode is off. Back to the normal, faster mode.');
  if ($('assist').classList.contains('on')) { say(msg); if (!running) hud('ONLINE', deepMode ? 'Deep research mode' : 'What do you need to buy?', deepMode ? 'Ask a question or name a machine: I will research it in depth' : SUB_LINE); }
  else if ($('expert').classList.contains('on')) { expertItems.push({ q: hi ? 'डीप रिसर्च मोड' : 'Deep research mode', x: { answer: msg, sources: [], searched: 0, usage: '', limit: 250, note: true } }); renderExpert(); speak(msg); }
  else toast(msg);
  if (deepMode && !deepReady()) toast('Deep research needs script release ' + DEEP_BUILD + ' or newer (the server has ' + SERVER_BUILD + '). Paste the new script files and deploy a New version.');
}
function toggleDeep() { setDeep(!deepMode); }
const DEEP_SAID = /\b(deep|dip|deeper)\s*(research|search|mode|dive)\b|डीप\s*(रिसर्च|सर्च|मोड)|दीप\s*(रिसर्च|सर्च)|(गहरी|गहन)\s*(रिसर्च|खोज|जाँच|जांच)|\bgehri\s+(research|khoj|jaanch|jaach)\b/i;
/* the words of a command (whole words only, so a Hindi topic word is never cut into pieces) */
const DEEP_FILL = new Set(('please pls zobo turn switch put set start enable activate use go into to the a an do mode on off now deep deeper dip dive research search stop disable end exit close deactivate normal quick fast ' +
  'chalu chaalu shuru karo kar kijiye kardo karna band bandh gehri khoj ok okay and mein me se wala wali ko hatao it this that again back mat nahi nahin no not never don dont t ' +
  'स्टार्ट कीजिए करें करो कर दो दीजिए डीप दीप रिसर्च सर्च मोड चालू ऑन शुरू बंद ऑफ गहरी गहन खोज जाँच जांच सामान्य ज़ोबो जोबो में से को हटाओ मत नहीं ना').split(' '));
const DEEP_OFF = /\b(off|stop|disable|end|exit|close|deactivate|band|bandh|hatao|normal|quick|fast)\b|बंद|ऑफ|हटाओ|सामान्य/i;
const DEEP_NEG = /\b(don ?t|dont|do not|no|not|never|mat|nahi|nahin|without)\b|मत|नहीं|\bना\b/i;
const DEEP_ASKS = /\?\s*$|^(is|are|was|what|whats|what s|which|how|does|do you|kya)\b|\b(kya|hai kya|kaisa|status|explain)\b|क्या|कैसे|है\s*क्या/i;
/**
 * What a message means for deep research mode:
 *   {mode:'once', q}  one deep question ("deep research on boilers", "deep research: कपास", "deep research Chinese sock machine makers")
 *   {mode:'status'}   a question about the mode ("is deep research on?", "deep research kya hai", "what is deep research mode")
 *   {mode:'on'|'off'} switch it ("deep research mode", "deep research off", "don't use deep research" = off, "deep research band mat karo" = on)
 *   null              the message is not about deep research
 */
function deepCommand(t) {
  const raw = String(t || '').trim();
  const s = raw.replace(/[.!।,;"'“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!DEEP_SAID.test(s)) return null;
  const content = w => w.split(/[\s?:\-–]+/).filter(x => x && !DEEP_FILL.has(x.toLowerCase()));
  // 1. a topic after "deep research on / about / for / into / of" or a colon: one deep question; an off-word inside the topic does not count
  const m = raw.match(/\b(?:deep(?:er)?|dip)\s*(?:research|search|dive)\s*(?:mode\s*)?(?:on|about|for|into|of|regarding)\s+(.+)$/i) ||
            raw.match(/\b(?:deep(?:er)?|dip)\s*(?:research|search|dive)\s*(?:mode\s*)?[:\-–]\s*(.+)$/i) ||
            raw.match(/(?:डीप|गहरी|गहन)\s*(?:रिसर्च|खोज|सर्च)\s*(?:करो|कीजिए|करें)?\s*[:\-–]\s*(.+)$/);
  if (m && content(m[1]).length) return { mode: 'once', q: m[1].trim() };
  // 2. a question about the mode itself
  const rest = content(s);
  if (DEEP_ASKS.test(raw) && rest.filter(w => !/^(is|are|was|what|whats|which|how|does|you|kya|hai|kaisa|status|explain|क्या|है|कैसे|it|work|works|mean|means|mode|chalu|on|off)$/i.test(w)).length === 0) return { mode: 'status' };
  // 3. a question with a real topic, without "on/about": one deep question ("deep research Chinese sock machine makers")
  if (rest.length >= 2 || (rest.length === 1 && rest[0].length >= 3 && !DEEP_ASKS.test(raw))) {
    const q = raw.replace(/^\s*(please\s+)?(zobo[,\s]+)?(do\s+(a\s+)?|run\s+(a\s+)?|start\s+(a\s+)?|use\s+)?(deep(er)?\s*(research|search|dive))(\s*mode)?\s*/i, '').replace(/^\s*(डीप|गहरी|गहन)\s*(रिसर्च|खोज|सर्च)\s*(करो|कीजिए|करें)?\s*/, '').trim();
    return { mode: 'once', q: q.split(/\s+/).length >= 3 ? q : raw };
  }
  // 4. switching: off-words turn it off, a negation flips the meaning ("don't use deep research" = off, "deep research band mat karo" = on)
  const off = DEEP_OFF.test(s), neg = DEEP_NEG.test(s);
  return { mode: off !== neg ? 'off' : 'on' };
}
/** Act on a deep research command that is not a question: switch the mode, or say whether it is on. */
function deepApply(dc, quiet, hindi) {
  if (dc.mode === 'status') {
    const hi = hindi || LANG === 'hi-IN';
    const msg = deepMode
      ? (hi ? 'डीप रिसर्च मोड अभी चालू है। हर सवाल और सप्लायर सर्च ज़्यादा गहराई से होती है (सवाल में 1 से 3 मिनट, सप्लायर सर्च में आमतौर पर 5 से 10 मिनट)। बंद करने के लिए "डीप रिसर्च बंद करो" कहिए।'
            : 'Deep research mode is ON. Every question and supplier search goes deeper: more searches in English and Chinese, the most trustworthy pages read, several rounds for missing facts and two different AIs checking the facts. A question takes 1 to 3 minutes, a supplier search usually 5 to 10 minutes. Say "deep research off" to switch it off.')
      : (hi ? 'डीप रिसर्च मोड अभी बंद है। सामान्य मोड तेज़ है और फिर भी हर कंपनी के कमी वाले तथ्यों के लिए एक छोटी खोज करता है। चालू करने के लिए "डीप रिसर्च मोड" कहिए या Deep research बटन दबाइए।'
            : 'Deep research mode is OFF. The normal mode is faster and still runs one small gap search per company for missing facts. To switch deep research on, press Deep research or say "deep research mode". For one deep question only, say "deep research on" and the topic.');
    if (quiet) toast(msg); else if ($('assist').classList.contains('on')) say(msg);
    else if ($('expert').classList.contains('on')) { expertItems.push({ q: hi ? 'डीप रिसर्च मोड?' : 'Deep research mode?', x: { answer: msg, sources: [], searched: 0, usage: '', limit: 250, note: true } }); renderExpert(); speak(msg); }
    else toast(msg);
    return;
  }
  setDeep(dc.mode === 'on', quiet, hindi);
  if (quiet) toast(deepMode ? 'Deep research mode is on.' : 'Deep research mode is off.');
}
function newJob() { return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
/** Shows the live steps of a deep research answer while it runs. Returns a function that stops watching. */
function watchProgress(job, onStep) {
  let stop = false, last = '';
  const sess = SESSION;
  (async () => {
    await sleep(1200);
    while (!stop && sess === SESSION) {   // stops at sign-out too
      try { const p = await api('progress', [job], true); if (!stop && p && p.text && p.text + p.pct !== last) { last = p.text + p.pct; onStep(p); } } catch (e) { /* only a display */ }
      await sleep(1800);
    }
  })();
  return () => { stop = true; };
}
/** The sources line under a spoken or chat answer: deep answers keep their source numbers. */
function sourcesLine(x, where) {
  if (!x || !x.sources || !x.sources.length) return '';
  return '\n\nSources: ' + x.sources.map((s, i) => '[' + (s.n || i + 1) + '] ' + s.title + (s.site && s.site !== s.title ? ' (' + s.site + ')' : '')).join('; ') + '.' + (where ? ' ' + where : '');
}
function deepMeta(x) {
  if (!x || !x.deep) return '';
  return 'Deep research: ' + x.searched + ' search' + (x.searched === 1 ? '' : 'es') + ', ' + x.read + ' page' + (x.read === 1 ? '' : 's') + ' read, ' + x.rounds + ' round' + (x.rounds === 1 ? '' : 's') +
    (x.grounded ? ', Google Search' : '') + (x.seconds ? ', ' + x.seconds + ' s' : '') + (x.confidence ? ' · Confidence: ' + x.confidence : '');
}


/* ---------- morning news brief (Industry Expert page) ---------- */
let NEWS = null, newsBusy = false, newsAll = false;
function newsDate(d) { const t = new Date(d + 'T00:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function renderNews() {
  const el = $('xNews'); if (!el) return;
  if (newsBusy && !NEWS) { el.innerHTML = '<div class="xthinking"><span class="typing" style="padding:0!important"><i></i><i></i><i></i></span>Preparing today\'s news brief from Google News… (about 20 seconds)</div>'; return; }
  if (!NEWS || !NEWS.items || !NEWS.items.length) {
    el.innerHTML = '<div class="newshead"><div><span class="label">Morning brief</span><h2 class="h2">Today in socks and textiles</h2><p class="muted">' + esc((NEWS && NEWS.intro) || 'No brief yet.') + '</p></div>' +
      (ME && ME.can.start ? '<div class="newsbtns"><button class="btn" onclick="refreshNews()">Get today\'s news</button></div>' : '') + '</div>';
    return;
  }
  const list = newsAll ? NEWS.items : NEWS.items.slice(0, 4);
  el.innerHTML = '<div class="newshead"><div><span class="label">Morning brief · ' + esc(newsDate(NEWS.date)) + '</span><h2 class="h2">Today in socks and textiles</h2>' +
      (NEWS.intro ? '<p class="newsintro">' + esc(NEWS.intro) + '</p>' : '') + '</div>' +
    '<div class="newsbtns"><button class="btn" onclick="readNews()">Read aloud</button>' + (ME && ME.can.start ? '<button class="btn" id="newsRefresh" onclick="refreshNews()"' + (newsBusy ? ' disabled' : '') + '>' + (newsBusy ? 'Checking…' : 'Check for more') + '</button>' : '') + '</div></div>' +
    '<div class="newsgrid">' + list.map(x => '<article class="newsitem"><span class="newssec">' + esc(x.section) + '</span>' +
      (links(x.url).length ? '<a class="ext" href="' + esc(links(x.url)[0]) + '" target="_blank" rel="noopener">' + esc(x.headline) + '</a>' : '<b>' + esc(x.headline) + '</b>') +
      '<p>' + esc(x.summary) + '</p>' + (x.why ? '<p class="why"><b>Why it matters:</b> ' + esc(x.why) + '</p>' : '') +
      '<span class="muted">' + esc([x.source, x.date].filter(Boolean).join(' · ')) + '</span></article>').join('') + '</div>' +
    '<div class="newsfoot">' + (NEWS.items.length > 4 ? '<button class="chipbtn" onclick="newsAll=!newsAll;renderNews()">' + (newsAll ? 'Show fewer' : 'Show all ' + NEWS.items.length + ' stories') + '</button>' : '') +
    '<span class="muted">Collected every morning at 7:30 from Google News. Summaries are based on the headlines; open a story for details, or ask ZOBO below.</span></div>';
}
/** Shows the newest brief at once (remembered, then the script's latest), and builds today's in the background when the latest is older. */
async function loadNews() {
  if (newsBusy) return;
  const old = paint.get('news');
  if (old && old.v && !NEWS) NEWS = old.v;
  newsBusy = true; renderNews();
  try {
    let n = await api('getNews', [true], true);   // true = an older brief is fine for now
    if (n && n.stale) {
      NEWS = Object.assign({}, n); renderNews();   // yesterday's stories on screen while today's are collected (about 20 seconds)
      n = await api('getNews', [], true);
    }
    NEWS = n;
    if (n && n.items && n.items.length) paint.set('news', n);
  } catch (e) { NEWS = NEWS || { intro: 'The news brief could not be loaded just now.', items: [] }; }
  newsBusy = false; renderNews();
}
async function refreshNews() {
  if (newsBusy) return;
  newsBusy = true; renderNews();
  try { NEWS = await call('refreshNews'); toast('News brief updated.'); } catch (e) { /* toast shown */ }
  newsBusy = false; renderNews();
}
function readNews() {
  if (!NEWS || !NEWS.items.length) return;
  if (LANG === 'hi-IN') { expertSend('आज की मुख्य खबरें हिंदी में बताइए', true); return; }
  speak('Here is today\'s brief. ' + (NEWS.intro || '') + ' ' + NEWS.items.slice(0, 6).map((x, i) => (i + 1) + '. ' + x.headline + '.').join(' '), true);
}


/* =====================================================================
   DECISION ROOM (dashboard tab): committee recommendation, India import and landed cost,
   photo and certificate checks, payback from our own data, and feedback that teaches ZOBO.
   ===================================================================== */
const inrA = n => n == null || isNaN(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
const advOf = () => (dash && dash.advanced) || {};
const PB_FIELDS = [
  ['machines', 'Machines to buy', 1], ['shifts', 'Shifts per day', 3], ['days', 'Working days per year', 300],
  ['oldOut', 'Today: pairs per machine per shift', 0], ['newOut', 'New machine: pairs per machine per shift', 0],
  ['oldDown', 'Today: downtime %', 15], ['newDown', 'New machine: downtime %', 8],
  ['oldWaste', 'Today: yarn waste or rejects %', 4], ['newWaste', 'New machine: waste or rejects %', 2],
  ['yarnCost', 'Yarn cost per pair (₹)', 0], ['margin', 'Contribution per extra pair sold (₹)', 0],
  ['oldKw', 'Today: power per machine (kW)', 0], ['newKw', 'New machine: power (kW)', 0], ['rate', 'Power cost (₹ per kWh)', 8],
  ['oldLabour', 'Today: operator cost per machine per month (₹)', 0], ['newLabour', 'New machine: operator cost per machine per month (₹)', 0]
];
let pbInputs = null, pbEpcg = false, pbSell = true;
function pbDefaults() { const o = {}; PB_FIELDS.forEach(f => { o[f[0]] = f[2]; }); return o; }

/** Yearly benefit of the new machines and the payback for each supplier's landed cost. */
function paybackCalc(inp, landed) {
  const v = k => Number(inp[k]) || 0;
  const perYear = v('shifts') * v('days') * v('machines');
  const oldEff = v('oldOut') * (1 - v('oldDown') / 100), newEff = v('newOut') * (1 - v('newDown') / 100);
  const extraPairs = pbSell ? Math.max(0, (newEff - oldEff) * perYear) : 0;
  const wasteSave = newEff * perYear * Math.max(0, v('oldWaste') - v('newWaste')) / 100 * v('yarnCost');
  const hours = v('shifts') * 8 * v('days') * v('machines');
  const energy = (v('oldKw') - v('newKw')) * hours * v('rate');
  const labour = (v('oldLabour') - v('newLabour')) * 12 * v('machines');
  const benefit = extraPairs * v('margin') + wasteSave + energy + labour;
  const goodOld = v('oldOut') * (1 - v('oldDown') / 100) * (1 - v('oldWaste') / 100), goodNew = v('newOut') * (1 - v('newDown') / 100) * (1 - v('newWaste') / 100);
  return { benefit, extraPairs, wasteSave, energy, labour, goodOld, goodNew,
    rows: (landed || []).map(l => { const each = pbEpcg ? (l.epcgLanded || l.cif) : (l.landedNetOfIgst || l.cif); const invest = each ? each * v('machines') : null;
      return { name: l.name, invest, years: invest && benefit > 0 ? invest / benefit : null, note: l.note }; }) };
}

function decisionHtml() {
  const a = advOf(), d = dash;
  if (!dash.advanced) return '<div class="empty" style="padding:40px">The Decision room appears after the deep checks finish (a few minutes after the report).</div>';
  const canAct = ME && ME.can.start;
  // committee
  const dec = a.decision;
  const conf = c => '<span class="st ' + (/high/i.test(c) ? 'ok' : /low/i.test(c) ? 'bad' : 'warn') + '">' + esc(c || '—') + ' confidence</span>';
  const committee = '<section class="card advcard"><div class="advhead"><div><span class="label">Expert committee: buyer, risk officer, finance analyst</span><h2 class="h2">Recommendation</h2></div>' +
    (canAct ? '<button class="btn" id="debateBtn" onclick="rerunDebate()">' + (dec ? 'Debate again' : 'Run the debate') + '</button>' : '') + '</div>' +
    (dec ? '<div class="pick"><b>' + esc(dec.recommended) + '</b>' + conf(dec.confidence) + (dec.runnerUp ? '<span class="muted">Runner-up: ' + esc(dec.runnerUp) + '</span>' : '') + '</div>' +
      '<p class="verdict">' + esc(dec.verdict) + '</p>' +
      (dec.disagreement ? '<p class="disagree"><b>Where they disagreed:</b> ' + esc(dec.disagreement) + '</p>' : '') +
      (dec.conditions.length ? '<div class="label" style="margin-top:6px">Confirm before buying</div><ul class="conds">' + dec.conditions.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      '<details class="views"><summary>Read each committee member\'s view</summary>' + [dec.buyer, dec.risk, dec.finance].filter(Boolean).map(x => '<p>' + esc(x) + '</p>').join('') + '</details>'
      : '<p class="muted">No recommendation yet.</p>') + '</section>';

  // India import and landed cost
  const imp = a.import, lc = a.landed || [];
  const importCard = '<section class="card advcard"><div class="advhead"><div><span class="label">India import · estimates, confirm with your CHA</span><h2 class="h2">Duty, landed cost and EPCG</h2></div>' +
    (canAct ? '<button class="btn" id="importBtn" onclick="rerunImport()">' + (imp ? 'Check again' : 'Work it out') + '</button>' : '') + '</div>' +
    (imp ? '<dl class="facts-row"><div><dt>HS code</dt><dd>' + esc(imp.hs) + '</dd></div><div><dt>Basic duty</dt><dd>' + esc(imp.bcd) + '%</dd></div><div><dt>SWS</dt><dd>' + esc(imp.sws) + '% of BCD</dd></div>' +
      (imp.aidc ? '<div><dt>AIDC</dt><dd>' + esc(imp.aidc) + '%</dd></div>' : '') + '<div><dt>IGST</dt><dd>' + esc(imp.igst) + '% (usually claimable as GST credit)</dd></div><div><dt>IBR</dt><dd>' + esc(imp.ibr || '—') + '</dd></div>' +
      '<div><dt>BIS / QCO</dt><dd>' + esc(imp.bis || '—') + '</dd></div><div><dt>EPCG</dt><dd>' + esc(imp.epcg || '—') + '</dd></div><div><dt>Confidence</dt><dd>' + esc(imp.confidence || '—') + '</dd></div></dl>' +
      '<p class="muted" style="margin:6px 0 0">' + esc(imp.hsDesc || '') + (imp.epcgNotes ? ' · EPCG: ' + esc(imp.epcgNotes) : '') + '</p>' : '<p class="muted">Not worked out yet.</p>') +
    (lc.length ? '<div class="cmpwrap" style="max-height:none;margin-top:12px"><table class="evt list adv"><thead><tr><th>Supplier</th><th>Price</th><th>CIF India</th><th>Customs duty</th><th>IGST</th><th>Landed</th><th>Net of GST credit</th><th>With EPCG</th><th>EPCG export obligation</th></tr></thead><tbody>' +
      lc.map(l => l.cif ? '<tr><td><b>' + esc(l.name) + '</b>' + (l.quoted ? '<div class="muted">quoted</div>' : '<div class="muted">estimate</div>') + (l.term ? '<div class="muted">' + esc(l.term) + '</div>' : '') + (l.note ? '<div class="muted" style="max-width:260px">' + esc(l.note) + '</div>' : '') + '</td><td>' + inrA(l.priceInr) + '</td><td>' + inrA(l.cif) + '</td><td>' + inrA((l.bcd || 0) + (l.sws || 0) + (l.aidc || 0)) + '</td><td>' + inrA(l.igst) + '</td><td><b>' + inrA(l.landed) + '</b></td><td>' + inrA(l.landedNetOfIgst) + '</td><td>' + inrA(l.epcgLanded) + (l.epcgEconomic != null ? '<div class="muted">real saving ' + inrA(l.epcgEconomic) + '; IGST ' + inrA(l.epcgIgstCashflow) + ' is cash flow only</div>' : '') + '</td><td>' + inrA(l.epcgObligation) + '<div class="muted">over 6 years</div></td></tr>'
        : '<tr><td><b>' + esc(l.name) + '</b></td><td colspan="8" class="muted">' + esc(l.note || '') + '</td></tr>').join('') + '</tbody></table></div>' +
      '<p class="muted" style="font-size:12px;margin:8px 0 0">Freight and insurance ' + esc(a.freightPct) + '% and clearing ' + esc(a.clearingPct) + '% (Settings tab). EPCG export obligation is usually 6 times all the duty and IGST saved, within 6 years, on top of your average exports; the EPCG licence must be in hand before the bill of entry. CIF depends on the Incoterm: EXW adds about 3% more for China inland transport, CFR adds 1.125% insurance, CIF and DAP are taken as they are.</p>' : '') +
    (imp && imp.sources && imp.sources.length ? '<p class="muted" style="font-size:12px;margin:4px 0 0">Sources: ' + imp.sources.slice(0, 4).map(u => links(u).length ? '<a class="ext" href="' + esc(links(u)[0]) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]) + '</a>' : '').join(' · ') + '</p>' : '') + '</section>';

  // photos and certificates
  const visual = '<section class="card advcard"><div class="advhead"><div><span class="label">ZOBO\'s AI looked at each supplier\'s own photos, videos and certificates</span><h2 class="h2">Photo and certificate check</h2></div></div>' +
    '<div class="vgrid">' + d.companies.map(c => { const v = c.cp['Visual check (AI)'] || 'Not checked', ce = c.cp['Certificates checked (AI)'] || '';
      const cls = /borrowed|office or showroom|EXPIRED|DOES NOT MATCH/i.test(v + ce) ? 'bad' : /^real factory seen/i.test(v) ? 'ok' : /renders|cannot tell|could not/i.test(v) ? 'warn' : 'unk';
      return '<article class="vitem ' + cls + '"><b>' + esc(c.name) + '</b><p>' + esc(v) + '</p>' + (ce ? '<p class="certs">' + esc(ce).replace(/\n/g, '<br>') + '</p>' : '') + '</article>'; }).join('') + '</div></section>';

  // payback
  if (!pbInputs) pbInputs = Object.assign(pbDefaults(), a.payback || {});
  const pb = paybackCalc(pbInputs, lc.filter(l => l.cif));
  const payback = '<section class="card advcard"><div class="advhead"><div><span class="label">Uses your factory\'s numbers, not supplier claims</span><h2 class="h2">Payback for Zonac</h2></div>' +
    (canAct ? '<button class="btn" onclick="savePb()">Save these numbers</button>' : '') + '</div>' +
    '<div class="pbgrid">' + PB_FIELDS.map(f => '<label><span>' + esc(f[1]) + '</span><input class="fld" type="number" step="any" value="' + esc(pbInputs[f[0]]) + '" oninput="pbInputs[\'' + f[0] + '\']=this.value;updatePb()"></label>').join('') + '</div>' +
    '<div class="pbopts"><label class="voice"><input type="checkbox" ' + (pbSell ? 'checked' : '') + ' onchange="pbSell=this.checked;updatePb()"> We can sell the extra pairs</label>' +
    '<label class="voice"><input type="checkbox" ' + (pbEpcg ? 'checked' : '') + ' onchange="pbEpcg=this.checked;updatePb()"> Import under EPCG (no duty)</label></div>' +
    '<div id="pbOut">' + pbOutHtml(pb) + '</div></section>';

  // learning
  const ls = a.learning || {};
  const learn = '<section class="card advcard"><div class="advhead"><div><span class="label">ZOBO learns from your decisions</span><h2 class="h2">Teach ZOBO</h2></div></div>' +
    '<p>' + (ls.decisions ? 'ZOBO\'s top pick was the one you chose in <b>' + ls.matched + ' of ' + ls.decisions + '</b> approved report' + (ls.decisions > 1 ? 's' : '') + '.' : 'After you press Proceed on a few reports, ZOBO shows how often its top pick matched your choice.') +
    (ls.suggested ? ' ZOBO suggests new weights (' + esc(ls.suggested.join(' / ')) + '); an admin can apply them from the sheet menu.' : '') + '</p>' +
    (canAct ? '<div class="fbrows">' + d.companies.map((c, i) => '<div class="fbrow"><b>' + esc(c.name) + '</b><input class="fld" id="fbr_' + i + '" placeholder="Why? (optional)" aria-label="Why, for ' + esc(c.name) + '">' +
      '<button class="btn icon" title="Good choice" aria-label="Good choice: ' + esc(c.name) + '" onclick="sendFb(' + i + ',\'up\')">👍</button>' +
      '<button class="btn icon" title="Not for us" aria-label="Not for us: ' + esc(c.name) + '" onclick="sendFb(' + i + ',\'down\')">👎</button></div>').join('') + '</div>' : '') + '</section>';
  return '<div class="advwrap">' + committee + importCard + visual + (isItem() ? '' : payback) + learn + '</div>';
}
function pbOutHtml(pb) {
  return '<dl class="facts-row"><div><dt>Yearly benefit</dt><dd><b>' + inrA(pb.benefit) + '</b></dd></div><div><dt>Extra pairs a year</dt><dd>' + Math.round(pb.extraPairs).toLocaleString('en-IN') + '</dd></div>' +
    '<div><dt>Waste saving</dt><dd>' + inrA(pb.wasteSave) + '</dd></div><div><dt>Energy</dt><dd>' + inrA(pb.energy) + '</dd></div><div><dt>Labour</dt><dd>' + inrA(pb.labour) + '</dd></div>' +
    '<div><dt>Good pairs per machine per shift</dt><dd>' + Math.round(pb.goodOld) + ' → ' + Math.round(pb.goodNew) + (pb.goodOld ? ' (' + (pb.goodNew >= pb.goodOld ? '+' : '') + Math.round((pb.goodNew / pb.goodOld - 1) * 100) + '%)' : '') + '</dd></div></dl>' +
    (pb.rows.length ? '<div class="cmpwrap" style="max-height:none;margin-top:10px"><table class="evt list adv"><thead><tr><th>Supplier</th><th>Investment</th><th>Payback</th></tr></thead><tbody>' +
      pb.rows.map(r => '<tr><td>' + esc(r.name) + '</td><td>' + inrA(r.invest) + '</td><td>' + (r.years == null ? '<span class="muted">' + (pb.benefit > 0 ? 'needs a price' : 'enter your numbers') + '</span>' :
        '<b>' + (r.years < 1 ? Math.round(r.years * 12) + ' months' : r.years.toFixed(1) + ' years') + '</b>') + '</td></tr>').join('') + '</tbody></table></div>'
    : '<p class="muted">' + esc(((advOf().landed || []).find(l => l.note) || {}).note || 'Landed costs appear when prices are known.') + '.</p>');
}
function updatePb() { const el = $('pbOut'); if (el) el.innerHTML = pbOutHtml(paybackCalc(pbInputs, (advOf().landed || []).filter(l => l.cif))); }
async function savePb() { try { await call('savePayback', dash.reqId, pbInputs); toast('Saved. Everyone opening this report sees these numbers.'); } catch (e) { /* toast shown */ } }
async function rerunDebate() { const b = $('debateBtn'); if (b) { b.disabled = true; b.textContent = 'The committee is debating… (about 30 seconds)'; } const id = dash.reqId; try { const a = await call('runDebate', id); if (dash && dash.reqId === id) dash.advanced = a; } catch (e) { /* toast */ } if (dash) renderDash(); }
async function rerunImport() { const b = $('importBtn'); if (b) { b.disabled = true; b.textContent = 'Checking duty and EPCG…'; } const id = dash.reqId; try { const a = await call('runImport', id); if (dash && dash.reqId === id) dash.advanced = a; } catch (e) { /* toast */ } if (dash) renderDash(); }
let fbBusy = false;
async function sendFb(i, verdict) {
  const c = dash.companies[i]; if (!c || fbBusy) return;
  const name = c.name, el = $('fbr_' + i), id = dash.reqId;
  fbBusy = true;
  try { const ls = await call('feedback', id, name, verdict, el ? el.value : ''); fbBusy = false; if (!dash || dash.reqId !== id) return; if (dash.advanced) dash.advanced.learning = ls; toast('Thanks. ZOBO will use this to rank suppliers the way you do.'); if (el) el.value = ''; renderDash(); } catch (e) { fbBusy = false; }
}

/* ---------- negotiation copilot (Quotations page) ---------- */
let nego = null;
async function openNego(rfq, make) {
  const box = $('negoPanel'); if (!box) return;
  box.innerHTML = '<div class="card advcard"><div class="xthinking"><span class="typing" style="padding:0!important"><i></i><i></i><i></i></span>' + (make ? 'ZOBO is benchmarking this quote and drafting a counter-offer… (about 20 seconds)' : 'Loading…') + '</div></div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { nego = make ? await call('negotiate', rfq) : await call('negotiation', rfq); } catch (e) { box.innerHTML = ''; return; }
  if (!nego && !make && ME && ME.can.start) return openNego(rfq, true);
  if (!nego) { box.innerHTML = '<div class="card advcard"><p class="muted">No advice yet. A buyer can ask ZOBO to prepare it.</p></div>'; return; }
  const canSend = ME && ME.can.start;
  box.innerHTML = '<section class="card advcard"><div class="advhead"><div><span class="label">Negotiation copilot · ' + esc(nego.rfq) + '</span><h2 class="h2">' + esc(nego.supplier) + '</h2></div>' +
    (canSend ? '<button class="btn" onclick="openNego(\'' + esc(nego.rfq) + '\', true)">Prepare again</button>' : '') + '</div>' +
    '<p>' + esc(nego.position) + '</p><p class="muted">' + esc(nego.benchmark) + '</p>' +
    '<dl class="facts-row"><div><dt>Target price</dt><dd><b>' + esc(nego.currency) + ' ' + esc(nego.target_price == null ? '—' : Number(nego.target_price).toLocaleString('en-IN')) + '</b></dd></div>' +
    '<div><dt>Walk away above</dt><dd>' + esc(nego.currency) + ' ' + esc(nego.walk_away_price == null ? '—' : Number(nego.walk_away_price).toLocaleString('en-IN')) + '</dd></div></dl>' +
    ((nego.levers || []).length ? '<div class="label" style="margin-top:8px">Ask for</div><ul class="conds">' + nego.levers.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    ((nego.risks || []).length ? '<div class="label">Confirm first</div><ul class="conds">' + nego.risks.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '<label class="label" for="negoBody" style="display:block;margin-top:10px">Counter-offer email (edit before sending)</label><textarea id="negoBody" class="fld" rows="10" style="width:100%;height:auto;padding:10px">' + esc(nego.email_en || '') + '</textarea>' +
    '<label class="label" for="negoZh" style="display:block;margin-top:8px">Chinese summary added below the email</label><textarea id="negoZh" class="fld" rows="3" style="width:100%;height:auto;padding:10px">' + esc(nego.email_zh_summary || '') + '</textarea>' +
    (canSend ? '<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap"><button class="btn primary" onclick="sendCounter()">Send counter-offer</button><span class="muted" style="align-self:center">Sent as a reply in the same email thread, with your CC.</span></div>' : '') + '</section>';
}
async function sendCounter() {
  if (!nego) return;
  if (!confirm('Send this counter-offer to ' + nego.supplier + ' now?')) return;
  try { await call('sendCounter', { rfq: nego.rfq, body: $('negoBody').value, zh: $('negoZh').value }); toast('Counter-offer sent.'); openQuotes(); } catch (e) { /* toast */ }
}


/* =====================================================================
   LIVE TALK: real-time voice with Gemini Live. Apps Script gives a short-lived pass; the browser talks to Google directly.
   You can interrupt ZOBO by speaking. Falls back to Conversation mode if Live is not available.
   ===================================================================== */
let live = null;
const liveWs = v => 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.' + v + '.GenerativeService.BidiGenerateContentConstrained?access_token=';
const MIC_WORKLET = 'class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("zobo-mic",P);';

function setLiveUi(state) {   // '' | 'connecting' | 'live'
  document.body.classList.toggle('live', state === 'live');
  document.querySelectorAll('.liveBtn').forEach(b => {
    b.classList.toggle('on', !!state); b.setAttribute('aria-pressed', state ? 'true' : 'false');
    const l = b.querySelector('.cl'); if (l) l.textContent = state === 'connecting' ? 'Connecting…' : state === 'live' ? 'Live · tap to end' : 'Live talk';
  });
  if ($('assist').classList.contains('on')) {
    if (state === 'live') hud('LIVE', 'Live talk', LANG === 'hi-IN' ? 'बोलिए, बीच में भी टोक सकते हैं' : 'Just talk. You can interrupt ZOBO any time.', true);
    else if (state === 'connecting') hud('THINKING', 'Connecting to live voice', '', true);
    else if (!running) hud('ONLINE', 'What do you need to buy?', SUB_LINE);
  }
}
let liveConnecting = 0;   // a Live talk being set up: a second click ends it instead of starting another one
async function toggleLive() {
  if (live) { stopLive(); return; }
  if (liveConnecting) { liveConnecting = 0; setLiveUi(''); return; }
  if (!window.WebSocket || !navigator.mediaDevices || !(window.AudioContext || window.webkitAudioContext)) { toast('Live talk needs Chrome or Microsoft Edge with a microphone. Conversation mode still works.'); return; }
  const mine = liveConnecting = Date.now(), sess = SESSION;
  const stillMine = () => liveConnecting === mine && sess === SESSION;
  stopSpeaking(); if (convo) toggleConvo();
  if (listening && rec) { cancelTurn = true; try { rec.abort(); } catch (e) { /* ignore */ } }
  setLiveUi('connecting');
  let pass;
  try { pass = await call('liveToken'); } catch (e) { if (stillMine()) { liveConnecting = 0; setLiveUi(''); } return; }
  if (!stillMine()) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { if (stillMine()) { liveConnecting = 0; setLiveUi(''); toast('The microphone is blocked. Click the lock icon next to the web address, allow the microphone and try again.'); } return; }
  if (!stillMine()) { stream.getTracks().forEach(t => t.stop()); return; }   // cancelled or signed out while the microphone opened
  liveConnecting = 0;
  const v = pass.version || 'v1beta', other = v === 'v1beta' ? 'v1alpha' : 'v1beta';
  // ways to connect, tried in order until one works: each live model, then the other API version
  const tries = pass.models.map(m => [v, m]).concat([[other, pass.models[0]]]);
  live = { stream, pass, tries, tryIdx: 0, sources: [], nextTime: 0, you: null, agent: null };
  connectLive();
}
function connectLive() {
  const L = live, [ver, model] = L.tries[L.tryIdx];
  const ws = new WebSocket(liveWs(ver) + encodeURIComponent(L.pass.token));
  L.ws = ws; L.ready = false;
  ws.onopen = () => ws.send(JSON.stringify({ setup: {
    model: 'models/' + model,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    systemInstruction: { parts: [{ text: L.pass.system + (LANG === 'hi-IN' ? ' The user prefers Hindi.' : '') }] },
    inputAudioTranscription: {}, outputAudioTranscription: {}
  } }));
  ws.onmessage = async ev => {
    let txt = ev.data;
    if (typeof txt !== 'string') { try { txt = await ev.data.text(); } catch (e) { return; } }
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (live === L) onLiveMsg(m);
  };
  ws.onclose = ev => {
    if (live !== L || L.ws !== ws) return;
    if (!L.ready && L.tryIdx + 1 < L.tries.length) { L.tryIdx++; connectLive(); return; }   // try the next way to connect
    if (!L.ready) toast('Live talk could not start (' + (ev.reason || 'Google closed the connection') + '). Conversation mode still works.');
    stopLive();
  };
}
function onLiveMsg(m) {
  if (m.setupComplete) { live.ready = true; startLiveMic(); setLiveUi('live'); return; }
  const sc = m.serverContent;
  if (!sc) { if (m.goAway) toast('Live talk is ending soon (Google session limit).'); return; }
  if (sc.interrupted) flushLive();
  if (sc.inputTranscription && sc.inputTranscription.text) liveText('you', sc.inputTranscription.text);
  if (sc.outputTranscription && sc.outputTranscription.text) liveText('agent', sc.outputTranscription.text);
  ((sc.modelTurn && sc.modelTurn.parts) || []).forEach(p => {
    if (p.inlineData && /audio\/pcm/i.test(p.inlineData.mimeType || '')) playLive(p.inlineData.data, Number((p.inlineData.mimeType.match(/rate=(\d+)/) || [])[1]) || 24000);
  });
  if (sc.turnComplete) {
    const said = live.lastYou && !live.lastYou.dataset.deepDone ? live.lastYou.textContent : '';
    if (live.lastYou) live.lastYou.dataset.deepDone = '1';
    const dc = said ? deepCommand(said) : null;
    if (dc && dc.mode !== 'once') deepApply(dc, true);
    live.you = null; live.agent = null;
  }
}
/** Live transcripts arrive in pieces: each piece is added to the current bubble. */
function liveText(who, t) {
  if (!$('msgs')) return;
  if (who === 'agent') live.you = null;
  let el = live[who];
  if (!el) { el = document.createElement('div'); el.className = 'msg ' + who; el.textContent = ''; $('msgs').appendChild(el); live[who] = el; if (who === 'you') live.lastYou = el; }
  el.textContent += t;
  $('msgs').scrollTop = 1e9;
}
async function startLiveMic() {
  const L = live;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    L.inCtx = ctx;
    const src = ctx.createMediaStreamSource(L.stream), mute = ctx.createGain();
    mute.gain.value = 0; mute.connect(ctx.destination);
    const ratio = ctx.sampleRate / 16000;
    let buf = [], len = 0;
    const onFrame = f => {
      if (live !== L || !L.ws || L.ws.readyState !== 1) return;
      buf.push(f); len += f.length;
      if (len < 1600 * ratio) return;
      const all = new Float32Array(len); let o = 0; buf.forEach(b => { all.set(b, o); o += b.length; }); buf = []; len = 0;
      const n = Math.floor(all.length / ratio), pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      let bin = ''; const bytes = new Uint8Array(pcm.buffer); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      L.ws.send(JSON.stringify({ realtimeInput: { audio: { data: btoa(bin), mimeType: 'audio/pcm;rate=16000' } } }));
    };
    try {   // modern audio thread; some setups refuse to load it, then the older method is used
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([MIC_WORKLET], { type: 'application/javascript' })));
      const node = new AudioWorkletNode(ctx, 'zobo-mic');
      node.port.onmessage = e => onFrame(e.data);
      src.connect(node); node.connect(mute);
    } catch (e) {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = ev => onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
      src.connect(sp); sp.connect(mute); L.sp = sp;
    }
    setVoiceState('listening');
  } catch (e) { console.error('live mic', e); toast('Live talk could not use the microphone here (' + (e && e.message || e) + ').'); stopLive(); }
}
function playLive(b64, rate) {
  const L = live;
  if (!L.outCtx) L.outCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = L.outCtx, bin = atob(b64), n = bin.length >> 1, buf = ctx.createBuffer(1, n, rate), ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; ch[i] = v / 0x8000; }
  const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination);
  const at = Math.max(ctx.currentTime + 0.02, L.nextTime); s.start(at); L.nextTime = at + buf.duration;
  L.sources.push(s); setVoiceState('speaking');
  s.onended = () => { L.sources = L.sources.filter(x => x !== s); if (!L.sources.length && live === L) setVoiceState('listening'); };
}
function flushLive() { if (!live) return; live.sources.forEach(s => { try { s.stop(); } catch (e) { /* ignore */ } }); live.sources = []; live.nextTime = 0; setVoiceState('listening'); }
function stopLive() {
  const L = live; live = null;
  if (L) {
    try { L.ws && L.ws.close(); } catch (e) { /* ignore */ }
    try { L.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    try { L.inCtx && L.inCtx.close(); } catch (e) { /* ignore */ }
    L.sources.forEach(s => { try { s.stop(); } catch (e) { /* ignore */ } });
    try { L.outCtx && L.outCtx.close(); } catch (e) { /* ignore */ }
  }
  setVoiceState(''); setLiveUi('');
}

/* ---------- sign-in ---------- */
let loginEmail = '';
function showLogin(msg) {
  show('login');
  $('loginStep1').style.display = 'flex'; $('loginStep2').style.display = 'none';
  $('loginMsg').textContent = msg || '';
  $('loginEmail').value = loginEmail || store.get('jarvis_email') || '';
  $('loginPending').style.display = 'none'; gLink = '';
  if (!gClient) setTimeout(() => $('loginEmail').focus(), 50);
  if (!showLogin.checked && CFG.apiUrl) { showLogin.checked = true; serverCheck().then(up => { if (up) setupGoogle(); }); }
  else if (gClient) armGoogle().catch(() => { /* the button stays; the next press asks again */ });
}

/* ---------- sign in with Google (Google Identity Services; the script checks the ID token itself) ---------- */
let gClient = '', gNonce = '', gReady = null, gBusy = false, gArmedAt = 0, gLink = '';
setInterval(() => { if (gClient && !gBusy && $('login').classList.contains('on') && Date.now() - gArmedAt > 600000) armGoogle().catch(() => { /* next time */ }); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && gClient && !gBusy && $('login').classList.contains('on') && Date.now() - gArmedAt > 600000) armGoogle().catch(() => { /* next time */ }); });
function loadGis() {
  return gReady || (gReady = new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = () => (window.google && google.accounts && google.accounts.id ? ok() : fail(new Error('no gsi')));
    sc.onerror = () => { gReady = null; fail(new Error('Google sign-in could not load')); };
    document.head.appendChild(sc);
  }));
}
/** Shows the Google button when the server has a client ID (ZOBO › Set up Google sign-in) and this page is not served by Apps Script. */
async function setupGoogle() {
  const id = CFG.googleClientId || (PING && PING.google) || '';
  if (GAS || !id) return;
  gClient = id;
  $('gWrap').style.display = 'flex';
  const mode = (PING && PING.googleMode) || 'approval';
  $('loginNote').textContent = mode === 'approval' ? 'Anyone with a Google account can sign in. A new person can use ZOBO once an admin approves them.' : 'Anyone with a Google account can sign in. New people start as ' + mode + '; an admin can change that.';
  try { await loadGis(); await armGoogle(); }
  catch (e) { $('gBtn').innerHTML = '<span class="muted" style="font-size:13px">Google sign-in could not load here (the network may block it). Use the emailed code below.</span>'; }
}
/** A fresh one-time nonce from the server for every press, then Google's own button. */
async function armGoogle() {
  if (!gClient || !window.google || !google.accounts || !google.accounts.id) return;
  const r = await api('googleNonce', [], true);
  gNonce = r.nonce; gArmedAt = Date.now();
  google.accounts.id.initialize({ client_id: gClient, nonce: gNonce, callback: onGoogle, auto_select: false, cancel_on_tap_outside: true, context: 'signin', ux_mode: 'popup', itp_support: true });
  const w = Math.round(Math.min(320, Math.max(220, $('gWrap').clientWidth || 300)));
  google.accounts.id.renderButton($('gBtn'), { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left', width: w });
}
async function onGoogle(resp) {
  if (gBusy || !resp || !resp.credential) return;
  gBusy = true;
  $('loginMsg').textContent = ''; $('loginPending').style.display = 'none';
  const line = $('serverLine'); if (line) { line.className = 'srvline'; line.textContent = 'Checking your Google sign-in…'; }
  try {
    const r = await api('googleSignIn', [], true, { credential: resp.credential, nonce: gNonce });
    if (line) line.textContent = '';
    if (r && r.pending) { $('loginPending').textContent = r.message; $('loginPending').style.display = 'block'; }
    else if (r && r.confirm) {   // a company address Google does not vouch for: one emailed code links the Google account
      loginEmail = r.email; store.set('jarvis_email', loginEmail); gLink = r.ticket || '';
      $('loginStep1').style.display = 'none'; $('loginStep2').style.display = 'flex';
      $('loginSentTo').textContent = loginEmail; $('loginCode').value = '';
      $('loginPending').textContent = r.message; $('loginPending').style.display = 'block';
      setTimeout(() => $('loginCode').focus(), 50);
    }
    else { TOKEN = r.token; store.set('jarvis_token', TOKEN); store.set('jarvis_email', r.user.email); loginEmail = r.user.email; gBusy = false; await startApp(); return; }
  } catch (e) { if (line) line.textContent = ''; $('loginMsg').textContent = e.message || 'Could not sign in with Google.'; }
  gBusy = false;
  armGoogle().catch(() => { /* the next press asks again */ });   // the nonce was used: get a new one
}
async function loginSend() {
  const email = $('loginEmail').value.trim();
  if (!email) { $('loginMsg').textContent = 'Type your work email.'; return; }
  const b = $('loginSendBtn'); b.disabled = true; b.textContent = 'Sending the code…'; $('loginMsg').textContent = '';
  try {
    await api('requestCode', [], true, { email });
    loginEmail = email.toLowerCase(); store.set('jarvis_email', loginEmail); gLink = '';
    $('loginStep1').style.display = 'none'; $('loginStep2').style.display = 'flex';
    $('loginSentTo').textContent = loginEmail; $('loginCode').value = '';
    setTimeout(() => $('loginCode').focus(), 50);
  } catch (e) { $('loginMsg').textContent = e.message || 'Could not send the code.'; }
  b.disabled = false; b.textContent = 'Send sign-in code';
}
async function loginVerify() {
  const code = $('loginCode').value.replace(/\D/g, '');
  if (code.length !== 6) { $('loginMsg').textContent = 'Type the 6-digit code from the email.'; return; }
  const b = $('loginVerifyBtn'); b.disabled = true; b.textContent = 'Signing in…'; $('loginMsg').textContent = '';
  try {
    const r = await api('verifyCode', [], true, Object.assign({ email: loginEmail, code }, gLink ? { link: gLink } : {}));
    gLink = '';
    TOKEN = r.token; store.set('jarvis_token', TOKEN);
    await startApp();
  } catch (e) { $('loginMsg').textContent = e.message || 'Could not sign in.'; }
  b.disabled = false; b.textContent = 'Sign in';
}
function signOut(msg) {
  TOKEN = ''; ME = null; store.del('jarvis_token');
  SESSION++;   // answers still on their way belong to the person who signed out
  liveConnecting = 0;
  running = false; clearInterval(polling); stopSpeaking(); setConvo(false); if (live) stopLive();
  if (listening && rec) { cancelTurn = true; try { rec.abort(); } catch (e) { /* ignore */ } }
  // nothing from the previous person stays on screen or in memory
  expertBusy = false; if ($('xsend')) $('xsend').disabled = false;
  booted = false; canApprove = false; dash = null; pending = null; lastReport = null; chatHist = []; dashQA = []; expertItems = []; keep = {};
  deepMode = false; MODE = 'chat'; clearAttach(); $('confirm').style.display = 'none'; SERVER_BUILD = ''; modeUi();
  paint.clear(); store.del('zobo_who'); dashShown = false; dashRaw = ''; NEWS = null; reportOffered = ''; clearInterval(warmTimer);
  Object.keys(photoCache).forEach(k => { delete photoCache[k]; });
  $('msgs').innerHTML = ''; $('xThread').innerHTML = ''; $('dash').innerHTML = ''; $('confirm').style.display = 'none'; $('openDashBtn').style.display = 'none';
  if ($('stopRunBtn')) $('stopRunBtn').style.display = 'none';
  $('counts').style.display = 'none'; $('steps').innerHTML = ''; $('headline').textContent = 'What do you need to buy?'; $('subline').textContent = 'Speak or type, in English or Hindi';
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
  if ($('peopleBody')) $('peopleBody').innerHTML = '';
  vHist = []; vxHist = []; CART = []; setCartN(0); ['mineBody', 'cartBody', 'vxMsgs'].forEach(k => { if ($(k)) $(k).innerHTML = ''; });
  document.body.classList.remove('viewer');
  showLogin(typeof msg === 'string' ? msg : 'You are signed out.');
}

/* ---------- reports list ---------- */
const STATUS_CLS = { 'Report ready': 'warn', Approved: 'ok', Closed: 'ok', Running: 'unk', Stopped: 'bad', Failed: 'bad', New: 'unk' };
async function openReports() {
  show('reports');
  if (!paint.get('reports')) $('reportsBody').innerHTML = '<div class="empty" style="padding:40px">Loading reports…</div>';
  const draw = list => {
    if (!$('reports').classList.contains('on')) return;
    if (!list || !list.length) { $('reportsBody').innerHTML = '<div class="empty" style="padding:40px">No reports yet. Start one from the Assistant.</div>'; return; }
    $('reportsBody').innerHTML = '<div class="cmpwrap" style="max-height:none"><table class="evt list"><thead><tr><th>Request</th><th>Item</th><th>Requested</th><th>Status</th><th>Companies</th><th>Best match</th><th></th></tr></thead><tbody>' +
      list.map(r => '<tr><td class="mono">' + esc(r.reqId) + '</td><td><b>' + esc(r.machine) + '</b>' + (r.capacity || r.budget ? '<div class="muted">' + esc([r.capacity, r.budget ? 'budget ₹' + (num(r.budget) != null ? num(r.budget).toLocaleString('en-IN') : r.budget) : ''].filter(Boolean).join(', ')) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.date) + '<div class="muted">' + esc(r.requestedBy) + '</div></td>' +
        '<td><span class="st ' + (STATUS_CLS[r.status] || 'unk') + '">' + esc(r.status || r.stage || '—') + '</span>' + (r.approvedBy ? '<div class="muted">by ' + esc(r.approvedBy) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.companies) + (r.rejected ? '<div class="muted">' + esc(r.rejected) + ' rejected</div>' : '') + '</td>' +
        '<td>' + (r.best ? esc(r.best.name) + '<div class="muted">' + esc(r.best.total) + '/100</div>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (r.companies ? '<button class="btn" style="height:36px" onclick="openDash(\'' + esc(r.reqId) + '\')">Open</button>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>';
  };
  try { await swr('reports', quiet => api('listReports', [], quiet), draw); }
  catch (e) { $('reportsBody').innerHTML = '<div class="empty" style="padding:40px">Could not load the reports.</div>'; }
}

/* ---------- quotations list ---------- */
async function openQuotes() {
  show('quotes');
  if (!paint.get('quotes')) $('quotesBody').innerHTML = '<div class="empty" style="padding:40px">Loading quotations…</div>';
  const draw = list => {
    if (!$('quotes').classList.contains('on')) return;
    const np = $('negoPanel'); if (np && np.innerHTML.trim()) return;   // a negotiation is open: leave it alone
    if (!list || !list.length) { $('quotesBody').innerHTML = '<div class="empty" style="padding:40px">No quotation requests sent yet. Open a report, press Proceed, then Request quotation.</div>'; return; }
    const cls = s => /quote received|revised quote/i.test(s) ? 'ok' : /replied|negotiating/i.test(s) ? 'ok' : /follow/i.test(s) ? 'warn' : 'unk';
    $('quotesBody').innerHTML = '<div class="cmpwrap" style="max-height:none"><table class="evt list"><thead><tr><th>RFQ</th><th>Supplier and model</th><th>Sent</th><th>Status</th><th>Price</th><th>Lead time</th><th>Terms</th><th></th></tr></thead><tbody>' +
      list.map(q => '<tr><td class="mono">' + esc(q.rfq) + '</td><td><b>' + esc(q.supplier) + '</b><div class="muted">' + esc(q.model) + (q.qty ? ' · qty ' + esc(q.qty) : '') + '</div></td>' +
        '<td>' + esc(q.sentAt) + '<div class="muted">' + esc(q.submittedBy) + '</div></td>' +
        '<td><span class="st ' + cls(q.status) + '">' + esc(q.status || '—') + '</span>' + (q.replyHours ? '<div class="muted">replied in ' + esc(q.replyHours) + ' h</div>' : '') + '</td>' +
        '<td>' + (q.price ? '<b>' + esc(q.currency) + ' ' + esc(q.price) + '</b><div class="muted">' + esc(q.incoterm) + '</div>' : '<span class="muted">waiting</span>') + '</td>' +
        '<td>' + (q.leadWeeks ? esc(q.leadWeeks) + ' weeks' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + esc([q.payment, q.validity ? 'valid ' + q.validity : ''].filter(Boolean).join(' · ')) + (q.notes && !/^PAYMENT WARNING/.test(q.notes) ? '<div class="muted">' + esc(q.notes) + '</div>' : '') +
          (/ALERT:/.test(q.safety || '') ? '<span class="paywarn" role="alert"><b>Payment warning.</b> ' + esc(String(q.safety).replace(/ALERT:\s*/g, '')) + ' Call the supplier on the number in its official registry record before paying.</span>' : q.safety ? '<div class="muted">' + esc(q.safety) + '</div>' : '') + '</td>' +
        '<td style="white-space:nowrap">' + (q.price ? '<button class="btn primary" style="height:36px" onclick="openNego(\'' + esc(q.rfq) + '\')">Negotiate</button> ' : '') + (q.reqId ? '<button class="btn" style="height:36px" onclick="openDash(\'' + esc(q.reqId) + '\')">Report</button>' : '') + '</td></tr>').join('') +
      '</tbody></table></div><p class="muted" style="font-size:12px;margin:10px 0 0">Supplier replies are checked every hour, including revised quotes later in the thread and PDF or photo attachments. Prices are copied into the report automatically, ZOBO prepares negotiation advice for each quote, and it checks every reply for payment-fraud signs (a changed bank account, a beneficiary that is not the registered company, a look-alike email address).</p><div id="negoPanel"></div>';
  };
  try { await swr('quotes', quiet => api('listQuotations', [], quiet), draw); }
  catch (e) { $('quotesBody').innerHTML = '<div class="empty" style="padding:40px">Could not load the quotations.</div>'; }
}

/* ---------- People (admins): who may use ZOBO, approvals and roles ---------- */
const ROLES = ['Viewer', 'Buyer', 'Approver', 'Admin'];
const ROLE_HELP = { Viewer: 'chat, web search, Expert, own results and cart, with the viewer AI (no company data)', Buyer: 'all of ZOBO: deep research, Advanced, reports, dashboard, Industry Expert, RFQs', Approver: 'also presses Proceed', Admin: 'also manages people' };
async function openPeople() {
  if (!ME || !ME.can || !ME.can.admin) { location.hash = '#/assistant'; return; }
  show('people');
  if (!$('peopleBody').innerHTML.trim()) $('peopleBody').innerHTML = '<div class="empty" style="padding:40px">Loading people…</div>';
  try { drawPeople(await api('listUsers', [], true)); }
  catch (e) { $('peopleBody').innerHTML = '<div class="empty" style="padding:40px">Could not load the people. ' + esc(e.message) + '</div>'; }
}
function drawPeople(d) {
  if (!$('people').classList.contains('on')) return;
  const users = (d && d.users) || [], me = (d && d.me) || '';
  const waiting = users.filter(u => !u.active && /^Waiting/i.test(u.note));
  const others = users.filter(u => waiting.indexOf(u) === -1);
  const sel = (u, cls) => '<select class="fld rolesel ' + (cls || '') + '" data-email="' + esc(u.email) + '" aria-label="Role for ' + esc(u.email) + '"' + (u.email === me ? ' disabled' : '') + '>' +
    ROLES.map(r => '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>';
  const who = u => '<b>' + esc(u.name || u.email.split('@')[0]) + '</b><div class="muted">' + esc(u.email) + (u.google ? ' · Google linked' : '') + '</div>';
  let h = '';
  if (waiting.length) {
    h += '<h2 class="pphead">Waiting for approval (' + waiting.length + ')</h2><div class="cmpwrap" style="max-height:none"><table class="evt list ppl"><thead><tr><th>Person</th><th>Asked</th><th>Role to give</th><th></th></tr></thead><tbody>' +
      waiting.map(u => '<tr><td>' + who(u) + '</td><td>' + esc(u.added) + '</td><td>' + sel(u, 'pending') + '</td><td style="white-space:nowrap"><button class="btn primary" style="height:36px" data-act="approve" data-email="' + esc(u.email) + '">Approve</button> <button class="btn" style="height:36px" data-act="refuse" data-email="' + esc(u.email) + '">Refuse</button></td></tr>').join('') +
      '</tbody></table></div><p class="muted pnote">Google has confirmed each person owns their email address, not who they are. Approve only people you know.</p>';
  }
  h += '<h2 class="pphead">Everyone</h2><div class="cmpwrap" style="max-height:none"><table class="evt list ppl"><thead><tr><th>Person</th><th>Role</th><th>Access</th><th>Last sign-in</th><th></th></tr></thead><tbody>' +
    (others.length ? others.map(u => '<tr><td>' + who(u) + (u.note ? '<div class="muted">' + esc(u.note) + '</div>' : '') + '</td><td>' + sel(u) + '</td>' +
      '<td><span class="st ' + (u.active ? 'ok' : 'unk') + '">' + (u.active ? 'Active' : 'Off') + '</span></td><td><span class="mlbl">Last sign-in: </span>' + esc(u.last || '—') + '</td>' +
      '<td style="white-space:nowrap">' + (u.email === me ? '<span class="muted">you</span>' : '<button class="btn" style="height:36px" data-act="' + (u.active ? 'off' : 'on') + '" data-email="' + esc(u.email) + '">' + (u.active ? 'Switch off' : 'Switch on') + '</button>') + '</td></tr>').join('')
      : '<tr><td colspan="5" class="muted">Nobody yet.</td></tr>') +
    '</tbody></table></div>' +
    '<h2 class="pphead">Add a person</h2><form class="addperson" onsubmit="event.preventDefault();addPerson()"><input id="apEmail" class="fld" type="email" placeholder="name@company.com" aria-label="Email" required>' +
    '<input id="apName" class="fld" placeholder="Name (optional)" aria-label="Name"><select id="apRole" class="fld" aria-label="Role">' + ROLES.map(r => '<option' + (r === 'Viewer' ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>' +
    '<button class="btn primary" id="apBtn" style="height:42px">Add</button></form>' +
    '<p class="muted pnote">Roles: ' + ROLES.map(r => '<b>' + r + '</b> ' + ROLE_HELP[r]).join(' · ') + '. Changes work at once, also for people already signed in. They get an email when you add or approve them. The same list is the Users tab of the sheet.</p>';
  $('peopleBody').innerHTML = h;
}
async function peopleSave(email, change, btn) {
  if (btn) btn.disabled = true;
  try { drawPeople(await api('setUser', [email, change])); toast('Saved.', true); }
  catch (e) { openPeople(); }
}
async function addPerson() {
  const email = $('apEmail').value.trim(), b = $('apBtn');
  if (!email) return;
  b.disabled = true;
  try { drawPeople(await api('addUser', [email, $('apName').value.trim(), $('apRole').value])); toast('Added ' + email + '. They got an email.'); }
  catch (e) { b.disabled = false; }
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('#peopleBody button[data-act]');
  if (!b) return;
  const email = b.dataset.email, act = b.dataset.act;
  if (act === 'approve') { const s = document.querySelector('#peopleBody select.pending[data-email="' + CSS.escape(email) + '"]'); peopleSave(email, { active: true, role: s ? s.value : 'Viewer' }, b); }
  else if (act === 'refuse') peopleSave(email, { active: false }, b);
  else if (act === 'on' || act === 'off') peopleSave(email, { active: act === 'on' }, b);
});
document.addEventListener('change', e => {
  const s = e.target;
  if (!s.matches || !s.matches('#peopleBody select.rolesel') || s.classList.contains('pending')) return;
  peopleSave(s.dataset.email, { role: s.value }, s);
});

/* ---------- viewers: their own AI, products to buy, My results, Expert and Cart ---------- */
const VIEWER_BUILD = '2026.10.17';
/** A Viewer sees only the viewer pages; an older server (no "full" flag) treats everyone as before. */
function isViewer() { return !!(ME && ME.can && ME.can.full === false); }
const viewerUiReady = () => !!SERVER_BUILD && SERVER_BUILD >= VIEWER_BUILD;
let vHist = [], vxHist = [], CART = [];
function setCartN(n) { const b = $('cartN'); if (!b) return; b.textContent = String(n); b.hidden = !n; }
function money(v, cur) {
  if (!(Number(v) > 0)) return '';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(v)); }
  catch (e) { return (cur ? cur + ' ' : '') + Number(v).toLocaleString('en-IN'); }
}
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
/** Product cards with Add to cart and Buy on the seller's site. resultId + index lets the server copy the product into the cart. */
function productCards(res) {
  return '<div class="pcards">' + (res.products || []).map((p, i) => {
    const url = safeUrl(p.url), img = safeUrl(p.image);
    return '<article class="pcard">' + (img ? '<div class="pimg"><img src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></div>' : '') +
      '<div class="pbody">' + (p.region ? '<span class="ptag' + (p.region === 'India' ? ' in' : '') + '">' + (p.region === 'India' ? 'India' : 'Global') + '</span>' : '') + '<b class="pname">' + esc(p.name) + '</b>' +
      '<div class="pprice">' + (p.price ? esc(money(p.price, p.currency)) + '<span class="muted"> ' + (p.priceFrom === 'page' ? 'on the seller\'s page' : 'as found; check on the site') + '</span>' : '<span class="muted">Price on the seller\'s site</span>') + '</div>' +
      '<div class="muted pseller">' + esc(p.seller || p.site) + (p.site && p.seller !== p.site ? ' · ' + esc(p.site) : '') + '</div>' + (p.why ? '<p class="pwhy">' + esc(p.why) + '</p>' : '') +
      '<div class="pact"><button type="button" class="btn" data-cart="' + esc(res.id) + '|' + i + '">Add to cart</button>' + (url ? '<a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Buy on ' + esc(p.site || 'the site') + '</a>' : '') + '</div></div></article>';
  }).join('') + '</div>';
}
document.addEventListener('click', async e => {
  const b = e.target.closest && e.target.closest('[data-cart]');
  if (!b) return;
  const [rid, idx] = b.dataset.cart.split('|');
  b.disabled = true;
  try { CART = await api('cartAdd', [rid, Number(idx)]); setCartN(CART.length); b.textContent = 'In your cart ✓'; toast('Added to your cart.', true); }
  catch (err) { b.disabled = false; }
});
async function viewerSend(t, files, byVoice) {
  const sess = SESSION;
  voiceInput = !!byVoice;
  if (t && !files.length && isIdentity(t)) { say('I am ZOBO, an AI assistant. How can I help you today?'); return; }
  showTyping(files.length ? 'Reading the file' + (files.length > 1 ? 's' : '') : 'Thinking');
  hud('THINKING', 'Thinking', files.length ? 'Reading the files' : '', true);
  let r;
  try { r = await api('vAsk', [t, files.map(f => f.payload), vHist.slice(-10), {}], true); }
  catch (e) { if (sess === SESSION) { hideTyping(); idleHud(); say(String((e && e.message) || 'Sorry, I could not get an answer just now. Please ask again.')); } return; }
  if (sess !== SESSION) return;
  vHist.push({ role: 'user', text: t || 'Files: ' + files.map(f => f.name).join(', ') }, { role: 'jarvis', text: r.answer });
  if (vHist.length > 20) vHist = vHist.slice(-20);
  if (r.type === 'products') {
    say(r.answer + '\nThese are kept in My results.', 'agent');
    const d = document.createElement('div'); d.className = 'msg agent prodmsg'; d.innerHTML = productCards(r);
    $('msgs').appendChild(d); $('msgs').scrollTop = 1e9;
  } else say(r.answer, 'agent', r.sources);
  idleHud();
}
async function vxSend() {
  const q = $('vxCmd').value.trim(); if (!q) return;
  const sess = SESSION, box = $('vxMsgs');
  $('vxCmd').value = '';
  box.appendChild(msgEl(q, 'you'));
  const wait = msgEl('The expert is researching this…', 'agent'); wait.classList.add('waiting'); box.appendChild(wait);
  wait.scrollIntoView({ block: 'end' });
  let r;
  try { r = await api('vAsk', [q, [], vxHist.slice(-10), { persona: 'expert' }], true); }
  catch (e) { if (sess === SESSION) { wait.textContent = String((e && e.message) || 'Sorry, no answer just now. Please ask again.'); wait.classList.remove('waiting'); } return; }
  if (sess !== SESSION) return;
  vxHist.push({ role: 'user', text: q }, { role: 'jarvis', text: r.answer });
  if (vxHist.length > 20) vxHist = vxHist.slice(-20);
  box.replaceChild(msgEl(r.answer, 'agent', r.sources), wait);
  box.lastChild.scrollIntoView({ block: 'start' });
}
const KIND_NAME = { products: 'Products', answer: 'Answer', expert: 'Expert' };
async function openMine() {
  show('mine'); $('mineBack').style.display = 'none'; $('mineTitle').textContent = 'My results'; $('mineSub').textContent = 'Everything you searched, newest first. Only you can see these.';
  $('mineBody').innerHTML = '<div class="empty" style="padding:40px">Loading…</div>';
  let list;
  try { list = await api('vResults', [], true); } catch (e) { $('mineBody').innerHTML = '<div class="empty" style="padding:40px">Could not load your results.</div>'; return; }
  if (!$('mine').classList.contains('on')) return;
  $('mineBody').innerHTML = !list.length ? '<div class="empty" style="padding:40px">Nothing yet. Ask ZOBO a question or tell it what you want to buy.</div>' :
    '<div class="minelist">' + list.map(x => '<a class="mineitem" href="#/mine/' + encodeURIComponent(x.id) + '"><span class="st ' + (x.kind === 'products' ? 'ok' : 'unk') + '">' + esc(KIND_NAME[x.kind] || x.kind) + '</span><b>' + esc(x.question) + '</b><span class="muted">' + esc(x.date) + (x.products ? ' · ' + x.products + ' product' + (x.products > 1 ? 's' : '') : '') + '</span></a>').join('') + '</div>';
}
async function openMineItem(id) {
  show('mine'); $('mineBack').style.display = '';
  $('mineBody').innerHTML = '<div class="empty" style="padding:40px">Loading…</div>';
  let r;
  try { r = await api('vResult', [id], true); } catch (e) { $('mineBody').innerHTML = '<div class="empty" style="padding:40px">This result was not found.</div>'; return; }
  if (!$('mine').classList.contains('on')) return;
  $('mineTitle').textContent = r.question; $('mineSub').textContent = (KIND_NAME[r.kind] || '') + ' · ' + r.date;
  const ans = msgEl(r.answer, 'agent', r.kind === 'products' ? null : r.sources); ans.classList.add('wide');
  $('mineBody').innerHTML = '';
  $('mineBody').appendChild(ans);
  if (r.products && r.products.length) { const d = document.createElement('div'); d.innerHTML = productCards(r); $('mineBody').appendChild(d.firstChild); }
}
async function openCart() {
  show('cart');
  if (!$('cartBody').innerHTML.trim()) $('cartBody').innerHTML = '<div class="empty" style="padding:40px">Loading…</div>';
  try { CART = await api('cart', [], true); } catch (e) { $('cartBody').innerHTML = '<div class="empty" style="padding:40px">Could not load your cart.</div>'; return; }
  drawCart();
}
function drawCart(focus) {
  setCartN(CART.length);
  if (!$('cart').classList.contains('on')) return;
  if (!CART.length) { $('cartBody').innerHTML = '<div class="empty" style="padding:40px">Your cart is empty. Search for a product in the Assistant and press Add to cart.</div>'; return; }
  const totals = {};
  CART.forEach(c => { if (c.price) totals[c.currency || 'INR'] = (totals[c.currency || 'INR'] || 0) + c.price * c.qty; });
  $('cartBody').innerHTML = '<div class="cartlist">' + CART.map(c => {
    const url = safeUrl(c.url), img = safeUrl(c.image);
    return '<article class="citem">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '<span class="noimg" aria-hidden="true"></span>') +
      '<div class="cinfo"><b>' + esc(c.name) + '</b><span class="muted">' + esc(c.seller) + '</span><span>' + (c.price ? esc(money(c.price, c.currency)) + ' each' : '<span class="muted">Price on the seller\'s site</span>') + '</span></div>' +
      '<div class="cqty" role="group" aria-label="Quantity of ' + esc(c.name) + '"><button type="button" class="btn icon" aria-label="One less" data-qty="' + esc(c.id) + '|' + (c.qty - 1) + '">−</button><span>' + c.qty + '</span><button type="button" class="btn icon" aria-label="One more" data-qty="' + esc(c.id) + '|' + (c.qty + 1) + '">+</button></div>' +
      '<div class="cact"><button type="button" class="btn" aria-label="Remove" data-qty="' + esc(c.id) + '|0">Remove</button>' + (url ? '<a class="btn primary" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Buy on site</a>' : '') + '</div></article>';
  }).join('') + '</div>' +
    (Object.keys(totals).length ? '<p class="ctotal">Estimated total: <b>' + Object.keys(totals).map(k => esc(money(totals[k], k))).join(' + ') + '</b> <span class="muted">(prices as found; the seller\'s site has the final price, delivery and taxes)</span></p>' : '');
  if (focus) {   // keyboard and screen-reader users stay where they were
    const it = CART.find(c => c.id === focus.id);
    const btn = it && [...$('cartBody').querySelectorAll('[data-qty^="' + CSS.escape(focus.id) + '|"]')].find(b => b.getAttribute('aria-label') === focus.label);
    if (btn) btn.focus(); else { const any = $('cartBody').querySelector('button, a'); if (any) any.focus(); }
    const live = $('cartLive'); if (live) live.textContent = it ? 'Quantity ' + it.qty + ' for ' + it.name : 'Removed from the cart.';
  }
}
document.addEventListener('click', async e => {
  const b = e.target.closest && e.target.closest('#cartBody [data-qty]');
  if (!b) return;
  const [id, q] = b.dataset.qty.split('|');
  const label = b.getAttribute('aria-label') || b.textContent;
  b.disabled = true;
  try { CART = await api('cartSet', [id, Math.max(0, Number(q))]); drawCart({ id, label }); } catch (err) { b.disabled = false; }
});
async function cartEmpty() {
  if (!CART.length || !confirm('Remove everything from your cart?')) return;
  try { CART = await api('cartClear', []); drawCart(); } catch (e) { /* toast shown */ }
}

/* ---------- page addresses ---------- */
function route() {
  if (!TOKEN || !ME) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0], id = decodeURIComponent(parts[1] || '');
  if (isViewer()) {   // viewers: Assistant, My results, Expert and Cart only
    if (page === 'mine') return id ? openMineItem(id) : openMine();
    if (page === 'vexpert') { show('vexpert'); setTimeout(() => { const c = $('vxCmd'); if (c) c.focus(); }, 50); return; }
    if (page === 'cart') return openCart();
    show('assist'); setTimeout(() => { const c = $('cmd'); if (c) c.focus(); }, 50);
    return;
  }
  if (page === 'report') return loadDash(id || null);
  if (page === 'reports') return openReports();
  if (page === 'expert') return openExpertView();
  if (page === 'quotes') return openQuotes();
  if (page === 'people' && ME.can && ME.can.admin) return openPeople();
  show('assist');
  setTimeout(() => { const c = $('cmd'); if (c) c.focus(); }, 50);
}
window.addEventListener('hashchange', route);

/* ---------- start ---------- */
let booted = false, routedEarly = false, warnedOld = false, warmTimer = null;
function showMe(me) {
  ME = me;
  $('meName').textContent = ME.name; $('meRole').textContent = ME.role; $('meEmail').textContent = ME.email;
  $('brandCo').textContent = ME.company || 'Zonac Knitting Production';
  canApprove = !!(ME.can && ME.can.approve);
  $('navPeople').style.display = ME.can && ME.can.admin ? '' : 'none';
  document.body.classList.toggle('viewer', isViewer());
}
/** One round trip for who is signed in and what to say first. An older script has no "boot" action, so it is asked in two. */
async function bootCall() {
  try { return await api('boot', [], true); }
  catch (e) {
    if (!TOKEN || (e && e.diag)) throw e;
    const me = await api('me');
    const boot = await call('getBoot');
    if (!warnedOld) { warnedOld = true; toast('The server script is older than this app. Paste the newest script files and deploy a New version to get the speed-ups.'); }
    return { me, boot };
  }
}
/** While the page is open and quiet, a tiny request every few minutes keeps Google's script instance awake, so the next click is not a cold start. */
function warmNow() {
  if (GAS || !CFG.apiUrl || !TOKEN || document.hidden || Date.now() - lastApiAt < 200000) return;
  lastApiAt = Date.now();
  fetch(CFG.apiUrl, { method: 'POST', redirect: 'follow', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: '{"action":"ping"}' }).catch(() => { /* only a warm-up */ });
}
function keepWarm() { clearInterval(warmTimer); warmTimer = setInterval(warmNow, 60000); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) warmNow(); });

async function startApp() {
  // A returning person sees the page at once from what this browser remembers; the server's answer replaces it a moment later.
  let remembered = null;
  if (!booted && !ME) { const c = paint.get('me'); if (c && c.v && c.v.email) remembered = c.v; }
  if (remembered) { showMe(remembered); loadMode(); renderSteps(''); routedEarly = true; route(); }
  let b;
  try { b = await bootCall(); }
  catch (e) { if (remembered && TOKEN) { routedEarly = false; toast('Could not reach the server. Showing what was saved on this computer.'); return; } throw e; }
  const prevMe = paint.get('me'), prevCan = prevMe && prevMe.v ? JSON.stringify(prevMe.v.can) + prevMe.v.role : '';
  if (store.get('zobo_who') !== b.me.email || (prevCan && prevCan !== JSON.stringify(b.me.can) + b.me.role)) { paint.clear(); store.set('zobo_who', b.me.email); }   // another person, or a changed role: nothing remembered is kept
  SERVER_BUILD = String(b.build || '');
  loadMode();   // deep research mode is remembered per person on this computer
  const changed = remembered && (remembered.email !== b.me.email || remembered.role !== b.me.role || JSON.stringify(remembered.can) !== JSON.stringify(b.me.can));
  showMe(b.me); paint.set('me', b.me);
  if (changed) { dash = null; dashShown = false; routedEarly = false; }   // the remembered page belonged to a different role: draw it again
  const bt = b.boot || {};
  if (!booted && bt.viewer) {
    booted = true;
    setCartN(bt.cart || 0);
    say('Hello ' + ME.name + '. I am ZOBO, an AI assistant.\nAsk me anything, or tell me what you want to buy: I search the web and show products you can add to your cart and buy on the seller\'s own site. Every search is kept in My results, and the Expert page answers in depth.' +
      (bt.ready ? '' : '\n(The AI for viewers is not set up yet. Please ask the admin.)'));
    idleHud();
  }
  if (!booted) {
    booted = true;
    renderSteps('');
    if (bt.run && bt.run.stage !== 'Done' && bt.run.stage !== 'Error') {
      running = true; $('steps').style.display = ''; say('Welcome back, ' + ME.name + '. I am ZOBO, and I am still working on ' + bt.run.machine + (bt.run.deep ? ' in deep research mode' : '') + '.'); poll();
    } else {
      lastReport = bt.lastReport;
      say('Hello ' + ME.name + '. ' + IDENTITY_LINE + (modesReady() ? '' : '\nTell me anything you need to buy (a machine, spare parts, yarn, packaging or any product) and I will find and vet the best Chinese manufacturers, or ask me anything about machines, the socks industry or textile technology.') +
        (bt.radar && bt.radar.serious ? '\nSupplier radar (' + bt.radar.date + '): ' + bt.radar.serious + ' warning' + (bt.radar.serious > 1 ? 's' : '') + ' about watched suppliers. See the Suppliers tab.' : '') +
        (bt.lastReport ? '\nYou can also ask about the last report (' + bt.lastReport + '): which company should we choose, what are the risks, or a summary for the boss.' : '') +
        (bt.news && bt.news.count ? '\nThis morning\'s news brief has ' + bt.news.count + ' stories. Ask me "what is today\'s news?", or open Industry Expert.' : '') +
        (modesReady() ? '\nChoose a mode with the buttons above the box: Chat answers anything, Deep research researches any product, machine or topic with sources, and Advanced finds the top five, compares them and gives a final pick (attach a photo or file and tell me what to do). You are in ' + (MODE === 'chat' ? 'Chat' : MODE === 'deep' ? 'Deep research' : 'Advanced') + ' mode.'
          : deepMode ? '\nDeep research mode is on: questions and supplier searches go deeper and take a little longer. Say "deep research off" to switch it off.' : '\nFor a deeper, researched answer, press Deep research or say "deep research mode".'));
      if (bt.lastReport) { $('openDashBtn').style.display = 'inline-block'; $('subline').textContent = 'Name anything to buy, or ask about the last report'; }
    }
    if (bt.lastReport) setTimeout(() => prefetchDash(bt.lastReport), 600);   // the report is ready to open before anyone clicks
  }
  if (!routedEarly) route();
  routedEarly = false;
  keepWarm();
}
/** A computer that moved to a slower route (for example after a short Wi-Fi drop) tries the normal route again once per visit. */
async function probePost() {
  if (GAS || TX === 'post') return;
  try {
    const r = await Promise.race([viaPost(JSON.stringify({ action: 'ping', args: [] })), sleep(8000).then(() => null)]);   // never holds the page up
    if (r && r.raw && isJson(r.raw)) setTx('post');
  } catch (e) { /* keep the route that works */ }
}
async function init() {
  if (!GAS && (!CFG.apiUrl || /PASTE/i.test(CFG.apiUrl))) { show('setup'); return; }
  probePost();   // in the background
  if (!TOKEN) { showLogin(); return; }
  try { await startApp(); } catch (e) { if (e && e.diag) showLogin('Cannot connect: ' + e.diag.title + '.'); else if (TOKEN) showLogin('Please sign in.'); }
}
init();
