/* ZOBO web app — machinery sourcing and industry expert. Talks to the ZOBO API (Google Apps Script). */
'use strict';

const STEPS = [['Keywords', 'Keywords'], ['Searching', 'Search Baidu and B2B'], ['Identifying', 'Identify companies'], ['Vetting', 'Vet: gates, evidence, score'], ['Writing report', 'Write report']];
let pending = null, polling = null, running = false, dash = null, keep = {}, current = null, draft = null, canApprove = false;
let lastReport = null, chatHist = [];

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
async function api(action, args, quiet, extra) {
  let res, j;
  const body = JSON.stringify(Object.assign({ action, args: args || [], token: TOKEN }, extra || {}));
  if (GAS) {
    let text;
    try { text = await new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).zoboApi(body)); }
    catch (e) { if (!quiet) toast('Cannot reach the ZOBO server. Reload the page and try again.'); throw e; }
    try { j = JSON.parse(text); }
    catch (e) { if (!quiet) toast('The server sent an unexpected reply. If the script was just changed, deploy a new version.'); throw e; }
  } else {
    try {
      res = await fetch(CFG.apiUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
    } catch (e) { if (!quiet) toast('Cannot reach the ZOBO server. Check the internet connection and try again.'); throw e; }
    try { j = await res.json(); }
    catch (e) { if (!quiet) toast('The server sent an unexpected reply. If the script was just changed, deploy a new version.'); throw e; }
  }
  if (j.auth === false) { signOut('Your session has ended. Please sign in again.'); throw new Error(j.error); }
  if (!j.ok) { if (!quiet) toast(j.error); throw new Error(j.error); }
  return j.data;
}
function call(fn, ...args) { return api(fn, args); }
function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 7000); }
const VIEWS = ['login', 'setup', 'assist', 'reports', 'dash', 'form', 'email', 'done', 'expert', 'quotes'];
const NAV_OF = { assist: 'assist', reports: 'reports', dash: 'dash', form: 'dash', email: 'dash', done: 'dash', expert: 'expert', quotes: 'quotes' };
function show(v) {
  VIEWS.forEach(x => { const el = $(x); if (el) el.classList.toggle('on', x === v); });
  document.body.classList.toggle('authed', v !== 'login' && v !== 'setup');
  document.querySelectorAll('[data-nav]').forEach(b => { const on = b.dataset.nav === NAV_OF[v]; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const titles = { assist: 'Assistant', reports: 'Reports', dash: 'Report', form: 'Request a quotation', email: 'Quotation email', done: 'Sent', expert: 'Industry Expert', quotes: 'Quotations' };
  document.title = (titles[v] ? titles[v] + ' · ' : '') + 'ZOBO';
}

/* ---------- conversation ---------- */
function say(text, from) {
  if ((from || 'agent') === 'agent') hideTyping();
  const d = document.createElement('div'); d.className = 'msg ' + (from || 'agent'); d.textContent = text;
  $('msgs').appendChild(d); $('msgs').scrollTop = 1e9;
  if ((from || 'agent') === 'agent') speak(text);
}
/* ZOBO speaks when "Read replies aloud" is on, or when the person just used the microphone. */
let voiceInput = false;
function setVoiceState(state) {   // state: 'speaking' | 'listening' | ''
  document.body.classList.toggle('speaking', state === 'speaking');
  document.body.classList.toggle('listening', state === 'listening');
  const pip = $('voicePip');
  const lab = $('orbLabel');
  if (lab) { if (state) { if (!lab.dataset.prev) lab.dataset.prev = lab.textContent; lab.textContent = state === 'speaking' ? 'SPEAKING' : 'LISTENING'; } else if (lab.dataset.prev) { lab.textContent = lab.dataset.prev; delete lab.dataset.prev; } }
  if (pip) { pip.hidden = !state || $('assist').classList.contains('on'); $('pipText').textContent = state === 'speaking' ? 'ZOBO is speaking' : state === 'listening' ? 'Listening…' : ''; }
}
function stopSpeaking() { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } setVoiceState(''); }
function speak(text, force) {
  if (!window.speechSynthesis) return;
  if (!force && !$('speakOn').checked && !voiceInput) return;
  speechSynthesis.cancel();
  let t2 = text.replace(/\n/g, '. ');
  if (t2.length > 600) t2 = t2.slice(0, 600).replace(/[^.]*$/, '') + ' The full answer is on screen.';
  const u = new SpeechSynthesisUtterance(t2);
  const v = speechSynthesis.getVoices().find(v => /en-IN/i.test(v.lang)) || speechSynthesis.getVoices().find(v => /^en/i.test(v.lang));
  if (v) u.voice = v;
  u.onstart = () => setVoiceState('speaking');
  u.onend = u.onerror = () => setVoiceState('');
  try { speechSynthesis.speak(u); } catch (e) { setVoiceState(''); }   // a browser without a voice must never break the app
}
const IDENTITY_RE = /\b(who\s+are\s+(you|u)|what\s+are\s+you|what('|\s+i)?s\s+your\s+name|your\s+name|introduce\s+yourself|who\s+is\s+zobo|what\s+is\s+zobo|tell\s+me\s+about\s+yourself|(aap|tum)\s+kaun)\b/i;
const IDENTITY_LINE = 'I am ZOBO, the AI agent for Zonac Knitting Production, an India-based company in Greater Noida. How can I help you today?';
function hud(label, head, sub, live) {
  if (label !== 'THINKING') hideTyping();
  $('orbLabel').textContent = label; $('headline').textContent = head; $('subline').textContent = sub;
  $('orb').className = 'orb' + (live ? ' live' : '') + (running ? ' run' : '');
}
async function sendText(byVoice) {
  const t = $('cmd').value.trim(); if (!t) return;
  voiceInput = !!byVoice;
  $('cmd').value = ''; say(t, 'you');
  if (IDENTITY_RE.test(t)) { say(IDENTITY_LINE); hud('ONLINE', 'How can I help you today?', 'Speak or type in English'); return; }
  if (!running && !(pending && /^(yes|yes go|go|start|ok|okay|proceed)\b/i.test(t))) showTyping();
  if (running) { const s = await call('getStatus'); say(s ? s.message : 'Working on it.'); return; }
  if (pending && /^(yes|yes go|go|start|ok|okay|proceed)\b/i.test(t)) return go();
  // With a report available (and no request waiting for a yes), ZOBO first checks whether this is a question about it.
  if (!pending) {
    hud('THINKING', 'Thinking', '', true);
    let a;
    try { a = await call('askJarvis', t, (dash && dash.reqId) || lastReport, chatHist); } catch (e) { hud('ONLINE', 'Ask me anything', 'about the report, or name a new machine'); return; }
    if (a.type === 'industry') {
      hud('THINKING', 'Researching', 'Checking the latest industry sources', true);
      let x;
      try { x = await call('askExpert', t, chatHist); } catch (e) { hud('ONLINE', 'Ask me anything', ''); return; }
      chatHist.push({ role: 'user', text: t }, { role: 'jarvis', text: x.answer });
      say(x.answer + (x.sources.length ? '\n\nSources: ' + x.sources.map((s, i) => (i + 1) + ') ' + s.title + ' (' + s.site + ')').join('; ') + '. Full links in the Industry Expert tab.' : ''));
      expertItems.push({ q: t, x });
      hud('ONLINE', 'Ask me anything', 'machines, the industry, or the report');
      return;
    }
    if (a.type === 'answer') {
      chatHist.push({ role: 'user', text: t }, { role: 'jarvis', text: a.answer });
      say(a.answer);
      hud('ONLINE', 'Ask me anything', 'about the report, or name a new machine');
      return;
    }
  }
  if (ME && !ME.can.start) { say('Your role is ' + ME.role + ': you can ask me anything, but only buyers can start a new supplier search. Ask your admin if you need that.'); hud('ONLINE', 'Ask me anything', ''); return; }
  hud('THINKING', 'Reading your request', '', true);
  try {
    const r = await call('interpretRequest', t);
    if (!r.machine) { pending = null; say('I did not catch a machine name. Which machine do you need?'); hud('ONLINE', 'What machine do you need?', 'Speak or type in English'); return; }
    pending = r;
    let m = r.readback || ('I heard: ' + r.machine);
    if (r.key_specs_missing && r.key_specs_missing.length) m += '\n' + (r.question || ('To pick the right model I need: ' + r.key_specs_missing.join(', ') + '.')) + ' Tell me the full request again with these, or say yes to start anyway.';
    else if (r.missing && r.missing.length) m += '\nIt would help to know: ' + r.missing.join(', ') + '. Tell me, or say yes to start anyway.';
    else m += '\nShall I start?';
    say(m);
    $('confirm').style.display = 'flex';
    hud('ONLINE', 'Shall I start?', r.machine);
  } catch (e) { hud('ONLINE', 'What machine do you need?', 'Speak or type in English'); }
}
function changeReq() { $('confirm').style.display = 'none'; say('Sure. Tell me the full request again with the change.'); }
async function go() {
  if (!pending) return;
  $('confirm').style.display = 'none'; say('Yes, go', 'you');
  running = true; hud('WORKING', 'Sourcing in progress', 'Starting', true); renderSteps('Keywords');
  say('Starting now. I will search Baidu in Chinese, check every company in the official records, and score the survivors. This takes a while; you can close this page and come back.');
  const f = pending; pending = null;
  try { await call('startSourcing', f); } catch (e) { running = false; hud('ONLINE', 'What machine do you need?', ''); return; }
  poll();
}
function renderSteps(stage) {
  const idx = stage === 'Done' ? 99 : STEPS.findIndex(s => s[0] === stage);
  $('steps').innerHTML = STEPS.map((s, i) => '<li class="' + (i < idx ? 'done' : i === idx ? 'now' : '') + '"><span class="mono" style="font-size:12px;margin-right:6px">0' + (i + 1) + '</span>' + esc(s[1]) + '</li>').join('');
}
function render(s) {
  if (!s) return;
  $('counts').style.display = 'flex'; $('cFound').textContent = s.found; $('cRej').textContent = s.rejected; $('cScored').textContent = s.scored;
  renderSteps(s.stage);
  if (s.stage === 'Done') {
    if (!running) return;
    clearInterval(polling); running = false;
    hud('READY', 'Shortlist ready for review', s.message, false);
    $('openDashBtn').style.display = 'inline-block';
    lastReport = s.reqId; chatHist = [];
    say(s.message + ' Open the dashboard, or ask me anything about the results: for example, which company should we choose and why.');
  } else if (s.stage === 'Error') {
    if (!running) return;
    clearInterval(polling); running = false;
    hud('ONLINE', 'The run stopped', s.message, false);
    say('The run stopped: ' + s.message);
  } else {
    hud('WORKING', 'Sourcing in progress', s.message, true);
  }
}
/* While the page is open it drives the work itself (pump), so nothing waits for the 1-minute timer. */
let pumping = false;
async function pumpLoop() {
  if (pumping) return;
  pumping = true;
  while (running) {
    try { render(await call('pump')); } catch (e) { /* the timer carries on */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  pumping = false;
}
function poll() {
  clearInterval(polling);
  const tick = async () => { let s; try { s = await call('getStatus'); } catch (e) { return; } render(s); };
  tick(); polling = setInterval(tick, 5000);
  pumpLoop();
}

/* ---------- voice input ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
let micTarget = 'cmd';
function toggleMic(target) {
  if (!SR) { toast('Voice input is not available in this browser. Use Chrome or Edge, or press Windows key + H to dictate into the box.'); return; }
  if (listening) { rec.stop(); return; }
  micTarget = target || 'cmd';
  const micBtn = $(micTarget === 'cmd' ? 'mic' : 'xmic');
  rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = false;
  rec.onstart = () => { stopSpeaking(); listening = true; setVoiceState('listening'); micBtn.classList.add('listening'); micBtn.setAttribute('aria-label', 'Stop listening'); if (micTarget === 'cmd') hud('LISTENING', 'Listening', 'Speak now', true); };
  rec.onresult = e => { $(micTarget).value = Array.from(e.results).map(r => r[0].transcript).join(' '); };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
      toast('The microphone is blocked on this page. Press Windows key + H to dictate into the box, or type.');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Voice error: ' + e.error);
  };
  rec.onend = () => {
    listening = false; micBtn.classList.remove('listening'); micBtn.setAttribute('aria-label', 'Speak');
    setVoiceState('');
    if (micTarget !== 'cmd') { if ($(micTarget).value.trim()) expertSend(undefined, true); return; }
    if (!running) hud('ONLINE', pending ? 'Shall I start?' : 'What machine do you need?', 'Speak or type in English');
    if ($('cmd').value.trim()) sendText(true);
  };
  rec.start();
}

/* ---------- industry expert ---------- */
let expertItems = [], expertBusy = false;
const EXPERT_IDEAS = [
  ['Socks industry', ['What are the latest technologies in sock manufacturing?', 'How can our sock factory upgrade to Industry 4.0?', 'Sock industry news this month in India and the world']],
  ['Machines', ['Italian vs Chinese sock knitting machines: which should we buy?', 'Automatic toe closing and linking machines: options and payback', 'What is new in Chinese textile machinery this year?']],
  ['Yarn and materials', ['Latest trends in sock yarns: recycled, bamboo, functional', 'What is happening to cotton and nylon yarn prices?']],
  ['Business', ['Government schemes in India for textile machinery upgrades', 'How do Chinese sock clusters like Zhuji Datang stay so competitive?']]
];
function openExpert() { location.hash = '#/expert'; }
function openExpertView() {
  show('expert');
  if (!$('xIdeas').innerHTML) $('xIdeas').innerHTML = EXPERT_IDEAS.map(g => '<div class="xgrp"><span class="label">' + esc(g[0]) + '</span><div class="ideas">' +
    g[1].map(q => '<button class="chipbtn" onclick="expertSend(this.textContent)">' + esc(q) + '</button>').join('') + '</div></div>').join('');
  renderExpert();
  setTimeout(() => $('xq').focus(), 50);
}
function renderExpert() {
  $('xThread').innerHTML = expertItems.map(it => '<article class="card xitem"><div class="q">' + esc(it.q) + '</div>' +
    (it.x == null ? '<div class="xthinking"><span class="typing" style="padding:0!important"><i></i><i></i><i></i></span>' + esc(it.status || 'Thinking…') + '</div>'
      : '<div class="a">' + esc(it.x.answer) + '</div>' +
        (it.x.sources && it.x.sources.length ? '<div class="xsrc"><span class="label">Sources</span><ol>' + it.x.sources.map(s => '<li>' +
          (links(s.url).length ? '<a class="ext" href="' + esc(links(s.url)[0]) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>' : esc(s.title)) +
          ' <span class="muted">· ' + esc(s.site) + (s.date ? ' · ' + esc(s.date) : '') + '</span></li>').join('') + '</ol></div>' : '') +
        '<div class="muted" style="font-size:12px">' + (it.x.searched ? 'Searched the web just now (' + it.x.searched + ' search' + (it.x.searched > 1 ? 'es' : '') + ')' : 'From ZOBO\'s own knowledge; no web search needed') + '</div>') +
    '</article>').reverse().join('');
  const last = expertItems.filter(i => i.x && i.x.usage !== '' && i.x.usage != null).pop();
  if (last) $('xUsage').textContent = 'Web searches used this month: ' + last.x.usage + ' of ' + last.x.limit + ' (shared with machine sourcing). Questions that need no news use no searches.';
}
async function expertSend(q, byVoice) {
  q = String(q == null ? $('xq').value : q).trim(); if (!q || expertBusy) return;
  voiceInput = !!byVoice;
  if (IDENTITY_RE.test(q)) { $('xq').value = ''; expertItems.push({ q, x: { answer: IDENTITY_LINE, sources: [], searched: 0, usage: '', limit: 250 } }); renderExpert(); speak(IDENTITY_LINE); return; }
  $('xq').value = ''; expertBusy = true; $('xsend').disabled = true;
  const item = { q, x: null, status: 'Thinking, and searching the latest sources if needed… (about 20 seconds)' };
  expertItems.push(item); renderExpert();
  const hist = [];
  expertItems.filter(i => i.x).slice(-4).forEach(i => hist.push({ role: 'user', text: i.q }, { role: 'jarvis', text: i.x.answer }));
  try { item.x = await call('askExpert', q, hist); speak(item.x.answer); }
  catch (e) { item.x = { answer: 'Sorry, I could not answer just now. Please try again in a minute.', sources: [], searched: 0, usage: '?', limit: 250 }; }
  expertBusy = false; $('xsend').disabled = false; renderExpert();
}

/* ---------- dashboard ---------- */
let dtab = 'overview', profIdx = null;
const cmp = { hideEmpty: true, diffOnly: false, q: '', sort: null, hidden: {} };
const F = (src, h, kind, label) => ({ src, h, kind: kind || 'text', label: label || h });
const SECTIONS = [
  ['Verdict', [F('cp', 'Total score (auto)', 'num+', 'Total score /100'), F('cp', 'Verdict (auto)', 'text', 'Verdict'), F('pi', 'Why buy this one, not the others', 'text', 'Why buy this one'),
    F('pi', 'Pros'), F('pi', 'Cons and risks'), F('pi', 'Recommendation'), F('pi', 'Asset or liability'), F('pi', 'Reason', 'text', 'Asset or liability: why')]],
  ['Scores', 'SCORES'],
  ['Company and history', [F('cp', 'Company name (Chinese)', 'text', 'Chinese name'), F('cp', 'City, province'), F('cp', 'Company type'), F('cp', 'Founded year'),
    F('cp', 'Years in business (auto)', 'num+', 'Years in business'), F('cp', 'Registered capital (RMB)', 'num+'), F('cp', 'Paid-in capital (RMB)', 'num+'), F('cp', 'Stock code', 'text', 'Stock code (listed)'),
    F('cp', 'USCC', 'text', 'Credit code (USCC)'), F('cp', 'Factory address'), F('cp', 'Website', 'link'), F('pi', 'Manufacturer summary: history, scale, service, reputation', 'text', 'About the maker')]],
  ['Plant, scale and expertise', [F('cp', 'Insured employees', 'num+'), F('cp', 'Plant area (m²)', 'num+'), F('cp', 'Annual production capacity'), F('cp', 'Factories (count)', 'num+'),
    F('cp', 'R&D centre'), F('cp', 'Patents (count)', 'num+'), F('cp', 'Standards drafted'), F('cp', 'High-Tech / Little Giant status'), F('pi', "Manufacturer's other product lines", 'text', 'Other product lines')]],
  ['Quality and licences', [F('cp', 'Mandatory China licence and grade', 'text', 'China manufacturing licence'), F('cp', 'Certifications'), F('cp', 'Third-party audit')]],
  ['Product and specifications', [F('pi', 'Model'), F('pi', 'Product type'), F('pi', 'Product description'), F('pi', 'Capacity'), F('pi', 'Pressure / power / speed'),
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
  ['Risks and India compliance', [F('cp', 'Lawsuits as defendant'), F('cp', 'Penalties or abnormal records'), F('cp', 'Red flags found'), F('pi', 'Indian compliance needed')]],
  ['Videos and contact', [F('pi', 'Video links', 'link'), F('pi', 'Video type'), F('pi', 'Video language'), F('cp', 'Sales contact'), F('cp', 'Email'), F('cp', 'Phone / WeChat')]]
];
const num = v => { if (v === '' || v == null) return null; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const inr = n => n == null ? '' : '₹' + Math.round(n).toLocaleString('en-IN');
const links = v => String(v || '').split(/[\s,;]+/).map(u => /^www\./i.test(u) ? 'http://' + u : u).filter(u => /^https?:\/\/[^\s"'<>]+$/i.test(u));
function fields(sec) {
  if (sec[1] !== 'SCORES') return sec[1];
  return dash.labels.map((l, j) => ({ src: 'score', j, kind: 'num+', label: l + ' /' + dash.max[j] }));
}
function val(c, f) {
  if (f.src === 'score') return c.scores[f.j] === '' ? '' : String(c.scores[f.j]);
  if (f.kind === 'price') { const p = c.pi['Indicative price']; return p ? (c.pi['Currency'] || '') + ' ' + p : ''; }
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
async function loadDash(reqId) {
  show('dash'); $('dash').innerHTML = '<div class="empty">Loading the dashboard…</div>';
  dash = await call('getDashboard', reqId || null);
  if (!dash) { $('dash').innerHTML = '<div class="empty">No report yet. Ask the assistant for a machine first.</div>'; return; }
  dash.companies.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  keep = {}; dash.companies.forEach(c => keep[c.name] = dash.approved ? c.selected : true);
  dtab = 'overview'; profIdx = null; cmp.hidden = {}; cmp.sort = null;
  renderDash();
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
  const tabs = [['overview', 'Overview'], ['products', 'Products'], ['compare', 'Compare companies'], ['check', 'Buying checklist']];
  let body;
  if (profIdx != null) body = profileHtml(profIdx);
  else if (dtab === 'compare') body = compareHtml();
  else if (dtab === 'products') body = productsHtml();
  else if (dtab === 'check') body = checklistHtml();
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
      : '<p class="sub">Only the machine and capacity were given. Fuel, pressure and budget help ZOBO pick the right model next time.</p>') + '</div>' + head + '</header>' +
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
    (qa.length ? '' : '<div class="ideas">' + ASK_IDEAS.map(q => '<button class="chipbtn" onclick="dashAsk(this.textContent)">' + esc(q) + '</button>').join('') + '</div>') +
    qa.map(x => '<div class="qa"><div class="q">' + esc(x.q) + '</div><div class="a">' + (x.a == null ? '<span class="muted">Thinking…</span>' : esc(x.a)) + '</div></div>').reverse().join('') +
    (qa.length ? '<div class="ideas">' + ASK_IDEAS.slice(0, 3).map(q => '<button class="chipbtn" onclick="dashAsk(this.textContent)">' + esc(q) + '</button>').join('') +
      '<button class="chipbtn" onclick="dashQA=dashQA.filter(x=>x.reqId!==dash.reqId);renderDash()">Clear</button></div>' : '') + '</section>';
}
async function dashAsk(q) {
  q = String(q || '').trim(); if (!q) return;
  const item = { reqId: dash.reqId, q, a: null };
  dashQA.push(item); renderDash();
  const hist = [];
  dashQA.filter(x => x.reqId === dash.reqId && x.a).slice(-4).forEach(x => hist.push({ role: 'user', text: x.q }, { role: 'jarvis', text: x.a }));
  try {
    const r = await call('askJarvis', q, dash.reqId, hist);
    item.a = r.type === 'answer' ? r.answer : 'That sounds like a new machine to source. Open the Assistant tab and tell me there, and I will start a new search.';
  } catch (e) { item.a = 'Sorry, I could not answer just now. Please try again.'; }
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
function checklistHtml() {
  const cos = dash.companies;
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
  const secs = SECTIONS.filter(s => s[0] !== 'Verdict' && s[0] !== 'Scores');
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
const photoCache = {};
function callQuiet(fn, ...args) { return api(fn, args, true).catch(() => ''); }
const photosOf = c => links(c.pi['Product photos']);
const videosOf = c => links(c.pi['Video links']);
/** An image placeholder that loadPhotos() fills through the script (gets around hotlink blocks and http-only sites). */
function photoTag(url, alt, cls) {
  return '<div class="ph ' + (cls || '') + '"><img data-u="' + esc(url) + '" alt="' + esc(alt) + '"><span class="phmsg">Loading photo…</span></div>';
}
async function loadPhotos() {
  const imgs = [...document.querySelectorAll('.ph img[data-u]:not([data-done])')];
  for (const im of imgs) {
    im.setAttribute('data-done', '1');
    const u = im.getAttribute('data-u');
    if (!(u in photoCache)) photoCache[u] = await callQuiet('photo', u);
    const d = photoCache[u], box = im.parentElement;
    if (d) { im.src = d; box.classList.add('ok'); }
    else { box.classList.add('fail'); box.querySelector('.phmsg').innerHTML = 'Photo blocked by the supplier site. <a class="ext" href="' + esc(u) + '" target="_blank" rel="noopener">Open it</a>'; }
  }
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
  ['Specifications', [PF('Capacity'), PF('Pressure / power / speed'), PF('Fuel or energy type'), PF('Rated efficiency', 'num+'), PF('Footprint and weight'),
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
    const rows = sec[1].filter(f => cos.some(c => val(c, f)));
    if (!rows.length) return;
    html += '<tr class="sec"><td class="rl">' + esc(sec[0]) + '</td><td colspan="' + cos.length + '"></td></tr>';
    rows.forEach(f => {
      const b = bestIdx(cos, f);
      html += '<tr><td class="rl">' + esc(f.label) + '</td>' + cos.map((c, i) => '<td' + (b.indexOf(i) !== -1 ? ' class="best"' : '') + '>' + cellHtml(val(c, f), f) + '</td>').join('') + '</tr>';
    });
  });
  return html + '</tbody></table></div><div class="muted" style="font-size:12px">Photos and videos come from each company\'s own website. ▲ best = best value among these products. Click long text to expand.</div></section>';
}

async function doProceed() {
  const names = Object.keys(keep).filter(n => keep[n]);
  if (!names.length) { toast('Keep at least one company.'); return; }
  dash = await call('proceed', dash.reqId, names);
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
  $('form').innerHTML = '<form onsubmit="event.preventDefault();submitForm()" style="display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:22px">' +
    '<section class="card" style="padding:24px 28px"><a class="crumb" href="javascript:openDash(dash.reqId)">Back to the report</a><h1 style="margin:8px 0 20px">Request a quotation from ' + esc(c.name) + '</h1><div class="grid2">' +
    fld('f-to', 'Supplier email', c.email, 'email', true) + fld('f-model', 'Model', c.model, 'text', true) +
    fld('f-qty', 'Quantity', '1', 'text', true) + fld('f-date', 'Target delivery date', '', 'date', true) +
    fld('f-specs', 'Required specs and options', (dash.capacity ? dash.capacity + ', ' : ''), 'area', true, true) +
    fld('f-place', 'Delivery place', '', 'text', true) +
    '<div class="f"><label for="f-inco">Incoterm *</label><select id="f-inco" class="fld">' + ['CIF', 'FOB', 'CIP', 'EXW', 'DAP'].map(x => '<option>' + x + '</option>').join('') + '</select></div>' +
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
  $('done').innerHTML = '<section class="card" style="width:560px;text-align:center;padding:38px 34px;border-color:var(--goodline)"><h1>' + esc(draft.rfq) + ' sent to ' + esc(draft.supplier) + '</h1>' +
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
function showTyping() {
  hideTyping();
  const d = document.createElement('div');
  d.className = 'msg agent typing'; d.id = 'typingDots'; d.setAttribute('aria-label', 'ZOBO is thinking');
  d.innerHTML = '<i></i><i></i><i></i>';
  $('msgs').appendChild(d); $('msgs').scrollTop = 1e9;
}
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
setCalm(store.get('zobo_calm') === '1');

/* ---------- sign-in ---------- */
let loginEmail = '';
function showLogin(msg) {
  show('login');
  $('loginStep1').style.display = 'flex'; $('loginStep2').style.display = 'none';
  $('loginMsg').textContent = msg || '';
  $('loginEmail').value = loginEmail || store.get('jarvis_email') || '';
  setTimeout(() => $('loginEmail').focus(), 50);
}
async function loginSend() {
  const email = $('loginEmail').value.trim();
  if (!email) { $('loginMsg').textContent = 'Type your work email.'; return; }
  const b = $('loginSendBtn'); b.disabled = true; b.textContent = 'Sending the code…'; $('loginMsg').textContent = '';
  try {
    await api('requestCode', [], true, { email });
    loginEmail = email.toLowerCase(); store.set('jarvis_email', loginEmail);
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
    const r = await api('verifyCode', [], true, { email: loginEmail, code });
    TOKEN = r.token; store.set('jarvis_token', TOKEN);
    await startApp();
  } catch (e) { $('loginMsg').textContent = e.message || 'Could not sign in.'; }
  b.disabled = false; b.textContent = 'Sign in';
}
function signOut(msg) {
  TOKEN = ''; ME = null; store.del('jarvis_token');
  running = false; clearInterval(polling); stopSpeaking();
  // nothing from the previous person stays on screen or in memory
  booted = false; canApprove = false; dash = null; pending = null; lastReport = null; chatHist = []; dashQA = []; expertItems = []; keep = {};
  $('msgs').innerHTML = ''; $('xThread').innerHTML = ''; $('dash').innerHTML = ''; $('confirm').style.display = 'none'; $('openDashBtn').style.display = 'none';
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  showLogin(typeof msg === 'string' ? msg : 'You are signed out.');
}

/* ---------- reports list ---------- */
const STATUS_CLS = { 'Report ready': 'warn', Approved: 'ok', Closed: 'ok', Running: 'unk', Stopped: 'bad', Failed: 'bad', New: 'unk' };
async function openReports() {
  show('reports');
  $('reportsBody').innerHTML = '<div class="empty" style="padding:40px">Loading reports…</div>';
  let list;
  try { list = await call('listReports'); } catch (e) { $('reportsBody').innerHTML = '<div class="empty" style="padding:40px">Could not load the reports.</div>'; return; }
  if (!list.length) { $('reportsBody').innerHTML = '<div class="empty" style="padding:40px">No reports yet. Start one from the Assistant.</div>'; return; }
  $('reportsBody').innerHTML = '<div class="cmpwrap" style="max-height:none"><table class="evt list"><thead><tr><th>Request</th><th>Machine</th><th>Requested</th><th>Status</th><th>Companies</th><th>Best match</th><th></th></tr></thead><tbody>' +
    list.map(r => '<tr><td class="mono">' + esc(r.reqId) + '</td><td><b>' + esc(r.machine) + '</b>' + (r.capacity || r.budget ? '<div class="muted">' + esc([r.capacity, r.budget ? 'budget ₹' + (num(r.budget) != null ? num(r.budget).toLocaleString('en-IN') : r.budget) : ''].filter(Boolean).join(', ')) + '</div>' : '') + '</td>' +
      '<td>' + esc(r.date) + '<div class="muted">' + esc(r.requestedBy) + '</div></td>' +
      '<td><span class="st ' + (STATUS_CLS[r.status] || 'unk') + '">' + esc(r.status || r.stage || '—') + '</span>' + (r.approvedBy ? '<div class="muted">by ' + esc(r.approvedBy) + '</div>' : '') + '</td>' +
      '<td>' + esc(r.companies) + (r.rejected ? '<div class="muted">' + esc(r.rejected) + ' rejected</div>' : '') + '</td>' +
      '<td>' + (r.best ? esc(r.best.name) + '<div class="muted">' + esc(r.best.total) + '/100</div>' : '<span class="muted">—</span>') + '</td>' +
      '<td>' + (r.companies ? '<button class="btn" style="height:36px" onclick="openDash(\'' + esc(r.reqId) + '\')">Open</button>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

/* ---------- quotations list ---------- */
async function openQuotes() {
  show('quotes');
  $('quotesBody').innerHTML = '<div class="empty" style="padding:40px">Loading quotations…</div>';
  let list;
  try { list = await call('listQuotations'); } catch (e) { $('quotesBody').innerHTML = '<div class="empty" style="padding:40px">Could not load the quotations.</div>'; return; }
  if (!list.length) { $('quotesBody').innerHTML = '<div class="empty" style="padding:40px">No quotation requests sent yet. Open a report, press Proceed, then Request quotation.</div>'; return; }
  const cls = s => /quote received/i.test(s) ? 'ok' : /replied/i.test(s) ? 'ok' : /follow/i.test(s) ? 'warn' : 'unk';
  $('quotesBody').innerHTML = '<div class="cmpwrap" style="max-height:none"><table class="evt list"><thead><tr><th>RFQ</th><th>Supplier and model</th><th>Sent</th><th>Status</th><th>Price</th><th>Lead time</th><th>Terms</th><th></th></tr></thead><tbody>' +
    list.map(q => '<tr><td class="mono">' + esc(q.rfq) + '</td><td><b>' + esc(q.supplier) + '</b><div class="muted">' + esc(q.model) + (q.qty ? ' · qty ' + esc(q.qty) : '') + '</div></td>' +
      '<td>' + esc(q.sentAt) + '<div class="muted">' + esc(q.submittedBy) + '</div></td>' +
      '<td><span class="st ' + cls(q.status) + '">' + esc(q.status || '—') + '</span>' + (q.replyHours ? '<div class="muted">replied in ' + esc(q.replyHours) + ' h</div>' : '') + '</td>' +
      '<td>' + (q.price ? '<b>' + esc(q.currency) + ' ' + esc(q.price) + '</b><div class="muted">' + esc(q.incoterm) + '</div>' : '<span class="muted">waiting</span>') + '</td>' +
      '<td>' + (q.leadWeeks ? esc(q.leadWeeks) + ' weeks' : '<span class="muted">—</span>') + '</td>' +
      '<td>' + esc([q.payment, q.validity ? 'valid ' + q.validity : ''].filter(Boolean).join(' · ')) + (q.notes ? '<div class="muted">' + esc(q.notes) + '</div>' : '') + '</td>' +
      '<td>' + (q.reqId ? '<button class="btn" style="height:36px" onclick="openDash(\'' + esc(q.reqId) + '\')">Report</button>' : '') + '</td></tr>').join('') +
    '</tbody></table></div><p class="muted" style="font-size:12px;margin:10px 0 0">Supplier replies are checked every hour. Prices from replies are copied into the report automatically.</p>';
}

/* ---------- page addresses ---------- */
function route() {
  if (!TOKEN || !ME) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0], id = decodeURIComponent(parts[1] || '');
  if (page === 'report') return loadDash(id || null);
  if (page === 'reports') return openReports();
  if (page === 'expert') return openExpertView();
  if (page === 'quotes') return openQuotes();
  show('assist');
  setTimeout(() => { const c = $('cmd'); if (c) c.focus(); }, 50);
}
window.addEventListener('hashchange', route);

/* ---------- start ---------- */
let booted = false;
async function startApp() {
  ME = await api('me');
  $('meName').textContent = ME.name; $('meRole').textContent = ME.role; $('meEmail').textContent = ME.email;
  $('brandCo').textContent = ME.company || 'Zonac Knitting Production';
  canApprove = !!(ME.can && ME.can.approve);
  if (!booted) {
    booted = true;
    renderSteps('');
    const b = await call('getBoot');
    if (b.run && b.run.stage !== 'Done' && b.run.stage !== 'Error') {
      running = true; say('Welcome back, ' + ME.name + '. I am ZOBO, and I am still working on ' + b.run.machine + '.'); poll();
    } else {
      lastReport = b.lastReport;
      say('Hello ' + ME.name + '. ' + IDENTITY_LINE + '\nTell me a machine you need and I will find and vet the best Chinese manufacturers, or ask me anything about machines, the socks industry or textile technology.' +
        (b.lastReport ? '\nYou can also ask about the last report (' + b.lastReport + '): which company should we choose, what are the risks, or a summary for the boss.' : ''));
      if (b.lastReport) { $('openDashBtn').style.display = 'inline-block'; $('subline').textContent = 'Name a machine, or ask about the last report'; }
    }
  }
  route();
}
async function init() {
  if (!GAS && (!CFG.apiUrl || /PASTE/i.test(CFG.apiUrl))) { show('setup'); return; }
  if (!TOKEN) { showLogin(); return; }
  try { await startApp(); } catch (e) { if (TOKEN) showLogin('Please sign in.'); }
}
init();
