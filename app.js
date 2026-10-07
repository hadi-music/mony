'use strict';

/* ---------- basics ---------- */
const KEY = 'mony.v1';
const DEFAULT_TAGS = ['design', 'video', 'music', 'gig', 'other']; // starting set; each user edits theirs in Splits
const APPS = ['Whish', 'Neo', 'Other'];
const BACKUP_DAYS = 14;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const r2 = n => Math.round((+n || 0) * 100) / 100;
const num = v => { const n = parseFloat(String(v ?? '').replace(/[,$\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
const money = n => {
  n = r2(n); const neg = n < 0; n = Math.abs(n);
  return (neg ? '−$' : '$') + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
};
const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthKey = d => String(d).slice(0, 7);
const monthLabel = k => { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); };
const dateLabel = d => new Date(d + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' });
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/* ---------- state ---------- */
function defaults() {
  return {
    v: 1,
    wallets: [
      { id: 'w_ess', name: 'Essentials', app: 'Whish', inbox: true, savings: false },
      { id: 'w_bey', name: 'Beirut', app: 'Neo', inbox: false, savings: false },
      { id: 'w_inv', name: 'Investment', app: 'Neo', inbox: false, savings: false },
      { id: 'w_sav', name: 'Savings + Emergency', app: 'Neo', inbox: false, savings: true },
    ],
    splits: [
      { id: 's_norm', name: 'Normal', pcts: { w_ess: 40, w_bey: 10, w_inv: 15, w_sav: 35 } },
      { id: 's_big', name: 'Big job', pcts: { w_ess: 25, w_bey: 10, w_inv: 20, w_sav: 45 } },
    ],
    defaultSplit: 's_norm',
    floor: 2500,
    startSavings: 0,
    startSet: false,
    goals: [],
    tags: [...DEFAULT_TAGS],
    target: 1700,
    payments: [],
    withdrawals: [],
    waiting: [],
    lastBackup: null,
    created: Date.now(),
  };
}
function migrate(d) {
  const base = defaults();
  if (!d || typeof d !== 'object') return base;
  for (const k of Object.keys(base)) if (d[k] === undefined) d[k] = base[k];
  for (const k of ['wallets', 'splits', 'payments', 'withdrawals', 'waiting', 'goals', 'tags']) if (!Array.isArray(d[k])) d[k] = base[k];
  if (!d.tags.length) d.tags = [...DEFAULT_TAGS];
  if (typeof d.startSet !== 'boolean') d.startSet = (+d.startSavings || 0) > 0;
  if (!d.wallets.length) d.wallets = base.wallets;
  if (!d.splits.length) d.splits = base.splits;
  if (!d.splits.some(s => s.id === d.defaultSplit)) d.defaultSplit = d.splits[0].id;
  return d;
}
let memoryOnly = false;
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return migrate(JSON.parse(raw)); }
  catch (e) { memoryOnly = true; }
  return defaults();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); memoryOnly = false; }
  catch (e) { memoryOnly = true; toast('Couldn’t save — storage is blocked'); }
  if (window.MonySync) MonySync.changed();
}
let S = load();
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

/* ---------- derived ---------- */
const wallet = id => S.wallets.find(w => w.id === id);
const inboxWallet = () => S.wallets.find(w => w.inbox);
const savingsWallet = () => S.wallets.find(w => w.savings);
const shareName = s => (wallet(s.walletId) || s).name;
const shareApp = s => (wallet(s.walletId) || s).app;
/* The to-split path: first the hop Whish → Neo (one transfer for the whole Neo total),
   then each Neo wallet in order. Each step unlocks the next. */
function steps(p) {
  const inb = p.shares.find(s => s.inbox);
  const home = inb ? shareApp(inb) : stayApp();
  p.hops = p.hops || {};
  const groups = new Map();
  p.shares.forEach((s, i) => { if (!s.auto) { const a = shareApp(s); if (!groups.has(a)) groups.set(a, []); groups.get(a).push({ s, i }); } });
  const out = [];
  for (const a of appKeys(Object.fromEntries(groups))) {
    const sh = groups.get(a);
    if (a !== home) out.push({ key: 'hop:' + a, type: 'hop', app: a, amount: r2(sh.reduce((t, x) => t + x.s.amount, 0)),
      wallets: sh.map(x => shareName(x.s)), done: !!p.hops[a] || sh.every(x => x.s.done) });
    sh.forEach(x => out.push({ key: 's:' + x.i, type: 'share', i: x.i, app: a, s: x.s, amount: x.s.amount, done: x.s.done }));
  }
  return out;
}
const isPending = p => steps(p).some(s => !s.done);
const pctTotal = pcts => r2(S.wallets.reduce((a, w) => a + (+pcts[w.id] || 0), 0));
const pctString = pcts => S.wallets.map(w => +pcts[w.id] || 0).join('/');
const sortedPayments = () => [...S.payments].sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));

function savingsTotal() {
  let t = +S.startSavings || 0;
  for (const p of S.payments) for (const s of p.shares) if (s.savings && s.done) t += s.amount;
  for (const w of S.withdrawals) t -= w.amount;
  return r2(t);
}
function savingsPending() {
  let t = 0;
  for (const p of S.payments) for (const s of p.shares) if (s.savings && !s.done) t += s.amount;
  return r2(t);
}
/* Money per app: Neo = transfers out, Whish (the inbox app) = what stays. Prepaid isn't counted: it already left. */
/* A transfer fee is either paid on top from the inbox ("Whish took $182") or taken out of
   what arrives ("Neo got $178"). Only on-top fees lower what stays in the inbox; inside fees
   lower the wallet shares in that app instead. */
const feeTotal = p => r2(Object.values(p.fees || {}).reduce((a, v) => a + (+v || 0), 0));
const feeTop = p => r2(Object.entries(p.fees || {}).reduce((a, [app, v]) => a + ((p.feeMode || {})[app] === 'inside' ? 0 : (+v || 0)), 0));
function lastFeeMode(app) {
  const ps = [...S.payments].sort((a, b) => b.created - a.created);
  for (const p of ps) if (p.feeMode && p.feeMode[app]) return p.feeMode[app];
  return 'top';
}
function takeFeeInside(p, app, fee) { // spread the fee over that app's wallets, biggest takes the rounding
  const sh = p.shares.filter(s => !s.auto && shareApp(s) === app);
  const total = sh.reduce((a, s) => a + s.amount, 0); if (!total) return;
  let left = fee;
  sh.forEach(s => { if (s.orig == null) s.orig = s.amount; });
  const big = sh.reduce((a, b) => (b.amount > a.amount ? b : a));
  sh.forEach(s => { if (s !== big) { const cut = Math.round(fee * s.orig / total); s.amount = r2(s.orig - cut); left = r2(left - cut); } });
  big.amount = r2(big.orig - left);
}
function restoreFeeInside(p, app) {
  p.shares.forEach(s => { if (shareApp(s) === app && s.orig != null) { s.amount = s.orig; delete s.orig; } });
}
function lastFee(app) {
  const ps = [...S.payments].sort((a, b) => b.created - a.created);
  for (const p of ps) if (p.fees && +p.fees[app] > 0) return +p.fees[app];
  return 0;
}
function appTotals(ps) {
  const t = {};
  const add = (a, v) => { if (v) t[a] = r2((t[a] || 0) + v); };
  for (const p of ps) {
    for (const s of p.shares) add(shareApp(s), s.amount);
    const inb = p.shares.find(s => s.inbox);
    add(inb ? shareApp(inb) : (inboxWallet() || {}).app || 'Whish', -feeTop(p));
  }
  return t;
}
const appKeys = t => Object.keys(t).sort((a, b) => (APPS.indexOf(a) + 99 * (APPS.indexOf(a) < 0)) - (APPS.indexOf(b) + 99 * (APPS.indexOf(b) < 0)) || a.localeCompare(b));
const stayApp = () => (inboxWallet() || {}).app || 'Whish';
const appLabel = a => (a === stayApp() ? `Stays in ${a}` : `To ${a}`);
function appBlock(t, withCopy) {
  return appKeys(t).map(a => `<div class="kv app-kv"><span>${esc(appLabel(a))}</span><span><b>${money(t[a])}</b>${withCopy && a !== stayApp()
    ? ` <button class="btn ghost sm" data-act="copy" data-v="${t[a]}" style="min-height:28px;padding:2px 6px">Copy</button>` : ''}</span></div>`).join('');
}
const owedTotal = () => r2(S.waiting.reduce((a, w) => a + w.amount, 0));
const monthIncome = k => r2(S.payments.filter(p => monthKey(p.date) === k).reduce((a, p) => a + p.amount, 0));
function clients() {
  const set = new Set();
  [...S.waiting.map(w => w.client), ...sortedPayments().map(p => p.client)].forEach(c => c && set.add(c));
  return [...set];
}

/* The split: whole-dollar transfers, rounding remainder to Savings, cents stay in the inbox. */
function computeShares(amount, takeOff, pcts) {
  const base = r2(amount - (takeOff || 0));
  const shares = S.wallets.map(w => ({
    walletId: w.id, name: w.name, app: w.app, inbox: !!w.inbox, savings: !!w.savings,
    pct: +pcts[w.id] || 0, amount: 0, done: false, auto: false,
  }));
  const whole = Math.floor(base), cents = r2(base - whole);
  const sink = shares.find(s => s.savings && s.pct > 0) || shares.find(s => s.inbox && s.pct > 0)
    || shares.reduce((a, b) => (b.pct > a.pct ? b : a));
  let sum = 0;
  for (const s of shares) if (s !== sink) { s.amount = Math.round(base * s.pct / 100); sum += s.amount; }
  sink.amount = whole - sum;
  while (sink.amount < 0) { // extreme rounding edge: shave the biggest other share
    const big = shares.filter(s => s !== sink).reduce((a, b) => (b.amount > a.amount ? b : a));
    big.amount -= 1; sink.amount += 1;
  }
  const centHome = shares.find(s => s.inbox) || sink;
  centHome.amount = r2(centHome.amount + cents);
  for (const s of shares) if (s.inbox || s.amount === 0) { s.auto = true; s.done = true; }
  return shares;
}

/* ---------- ui helpers ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}
function openSheet(html, onInput) {
  $('#sheet').innerHTML = html; $('#sheetWrap').hidden = false;
  sheetInput = onInput || null;
  const f = $('#sheet input:not([type=radio]):not([type=checkbox])'); if (f && !f.dataset.nofocus) setTimeout(() => f.focus(), 60);
}
let sheetInput = null;
function closeSheet() { $('#sheetWrap').hidden = true; $('#sheet').innerHTML = ''; sheetInput = null; }
let pendingConfirm = null;
function confirmSheet(title, body, okLabel, onOk, danger = true) {
  pendingConfirm = onOk;
  openSheet(`<h3>${esc(title)}</h3><p class="muted">${body}</p>
    <div class="btns" style="margin-top:18px">
      <button class="btn primary block" data-act="confirmOk" style="${danger ? 'background:var(--hot);color:#fff' : ''}">${esc(okLabel)}</button>
      <button class="btn block" data-act="closeSheet">Cancel</button>
    </div>`);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e2) { return false; }
  }
}
async function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: name }); return true;
    }
  } catch (e) { if (e && e.name === 'AbortError') return false; }
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return true;
  } catch (e) { toast('Download failed'); return false; }
}
function go(hash, replace) {
  if (replace) { history.replaceState(null, '', '#' + hash); render(); }
  else if (location.hash === '#' + hash) render();
  else location.hash = hash;
}

/* ---------- router ---------- */
let draft = null;
function render() {
  const gated = !!(window.MonySync && MonySync.needsSignIn());
  document.body.classList.toggle('gate', gated);
  if (gated) { document.body.dataset.view = 'gate'; $('#view').innerHTML = viewGate(); return; }
  const [name, arg] = (location.hash.slice(1) || 'home').split('/');
  document.body.dataset.view = name in { home: 1, new: 1, edit: 1, pay: 1, savings: 1, waiting: 1, history: 1, splits: 1 } ? name : 'home';
  const views = { home: viewHome, new: viewNew, edit: viewNew, pay: viewPay, savings: viewSavings, waiting: viewWaiting, history: viewHistory, splits: viewSplits };
  const fn = views[name] || viewHome;
  const form = name === 'new' || name === 'edit';
  if (form && (!draft || draft.forArg !== name + '/' + (arg || ''))) { draft = name === 'edit' ? editDraft(arg) : newDraft(arg); if (draft) draft.forArg = name + '/' + (arg || ''); }
  if (name === 'edit' && !draft) { go('history', true); return; }
  $('#view').innerHTML = fn(arg);
  const tab = { new: 'home', pay: 'home', edit: 'history' }[name] || name;
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (form) updatePreview();
  if (!form) draft = null;
  if (window.MonySync) MonySync.paint();
  if (name === 'pay') feeLabels();
  if (name === 'splits' && window.caches) caches.keys().then(k => { const v = k.find(x => x.startsWith('mony-')); const el = $('#appVersion'); if (el && v) el.textContent = 'BROKE ' + v.replace('mony-', ''); }).catch(() => {});
}
window.addEventListener('hashchange', () => { closeSheet(); render(); $('#view').scrollTop = 0; });

/* ---------- sign-in gate ---------- */
const G_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
function viewGate() {
  const R = 70, r = 40, gap = 5, splits = [40, 10, 15, 35];
  const pt = (rad, t) => `${(100 + rad * Math.sin(t)).toFixed(2)} ${(100 - rad * Math.cos(t)).toFixed(2)}`;
  let a = 0, slices = '', cuts = '';
  splits.forEach((p, i) => {
    const s = a, e = a + p / 100 * Math.PI * 2; a = e; const L = e - s > Math.PI ? 1 : 0;
    slices += `<path class="${i === 3 ? 'sav' : 'rest'}" style="animation-delay:${i * 0.12}s" d="M${pt(R, s)}A${R} ${R} 0 ${L} 1 ${pt(R, e)}L${pt(r, e)}A${r} ${r} 0 ${L} 0 ${pt(r, s)}Z"/>`;
    cuts += `<line x1="${pt(r - 2, s).split(' ')[0]}" y1="${pt(r - 2, s).split(' ')[1]}" x2="${pt(R + 2, s).split(' ')[0]}" y2="${pt(R + 2, s).split(' ')[1]}"/>`;
  });
  return `<section class="gate-wrap">
    <svg class="gate-mark" viewBox="0 0 200 200" aria-hidden="true"><g class="gate-spin">${slices}<g class="gate-cuts" stroke-width="${gap}">${cuts}</g></g></svg>
    <h1 class="gate-word">BROKE</h1>
    <p class="gate-tag">Pay yourself<br>first.</p>
    <p class="gate-sub">Split every payment. Tick off the transfers. Watch the jar fill.</p>
    <div class="gate-foot">
      <button class="gbtn" data-act="syncConnect">${G_LOGO}<span>Sign in with Google</span></button>
      <p class="gate-fine">Your money stays on this phone and in a sheet in your own Google Drive. BROKE can only see the sheet it creates. <a href="privacy.html">Privacy</a></p>
    </div>
  </section>`;
}

/* ---------- home ---------- */
function backupBanner() {
  if (!S.payments.length && !S.waiting.length && !S.withdrawals.length) return '';
  const since = S.lastBackup || S.created;
  const days = Math.floor((Date.now() - since) / 864e5);
  if (days < BACKUP_DAYS) return '';
  const msg = S.lastBackup ? `Last backup ${days} days ago` : 'No backup yet';
  return `<div class="banner"><span>${msg}</span><button class="btn sm" data-act="backup">Back up</button></div>`;
}
/* The big button: a jar of liquid that fills toward this month's target, ringed by your split. */
function paidButton(inc, tgt) {
  const pct = tgt ? Math.min(1, inc / tgt) : 0;
  const owed = owedTotal(), gpct = tgt ? Math.min(1, (inc + owed) / tgt) : 0;
  const top = 16, bot = 184;
  const level = p => r2(bot - (0.07 + 0.86 * p) * (bot - top));
  const water = level(pct), ghost = level(gpct);
  const wave = amp => { let d = `M-100 0`; for (let x = -100; x < 500; x += 50) d += ` Q${x + 25} ${x % 100 === 0 ? -amp : amp} ${x + 50} 0`; return d + ' V240 H-100Z'; };
  const sp = S.splits.find(x => x.id === S.defaultSplit) || S.splits[0];
  const R = 94, C = 2 * Math.PI * R, gap = 5;
  let off = 0;
  const ring = S.wallets.map(w => {
    const len = (+sp.pcts[w.id] || 0) / 100 * C; const seg = Math.max(0, len - gap);
    const el = seg ? `<circle cx="100" cy="100" r="${R}" class="seg-${w.savings ? 'sav' : w.inbox ? 'in' : 'out'}" stroke-dasharray="${seg.toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}"/>` : '';
    off += len; return el;
  }).join('');
  const bubbles = [[70, 0, 3.2, 3], [96, 1.1, 2.6, 2.2], [122, 2.3, 3.6, 3.4], [84, 3.1, 2.9, 1.8], [132, 0.6, 3.1, 2.4], [108, 1.9, 3.8, 2.8]]
    .map(([x, delay, dur, r]) => `<circle class="bub" cx="${x}" cy="${bot - 4}" r="${r}" style="--rise:${(water - bot + 6).toFixed(0)}px;animation-delay:${delay}s;animation-duration:${dur}s"/>`).join('');
  const label = pct >= 1 ? 'Target hit — keep going' : inc > 0 ? `${Math.round(pct * 100)}% of ${new Date().toLocaleString('en-US', { month: 'long' })}` : 'Fill the jar';
  return `<div class="paid">
    <button class="jar" data-act="newPay" aria-label="I got paid. ${esc(label)}">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs><clipPath id="jarclip"><circle cx="100" cy="100" r="84"/></clipPath>
          <linearGradient id="liq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6FF9C"/><stop offset=".35" stop-color="#D4FF00"/></linearGradient></defs>
        <g class="ring"><g fill="none" stroke-width="7" stroke-linecap="round" transform="rotate(-90 100 100)">${ring}</g></g>
        <circle cx="100" cy="100" r="84" class="jar-bg"/>
        <g clip-path="url(#jarclip)">
          ${owed > 0 && ghost < water - 2 ? `<g class="ghost-water"><g transform="translate(0 ${ghost})"><g class="wave w3"><path d="${wave(4)}"/></g></g></g>` : ''}
          <g class="surge"><g transform="translate(0 ${water})">
            <g class="wave w2"><path d="${wave(5)}"/></g>
            <g class="wave w1"><path d="${wave(7)}"/></g>
          </g></g>
          ${bubbles}
        </g>
      </svg>
      <span class="jar-txt"><b>I got<br>paid</b><small>${esc(label)}</small>${owed > 0 ? `<small class="ghost-lbl">+${money(owed)} on the way</small>` : ''}</span>
    </button>
  </div>`;
}
function viewHome() {
  const pend = S.payments.filter(isPending).sort((a, b) => a.created - b.created);
  const mk = monthKey(todayStr());
  const inc = monthIncome(mk), tgt = +S.target || 0;
  const pct = tgt ? Math.min(100, inc / tgt * 100) : 0;
  const left = r2(tgt - inc);
  return `${backupBanner()}
  ${memoryOnly ? '<div class="banner"><span>Storage is blocked — nothing will be kept.</span></div>' : ''}
  ${pend.slice(0, 1).map(p => {
    const st = steps(p), done = st.filter(s => s.done).length;
    return `<a class="card pending" href="#pay/${p.id}">
      <div class="between"><span class="tag-lbl">To split${pend.length > 1 ? ` · ${pend.length} waiting` : ''}</span><span class="small muted">Step ${Math.min(done + 1, st.length)} of ${st.length}</span></div>
      <div class="between" style="margin-top:2px"><b>${esc(p.client || 'Payment')}</b><span class="mid-num">${money(p.amount)}</span></div>
      <div class="seg small-seg">${st.map(s => `<i class="${s.done ? 'on' : ''}"></i>`).join('')}</div>
    </a>`;
  }).join('')}
  ${paidButton(inc, tgt)}
  <div class="card lime">
    <div class="between"><span class="lbl2" style="margin:0">This month</span><span class="small muted">${monthLabel(mk)}</span></div>
    <div class="between" style="margin-top:6px"><span class="big-num">${money(inc)}</span><span class="muted">of ${money(tgt)}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="small muted">${left > 0 ? `${money(left)} to go` : `Target hit${left < 0 ? ` · ${money(-left)} over` : ''}`}</div>
  </div>
  <div class="stats">
    <a class="card stat dark" href="#savings"><div class="lbl">Savings</div><div class="mid-num">${money(savingsTotal())}</div></a>
    <a class="card stat" href="#waiting"><div class="lbl">Owed to you</div><div class="mid-num">${money(owedTotal())}</div></a>
  </div>`;
}

/* ---------- I got paid ---------- */
function newDraft(waitingId) {
  const sp = S.splits.find(s => s.id === S.defaultSplit) || S.splits[0];
  const d = {
    forArg: waitingId || '', amount: '', client: '', tag: S.tags[0] || '', date: todayStr(),
    splitId: sp.id, pcts: { ...sp.pcts }, adjust: false, takeOff: '', waitingId: null, done: waitingId === 'past', editId: null,
  };
  const w = waitingId && S.waiting.find(x => x.id === waitingId);
  if (w) { d.client = w.client; d.amount = String(w.amount); d.waitingId = w.id; }
  return d;
}
function editDraft(id) {
  const p = S.payments.find(x => x.id === id); if (!p) return null;
  const pcts = {}; S.wallets.forEach(w => { pcts[w.id] = +(p.pcts || {})[w.id] || 0; });
  const sp = S.splits.find(s => S.wallets.every(w => (+s.pcts[w.id] || 0) === pcts[w.id]));
  return { amount: String(p.amount), client: p.client || '', tag: p.tag, date: p.date, splitId: sp ? sp.id : null, pcts,
    adjust: !sp, takeOff: p.takeOff ? String(p.takeOff) : '', waitingId: null, done: !isPending(p), editId: p.id };
}
function viewNew() {
  const d = draft, editing = !!d.editId, past = !editing && d.done;
  return `<div class="top"><a href="${editing || past ? '#history' : '#home'}">Cancel</a><span></span></div>
  <h1>${editing ? 'Edit payment' : past ? 'Add a past payment' : 'I got paid'}</h1>
  <form id="payForm" onsubmit="return false" autocomplete="off">
    <label class="fld"><span>Amount received</span>
      <div class="amt-in"><b>$</b><input id="f-amount" inputmode="decimal" value="${esc(d.amount)}" placeholder="0"></div>
    </label>
    <div id="owedNote" class="note"></div>
    ${S.waiting.length && !editing ? `<div class="fld"><span>From Waiting on</span><div class="chips">${S.waiting.map(x =>
      `<button type="button" class="chip ${d.waitingId === x.id ? 'on' : ''}" data-act="pickWaiting" data-id="${x.id}">${esc(x.client)} · ${money(x.amount)}</button>`).join('')}</div></div>` : ''}
    <label class="fld"><span>Client</span><input id="f-client" type="text" list="clientList" value="${esc(d.client)}" placeholder="Who paid"></label>
    <datalist id="clientList">${clients().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="fld"><span>Tag</span><div class="chips">${S.tags.map(t =>
      `<button type="button" class="chip ${d.tag === t ? 'on' : ''}" data-act="pickTag" data-v="${t}">${t}</button>`).join('')}</div></div>
    <label class="fld"><span>Date</span><input id="f-date" type="date" value="${esc(d.date)}"></label>
    <div class="fld"><span>Split</span><div class="chips">${S.splits.map(s =>
      `<button type="button" class="chip ${d.splitId === s.id ? 'on' : ''}" data-act="pickSplit" data-id="${s.id}">${esc(s.name)}</button>`).join('')}
      <button type="button" class="chip ${d.adjust ? 'on' : ''}" data-act="toggleAdjust">Adjust %</button></div>
      ${d.adjust ? `<div class="pcts">${S.wallets.map(w => `<div class="pct"><span>${esc(w.name)}</span>
        <div class="in"><input type="number" inputmode="decimal" data-pct="${w.id}" value="${+d.pcts[w.id] || 0}"></div></div>`).join('')}
        <div class="total" id="pctTotal"></div><div class="small muted">Only for this payment.</div></div>` : ''}
    </div>
    <label class="fld"><span>Prepaid <span style="font-weight:500">(already spent, optional)</span></span>
      <input id="f-take" inputmode="decimal" value="${esc(d.takeOff)}" placeholder="0"></label>
    <button type="button" class="toggle ${d.done ? 'on' : ''}" data-act="toggleDone" aria-pressed="${d.done}"><i></i><span><b>Transfers already done</b><small>For payments you already split before logging them here</small></span></button>
    <h2>Transfers</h2>
    <div class="card" id="preview"></div>
    ${editing ? '<p class="small muted">Changing the amount, prepaid or split recalculates its transfers and starts them over.</p>' : ''}
    <p class="err" id="payErr"></p>
    <button type="button" class="btn primary block" data-act="savePay" style="min-height:54px;font-size:17px">${editing ? 'Save changes' : d.done ? 'Save payment' : 'Split it'}</button>
    ${editing ? `<button type="button" class="btn danger block" data-act="delPay" data-id="${d.editId}" style="margin-top:10px">Delete payment</button>` : ''}
  </form>`;
}
function readForm() {
  const d = draft; if (!d || !$('#payForm')) return;
  d.amount = $('#f-amount').value; d.client = $('#f-client').value; d.date = $('#f-date').value; d.takeOff = $('#f-take').value;
  $$('[data-pct]').forEach(i => { d.pcts[i.dataset.pct] = num(i.value) || 0; });
  if (d.waitingId) { const w = S.waiting.find(x => x.id === d.waitingId); if (!w || w.client !== d.client) d.waitingId = null; }
}
function updatePreview() {
  const d = draft; if (!d) return;
  const amt = num(d.amount), take = d.takeOff === '' ? 0 : num(d.takeOff);
  const tot = pctTotal(d.pcts);
  const pt = $('#pctTotal');
  if (pt) { pt.textContent = `Total ${tot}%${tot === 100 ? '' : ' — must be 100%'}`; pt.className = 'total ' + (tot === 100 ? 'ok' : 'bad'); }
  const w = d.waitingId && S.waiting.find(x => x.id === d.waitingId);
  $('#owedNote').textContent = w && amt > 0 ? (amt < w.amount
    ? `Owed ${money(w.amount)}. ${money(w.amount - amt)} stays on Waiting on.`
    : `Clears ${w.client} from Waiting on.`) : '';
  $$('[data-act=pickWaiting]').forEach(b => b.classList.toggle('on', b.dataset.id === d.waitingId));
  const pv = $('#preview');
  if (!(amt > 0)) { pv.innerHTML = '<div class="empty">Enter the amount to see your transfers.</div>'; return; }
  if (!(take >= 0) || take >= amt) { pv.innerHTML = '<div class="empty">Prepaid has to be less than the amount.</div>'; return; }
  if (tot !== 100) { pv.innerHTML = '<div class="empty">Percentages must add up to 100%.</div>'; return; }
  pv.innerHTML = (take > 0 ? `<div class="kv"><span>Prepaid, already out of Whish</span><span>−${money(take)}</span></div><div class="kv" style="margin-bottom:6px"><span>Split on</span><span>${money(amt - take)}</span></div>` : '')
    + txRows(computeShares(amt, take, d.pcts), false)
    + `<div style="background:var(--white);border-radius:var(--r-sm);margin-top:10px;padding:8px 14px">${appBlock(appTotals([{ shares: computeShares(amt, take, d.pcts), takeOff: take }]), false)}</div>`;
}
function txRows(shares, interactive) {
  const stay = shares.filter(s => s.inbox && s.amount > 0);
  const moves = shares.filter(s => !s.auto);
  return moves.map(s => {
    const i = shares.indexOf(s);
    return `<div class="tx ${s.done ? 'done' : ''}">
      ${interactive ? `<button class="tick" data-act="tick" data-i="${i}" aria-label="${s.done ? 'Mark not moved' : 'Mark moved'}" aria-pressed="${s.done}">${CHECK}</button>` : ''}
      <div class="tx-main"><div class="tx-amt">${money(s.amount)}</div><div class="tx-to">→ ${esc(shareName(s))} · ${esc(shareApp(s))}</div></div>
      ${interactive ? `<button class="btn sm copy" data-act="copy" data-v="${s.amount}">Copy</button>` : `<span class="small muted">${s.pct}%</span>`}
    </div>`;
  }).join('') + stay.map(s => `<div class="tx stay">
      ${interactive ? `<span class="tick" aria-hidden="true">${CHECK}</span>` : ''}
      <div class="tx-main"><div class="tx-amt">${money(s.amount)}</div><div class="tx-to">stays in ${esc(shareApp(s))} · ${esc(shareName(s))}</div></div>
      ${interactive ? '<span class="small muted">auto</span>' : `<span class="small muted">${s.pct}%</span>`}
    </div>`).join('');
}
function savePayment() {
  readForm();
  const d = draft, err = $('#payErr');
  const amt = num(d.amount), take = d.takeOff === '' ? 0 : num(d.takeOff);
  if (!(amt > 0)) return (err.textContent = 'Enter the amount you received.');
  if (!(take >= 0) || take >= amt) return (err.textContent = 'Prepaid has to be less than the amount.');
  if (pctTotal(d.pcts) !== 100) return (err.textContent = 'Percentages must add up to exactly 100%.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return (err.textContent = 'Pick a date.');
  const sp = S.splits.find(s => s.id === d.splitId);
  const same = sp && S.wallets.every(w => (+sp.pcts[w.id] || 0) === (+d.pcts[w.id] || 0));
  const markDone = p => { p.shares.forEach(s => { s.done = true; }); p.hops = p.hops || {}; steps(p).forEach(s => { if (s.type === 'hop') p.hops[s.app] = true; }); };
  if (d.editId) {
    const p = S.payments.find(x => x.id === d.editId); if (!p) return go('history', true);
    const moneyChanged = r2(amt) !== p.amount || r2(take) !== r2(p.takeOff || 0) || pctString(d.pcts) !== pctString(p.pcts || {});
    Object.assign(p, { date: d.date, client: d.client.trim(), tag: d.tag, splitName: sp ? sp.name + (same ? '' : ' (adjusted)') : (moneyChanged ? 'Custom' : p.splitName) });
    if (moneyChanged) {
      Object.assign(p, { amount: r2(amt), takeOff: r2(take), pcts: { ...d.pcts }, pctLabel: pctString(d.pcts), shares: computeShares(amt, take, d.pcts), hops: {}, fees: {}, feeMode: {} });
    }
    if (d.done) markDone(p);
    save(); draft = null; toast(moneyChanged && !d.done ? 'Saved — its transfers start over' : 'Payment updated');
    return go('history', true);
  }
  const p = {
    id: uid(), created: Date.now(), date: d.date, client: d.client.trim(), tag: d.tag,
    amount: r2(amt), takeOff: r2(take), splitName: sp ? sp.name + (same ? '' : ' (adjusted)') : 'Custom',
    pcts: { ...d.pcts }, pctLabel: pctString(d.pcts), shares: computeShares(amt, take, d.pcts),
  };
  if (d.waitingId) {
    const w = S.waiting.find(x => x.id === d.waitingId);
    if (w) {
      p.fromWaiting = { owed: w.amount, added: w.added || tsDate(w.created || Date.now()), expected: w.expected || '' };
      if (amt < w.amount) w.amount = r2(w.amount - amt);
      else S.waiting = S.waiting.filter(x => x !== w);
    }
  }
  if (d.done) markDone(p);
  S.payments.push(p); save(); draft = null;
  go(d.done ? 'history' : 'pay/' + p.id, true);
  if (d.done) toast('Payment added');
}

/* ---------- to split: unlock path ---------- */
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
let justUnlocked = null, justFinished = false;
function feeLabels() {
  const box = $('.fee[data-amt]'), m = $('#feeMode'); if (!box || !m) return;
  const amt = +box.dataset.amt, home = box.dataset.home, app = box.dataset.app;
  const raw = ($('#hopFee') || {}).value || '', fee = raw.trim() === '' ? 0 : num(raw);
  const ok = fee > 0 && fee < amt;
  m.hidden = !ok;
  const [top, inside] = $$('[data-act=feeMode]', m);
  if (ok) { top.textContent = `${home} took ${money(amt + fee)}`; inside.textContent = `${app} got ${money(amt - fee)}`; }
  $('#feeHint').textContent = !ok ? `In dollars. Leave it empty if it’s free.`
    : m.dataset.mode === 'inside' ? `The fee came out of the transfer, so your ${app} wallets get ${money(fee)} less.`
    : `The fee was paid on top, so ${money(fee)} less stays in ${home}.`;
}
function viewPay(id) {
  const p = S.payments.find(x => x.id === id);
  if (!p) return `<div class="top"><a href="#home">← Home</a></div><p class="empty">That payment doesn’t exist anymore.</p>`;
  const st = steps(p), cur = st.find(s => !s.done), all = !cur;
  const lastDone = [...st].reverse().find(s => s.done);
  const n = st.indexOf(cur) + 1, doneN = st.filter(s => s.done).length;
  const inbox = p.shares.find(s => s.inbox);
  const fee = feeTop(p);
  const stay = r2((inbox ? inbox.amount : 0) - fee), home = inbox ? shareApp(inbox) : stayApp();
  const feeNote = fee ? ` after ${money(fee)} fee` : '';
  const finished = S.payments.filter(x => !isPending(x)).sort((a, b) => a.created - b.created);
  const payday = finished.indexOf(p) + 1;
  const pop = justUnlocked, fin = justFinished; justUnlocked = null; justFinished = false;

  const row = s => {
    const hopFee = s.type === 'hop' && p.fees ? +p.fees[s.app] || 0 : 0;
    const inside = s.type === 'hop' && (p.feeMode || {})[s.app] === 'inside';
    const label = s.type === 'hop' ? `${esc(home)} → ${esc(s.app)}${hopFee ? ` · ${money(hopFee)} fee ${inside ? `taken out, ${esc(s.app)} got ${money(s.amount)}` : `on top, ${esc(home)} paid ${money(s.amount + hopFee)}`}` : ''}` : `${esc(shareName(s.s))} <span class="muted">· ${esc(s.app)}</span>`;
    if (s.done) return `<div class="step done">
        <span class="dot ok">${CHECK}</span>
        <div class="step-main"><div class="step-amt">${money(s.amount)}</div><div class="step-to">${label}</div></div>
        ${s === lastDone && !all ? `<button class="btn ghost sm" data-act="step" data-key="${s.key}">Undo</button>` : ''}</div>`;
    if (s === cur) {
      const title = s.type === 'hop' ? `Send to ${esc(s.app)}` : `Move to ${esc(shareName(s.s))}`;
      const sub = s.type === 'hop' ? `From ${esc(home)} · one transfer for ${s.wallets.length} wallet${s.wallets.length > 1 ? 's' : ''}` : `Inside ${esc(s.app)}`;
      return `<div class="step current ${pop === s.key ? 'pop' : ''}">
        <div class="step-kicker">Step ${n} of ${st.length}${pop === s.key ? ' · unlocked' : ''}</div>
        <div class="step-title">${title}</div>
        <div class="hero-amt">${money(s.amount)}</div>
        <div class="step-to">${sub}</div>
        <div class="btns" style="margin-top:14px">
          <button class="btn sm" data-act="copy" data-v="${s.amount}">Copy amount</button>
        </div>
        ${s.type === 'hop' ? (() => {
          const saved = p.fees && p.fees[s.app] != null ? p.fees[s.app] : '', last = lastFee(s.app);
          const mode = (p.feeMode || {})[s.app] || lastFeeMode(s.app);
          return `<div class="fee" data-amt="${s.amount}" data-home="${esc(home)}" data-app="${esc(s.app)}">
            <label for="hopFee">Transfer fee</label>
            <div class="fee-in"><b>$</b><input id="hopFee" inputmode="decimal" placeholder="0" value="${saved === 0 ? '' : esc(saved)}" autocomplete="off"></div>
            ${last && saved === '' ? `<button type="button" class="chip" data-act="feeLast" data-v="${last}">Last time ${money(last)}</button>` : ''}
          </div>
          <div class="fee-mode" id="feeMode" data-mode="${mode}">
            <button type="button" class="chip ${mode === 'top' ? 'on' : ''}" data-act="feeMode" data-v="top"></button>
            <button type="button" class="chip ${mode === 'inside' ? 'on' : ''}" data-act="feeMode" data-v="inside"></button>
          </div>
          <p class="fee-hint" id="feeHint"></p>`;
        })() : ''}
        <button class="btn primary block moved" data-act="step" data-key="${s.key}">${CHECK}<span>Moved it</span></button>
      </div>`;
    }
    return `<div class="step locked"><span class="dot">${LOCK}</span>
      <div class="step-main"><div class="step-amt">$•••</div><div class="step-to">${label}</div></div></div>`;
  };

  return `<div class="top"><a href="#home">← Home</a><span class="small muted">${dateLabel(p.date)}</span></div>
  <div class="between" style="margin:8px 0 2px"><h1 style="margin:0">${esc(p.client || 'Payment')}</h1><span class="mid-num">${money(p.amount)}</span></div>
  <p class="small muted">${esc(p.tag)} · ${esc(p.splitName)}${p.takeOff ? ` · ${money(p.takeOff)} prepaid · already left ${esc(home)}` : ''}</p>
  <div class="seg">${st.map(s => `<i class="${s.done ? 'on' : ''} ${s === cur ? 'cur' : ''}"></i>`).join('')}</div>
  <div class="small muted" style="margin-bottom:12px">${all ? 'All moved' : `${doneN} of ${st.length} done`}</div>
  ${all ? `<div class="done-block ${fin ? 'celebrate' : ''}">
      <div class="burst">${Array.from({ length: 12 }, (_, i) => `<i style="--a:${i * 30}deg"></i>`).join('')}<div class="ok-ic">${CHECK}</div></div>
      <p class="muted" style="margin:0">Paid yourself first${payday ? ` · payday #${payday}` : ''}</p>
      <div class="big-num">${money(stay)}</div>
      <p class="muted">stays in ${esc(home)} for essentials${feeNote}</p>
    </div>` : ''}
  <div class="steps">${st.map(row).join('')}</div>
  ${stay ? `<div class="step stay"><span class="dot ok">${CHECK}</span>
    <div class="step-main"><div class="step-amt">${money(stay)}</div><div class="step-to">stays in ${esc(home)}${feeNote} · nothing to do</div></div></div>` : ''}
  ${all ? '<a class="btn primary block" href="#home" style="text-align:center;text-decoration:none;line-height:22px;margin-top:16px">Done</a>' : '<p class="small muted" style="margin-top:12px">Each move unlocks the next. This stays on Home until the last one.</p>'}
  <div class="btns" style="margin-top:18px"><a class="btn block" href="#edit/${p.id}" style="text-align:center;text-decoration:none;flex:1">Edit payment</a></div>
  <button class="btn danger block" data-act="delPay" data-id="${p.id}" style="margin-top:8px">Delete payment</button>`;
}

/* ---------- savings ---------- */
function viewSavings() {
  const total = savingsTotal(), floor = +S.floor || 0, free = Math.max(0, total - floor);
  const pend = savingsPending();
  const goalSum = S.goals.reduce((a, g) => a + (+g.amount || 0), 0);
  const scale = Math.max(total, floor + goalSum, floor, 1) * (total >= floor + goalSum ? 1.06 : 1);
  const at = v => Math.max(0, Math.min(100, v / scale * 100));
  let cum = floor;
  const marks = [{ x: at(floor), label: 'Floor' }];
  S.goals.forEach(g => { cum += +g.amount || 0; marks.push({ x: at(cum), label: g.name }); });
  let before = 0;
  const goalRows = S.goals.map(g => {
    const a = +g.amount || 0, filled = Math.max(0, Math.min(a, free - before)); before += a;
    return `<div class="item"><div class="between"><b>${esc(g.name)}</b><span class="small ${filled >= a ? '' : 'muted'}">${filled >= a ? 'Covered' : `${money(filled)} of ${money(a)}`}</span></div></div>`;
  }).join('');
  const wds = [...S.withdrawals].sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));
  return `<h1>Savings</h1>
  <div class="card">
    <div class="big-num">${money(total)}</div>
    <button class="start-line" data-act="startEdit">${+S.startSavings ? `Includes ${money(S.startSavings)} you had before BROKE · <u>Edit</u>` : 'Had savings before BROKE? <u>Add them</u>'}</button>
    <div class="bar" style="margin-top:14px">
      <i class="floor" style="width:${at(Math.min(total, floor))}%"></i>
      ${total > floor ? `<i style="left:${at(floor)}%;width:${at(total) - at(floor)}%;border-radius:0 999px 999px 0"></i>` : ''}
      ${marks.map(m => `<span class="mk" style="left:calc(${m.x}% - 1px)"></span>`).join('')}
    </div>
    <div class="marks">${marks.map((m, i) => `<span class="${i % 2 ? 'alt' : ''}" style="left:${Math.min(92, Math.max(6, m.x))}%">${esc(m.label)}</span>`).join('')}</div>
    ${total < floor
      ? `<p><b>Emergency floor:</b> ${money(total)} of ${money(floor)} · ${money(floor - total)} to go</p>`
      : `<p><b>Emergency floor full.</b> Free savings above it: <b>${money(free)}</b></p>`}
    ${pend > 0 ? `<p class="small muted">${money(pend)} more is waiting to be ticked on unfinished payments.</p>` : ''}
  </div>
  <button class="btn block" data-act="withdrawSheet">Take from savings</button>
  ${S.goals.length ? `<h2>Goals</h2><div class="card">${goalRows}</div>` : '<p class="small muted" style="margin-top:12px">Add goals like “Car $1,500” in Splits → Savings.</p>'}
  <h2>Taken out</h2>
  <div class="card">${wds.length ? wds.map(w => `<div class="item between">
      <div><b>${money(w.amount)}</b> <span class="muted">· ${esc(w.reason || 'No reason')}</span><div class="small muted">${dateLabel(w.date)}${w.kind ? ` · ${esc(w.kind)}` : ''}</div></div>
      <button class="btn ghost sm" data-act="delWithdraw" data-id="${w.id}" aria-label="Delete">Delete</button></div>`).join('')
      : '<div class="empty">Nothing taken out.</div>'}</div>`;
}
/* Taking money out is allowed, but it costs a moment: pick what it's for, read what it undoes,
   then hold the button. Wants hold longest; dipping under the emergency floor adds time. */
const KINDS = [
  { id: 'emergency', label: 'Emergency', hold: 1.5 },
  { id: 'need', label: 'Need', hold: 3 },
  { id: 'want', label: 'Want', hold: 6 },
];
let wd = null;
function avgSavedPerPayday() {
  const amts = S.payments.map(p => p.shares.filter(s => s.savings && s.done).reduce((a, s) => a + s.amount, 0)).filter(a => a > 0);
  return amts.length ? amts.reduce((a, b) => a + b, 0) / amts.length : 0;
}
function withdrawSheet() {
  wd = { kind: null, holding: false };
  openSheet(`<h3>Take from savings</h3>
    <label class="fld"><span>Amount</span><input id="wd-amt" inputmode="decimal" placeholder="0"></label>
    <div class="fld"><span>What is it?</span><div class="chips">${KINDS.map(k =>
      `<button type="button" class="chip" data-act="wdKind" data-v="${k.id}">${k.label}</button>`).join('')}</div></div>
    <label class="fld"><span>Reason</span><input id="wd-reason" type="text" placeholder="Car repair"></label>
    <label class="fld"><span>Date</span><input id="wd-date" type="date" value="${todayStr()}" data-nofocus="1"></label>
    <div class="reality" id="wd-real"></div>
    <p class="err" id="wd-err"></p>
    <button type="button" class="btn block hold" id="wd-hold"><span class="hold-fill"></span><span class="hold-txt" id="wd-hold-txt">Hold to take it out</span></button>
    <p class="small muted" id="wd-hint" style="text-align:center;margin-top:8px"></p>
    <button class="btn ghost block" data-act="closeSheet">Never mind</button>`, wdUpdate);
  wdUpdate();
}
function wdHoldSecs(amt) {
  const k = KINDS.find(x => x.id === wd.kind); if (!k) return 0;
  return k.hold + (savingsTotal() - amt < (+S.floor || 0) ? 1.5 : 0);
}
function wdUpdate() {
  if (!wd || !$('#wd-real')) return;
  const amt = num($('#wd-amt').value), total = savingsTotal(), floor = +S.floor || 0;
  $$('[data-act=wdKind]').forEach(b => b.classList.toggle('on', b.dataset.v === wd.kind));
  const lines = [];
  if (amt > 0) {
    const after = r2(total - amt), avg = avgSavedPerPayday();
    lines.push(`Savings goes <b>${money(total)}</b> → <b>${money(after)}</b>`);
    if (avg > 0) { const n = amt / avg; lines.push(`That’s <b>${n < 1 ? 'less than one payday' : `${n.toFixed(n < 10 ? 1 : 0).replace(/\.0$/, '')} paydays`}</b> of saving`); }
    if (after < floor && total >= floor) lines.push(`<span class="warn-t">Cuts ${money(floor - after)} into your emergency floor</span>`);
    else if (after < floor) lines.push(`<span class="warn-t">You’re already under the floor — this takes it to ${money(after)}</span>`);
    if (wd.kind === 'want') lines.push(`Wants get the longest hold. Still want it after ${wdHoldSecs(amt)} seconds?`);
  }
  $('#wd-real').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  $('#wd-real').hidden = !lines.length;
  const secs = wdHoldSecs(amt > 0 ? amt : 0);
  $('#wd-hold-txt').textContent = amt > 0 ? `Hold to take ${money(amt)} out` : 'Hold to take it out';
  $('#wd-hint').textContent = secs ? `Hold for ${secs} seconds` : 'Pick what it is first';
}
function wdValid() {
  const amt = num($('#wd-amt').value), err = $('#wd-err');
  err.textContent = '';
  if (!(amt > 0)) return (err.textContent = 'Enter an amount.'), false;
  if (amt > savingsTotal()) return (err.textContent = `That’s more than your savings (${money(savingsTotal())}).`), false;
  if (!wd.kind) return (err.textContent = 'Pick emergency, need, or want.'), false;
  if (!$('#wd-date').value) return (err.textContent = 'Pick a date.'), false;
  return true;
}
function wdCommit() {
  const amt = num($('#wd-amt').value);
  S.withdrawals.push({ id: uid(), created: Date.now(), date: $('#wd-date').value, amount: r2(amt), kind: wd.kind, reason: $('#wd-reason').value.trim() });
  wd = null; save(); closeSheet(); render(); toast(`Took ${money(amt)} from savings`);
}
let holdRaf = null;
function holdStart(e) {
  if (!wd || wd.holding || !wdValid()) return;
  e && e.preventDefault();
  const btn = $('#wd-hold'), ms = wdHoldSecs(num($('#wd-amt').value)) * 1000, t0 = performance.now();
  wd.holding = true; btn.classList.add('holding');
  const tick = () => {
    if (!wd || !wd.holding) return clearInterval(holdRaf);
    const now = performance.now(), p = Math.min(1, (now - t0) / ms);
    btn.style.setProperty('--p', p);
    const left = Math.ceil((ms - (now - t0)) / 1000);
    $('#wd-hold-txt').textContent = p < 1 ? `Keep holding… ${left}` : 'Done';
    if (p >= 1) { clearInterval(holdRaf); wd.holding = false; try { navigator.vibrate && navigator.vibrate(30); } catch (er) {} wdCommit(); }
  };
  holdRaf = setInterval(tick, 30);
}
function holdStop() {
  if (!wd || !wd.holding) return;
  wd.holding = false; clearInterval(holdRaf);
  const btn = $('#wd-hold'); btn.classList.remove('holding'); btn.style.setProperty('--p', 0);
  $('#wd-hint').textContent = 'Let go early — it’s still saved.';
  setTimeout(() => { if (wd && !wd.holding) wdUpdate(); }, 1600);
}

/* ---------- waiting on ---------- */
/* Client memory: learned from debts that were paid through "Got paid". */
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 864e5);
const tsDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (d, n) => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() + n); return tsDate(x.getTime()); };
const ckey = c => String(c || '').trim().toLowerCase();
function clientStats(name) {
  const ps = S.payments.filter(p => p.fromWaiting && p.fromWaiting.added && ckey(p.client) === ckey(name) && ckey(name));
  if (!ps.length) return null;
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const days = ps.map(p => Math.max(0, dayDiff(p.fromWaiting.added, p.date)));
  const late = ps.filter(p => p.fromWaiting.expected).map(p => dayDiff(p.fromWaiting.expected, p.date));
  return { n: ps.length, days: Math.round(avg(days)), late: late.length ? Math.round(avg(late)) : null };
}
function statLine(st) {
  if (!st) return '';
  const lateTxt = st.late == null ? '' : st.late > 2 ? ` · ~${st.late} days late` : st.late < -1 ? ' · usually early' : ' · usually on time';
  return `Usually pays in ~${st.days} day${st.days === 1 ? '' : 's'}${lateTxt}`;
}
function viewWaiting() {
  const list = [...S.waiting].sort((a, b) => (a.expected || '9999').localeCompare(b.expected || '9999'));
  const today = todayStr();
  const owed = owedTotal(), mk = monthKey(today), inc = monthIncome(mk), tgt = +S.target || 0;
  const sp = S.splits.find(x => x.id === S.defaultSplit) || S.splits[0];
  const pctOf = f => S.wallets.filter(f).reduce((a, w) => a + (+sp.pcts[w.id] || 0), 0);
  const home = stayApp();
  const toNeo = Math.round(owed * pctOf(w => w.app !== home) / 100), toSav = Math.round(owed * pctOf(w => w.savings) / 100);
  const land = r2(inc + owed), barMax = Math.max(tgt, land, 1);
  return `<h1>Waiting on</h1>
  <div class="card">
    <div class="between"><div><div class="lbl2" style="margin:0">Total owed</div><div class="big-num">${money(owed)}</div></div>
      <button class="btn" data-act="waitSheet">Add</button></div>
    ${owed > 0 ? `<div class="ifpay">
      <div class="lbl2" style="margin:14px 0 6px">If everyone pays</div>
      <div class="gbar"><i style="width:${inc / barMax * 100}%"></i><i class="g" style="width:${owed / barMax * 100}%"></i>${tgt ? `<span class="mk" style="left:${tgt / barMax * 100}%"></span>` : ''}</div>
      <p style="margin:8px 0 2px">${monthLabel(mk).split(' ')[0]} lands at <b>${money(land)}</b>${tgt ? ` — ${land >= tgt ? `<b>target hit</b>${land > tgt ? ` (+${money(land - tgt)})` : ''}` : `${Math.round(land / tgt * 100)}% of target`}` : ''}</p>
      <p class="small muted" style="margin:0">≈ ${money(toNeo)} to Neo · ${money(toSav)} into savings</p>
    </div>` : ''}
  </div>
  ${list.length ? `<div class="card">${list.map(w => `<div class="item">
      <div class="between"><b>${esc(w.client)}</b><span class="mid-num">${money(w.amount)}</span></div>
      <div class="small muted">${w.expected ? `${w.expected < today ? '<span class="pill warn">Late</span> ' : ''}Expected ${dateLabel(w.expected)}` : 'No date'}${w.note ? ' · ' + esc(w.note) : ''}</div>
      ${(() => {
        const st = clientStats(w.client); if (!st) return '';
        const added = w.added || tsDate(w.created || Date.now());
        const likely = w.expected ? (st.late > 2 ? addDays(w.expected, st.late) : null) : addDays(added, st.days);
        return `<div class="memory">${statLine(st)}${likely ? ` · realistically <b>${dateLabel(likely)}</b>` : ''}</div>`;
      })()}
      <div class="btns" style="margin-top:8px">
        <button class="btn primary sm" data-act="gotPaidFrom" data-id="${w.id}">Got paid</button>
        <button class="btn sm" data-act="waitSheet" data-id="${w.id}">Edit</button>
        <button class="btn ghost sm" data-act="delWait" data-id="${w.id}">Delete</button>
      </div></div>`).join('')}</div>` : '<p class="empty">Nobody owes you right now.</p>'}`;
}
function waitSheet(id) {
  const w = id ? S.waiting.find(x => x.id === id) : { client: '', amount: '', expected: '', note: '' };
  openSheet(`<h3>${id ? 'Edit' : 'Who owes you'}</h3>
    <label class="fld"><span>Client</span><input id="wt-client" type="text" value="${esc(w.client)}" list="clientList2" placeholder="Client name"></label>
    <datalist id="clientList2">${clients().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label class="fld"><span>Amount</span><input id="wt-amt" inputmode="decimal" value="${esc(w.amount)}" placeholder="0"></label>
    <label class="fld"><span>Expected date (optional)</span><input id="wt-date" type="date" value="${esc(w.expected || '')}"></label>
    <div id="wt-memory" class="memory" style="margin:-8px 0 14px"></div>
    <label class="fld"><span>Note (optional)</span><input id="wt-note" type="text" value="${esc(w.note || '')}" placeholder="Invoice #12"></label>
    <p class="err" id="wt-err"></p>
    <div class="btns"><button class="btn primary block" data-act="saveWait" data-id="${id || ''}">Save</button><button class="btn block" data-act="closeSheet">Cancel</button></div>`, wtMemory);
  wtMemory();
}
function wtMemory() {
  const el = $('#wt-memory'); if (!el) return;
  const st = clientStats($('#wt-client').value);
  if (!st) { el.innerHTML = ''; return; }
  const guess = addDays(todayStr(), st.days);
  el.innerHTML = `${esc(statLine(st))}${$('#wt-date').value ? '' : ` <button type="button" class="chip" data-act="wtUseGuess" data-v="${guess}" style="margin-left:4px;min-height:30px;padding:4px 10px">Expect ${dateLabel(guess)}</button>`}`;
}

/* ---------- history ---------- */
let openMonths = null;
function viewHistory() {
  const months = [...new Set([...S.payments.map(p => monthKey(p.date)), ...S.withdrawals.map(w => monthKey(w.date))])].sort().reverse();
  if (!openMonths) openMonths = new Set(months.slice(0, 1));
  const year = String(new Date().getFullYear());
  const yp = S.payments.filter(p => p.date.startsWith(year));
  const t = appTotals(yp), home = stayApp();
  const out = r2(Object.keys(t).filter(a => a !== home).reduce((a, k) => a + t[k], 0));
  return `<h1>History</h1>
  <button class="btn block" data-act="addPast" style="margin:-6px 0 12px">+ Add a past payment</button>
  ${months.length ? `<div class="card">
    <div class="between"><span class="lbl2" style="margin:0">${year} so far</span><span class="small muted">${yp.length} payment${yp.length === 1 ? '' : 's'}</span></div>
    <div class="big-num" style="margin:4px 0 12px">${money(yp.reduce((a, p) => a + p.amount, 0))}</div>
    <div class="mini3">
      <div><span>To Neo</span><b>${money(out)}</b></div>
      <div><span>Stays in ${esc(home)}</span><b>${money(t[home] || 0)}</b></div>
      <div><span>Paydays</span><b>${yp.length}</b></div>
    </div></div>
  ${months.map(monthSection).join('')}
  <h2>Export</h2>
  <div class="btns"><button class="btn sm" data-act="copySheet">Copy for Sheets</button><button class="btn sm" data-act="csv">Download CSV</button></div>`
  : '<p class="empty">Nothing here yet. Log a payment with “I got paid”.</p>'}`;
}
function monthSection(m) {
  const pays = sortedPayments().filter(p => monthKey(p.date) === m);
  const wds = S.withdrawals.filter(w => monthKey(w.date) === m).sort((a, b) => b.date.localeCompare(a.date));
  const tot = r2(pays.reduce((a, p) => a + p.amount, 0));
  const t = appTotals(pays), home = stayApp();
  const out = r2(Object.keys(t).filter(a => a !== home).reduce((a, k) => a + t[k], 0));
  const byTag = [...new Set([...S.tags, ...pays.map(p => p.tag).filter(Boolean)])].map(tag => [tag, r2(pays.filter(p => p.tag === tag).reduce((a, p) => a + p.amount, 0))]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  return `<details class="month" data-m="${m}" ${openMonths.has(m) ? 'open' : ''}>
    <summary>
      <div class="between"><b class="month-name">${monthLabel(m)}</b><span class="mid-num">${money(tot)}</span></div>
      <div class="small muted">${pays.length} payment${pays.length === 1 ? '' : 's'}${wds.length ? ` · ${money(wds.reduce((a, w) => a + w.amount, 0))} out of savings` : ''}</div>
    </summary>
    <div class="month-body">
      ${pays.length ? `<div class="mini3">
        <div><span>To Neo</span><b>${money(out)}</b></div>
        <div><span>Stays in ${esc(home)}</span><b>${money(t[home] || 0)}</b></div>
        <div><span>Biggest</span><b>${money(Math.max(...pays.map(p => p.amount)))}</b></div>
      </div>` : ''}
      ${byTag.length > 1 ? `<div class="tagbar">${byTag.map(([tag, v]) => `<i style="flex:${v}" title="${tag}"></i>`).join('')}</div>
        <div class="taglegend">${byTag.map(([tag, v]) => `<span>${tag} <b>${money(v)}</b></span>`).join('')}</div>` : ''}
      ${pays.map(p => `<button class="prow" data-act="payDetail" data-id="${p.id}">
          <span class="pd">${new Date(p.date + 'T00:00').getDate()}</span>
          <span class="pc"><b>${esc(p.client || 'Payment')}</b><small>${esc(p.tag)}${isPending(p) ? ' · <em>to split</em>' : ''}</small></span>
          <span class="pa">${money(p.amount)}</span></button>`).join('')}
      ${wds.map(w => `<div class="prow out">
          <span class="pd">${new Date(w.date + 'T00:00').getDate()}</span>
          <span class="pc"><b>Savings out</b><small>${esc([w.kind, w.reason].filter(Boolean).join(' · ') || 'No reason')}</small></span>
          <span class="pa">${money(-w.amount)}</span></div>`).join('')}
    </div>
  </details>`;
}
function payDetail(id) {
  const p = S.payments.find(x => x.id === id); if (!p) return;
  const t = appTotals([p]);
  openSheet(`<div class="between"><h3 style="margin:0">${esc(p.client || 'Payment')}</h3><span class="mid-num">${money(p.amount)}</span></div>
    <p class="small muted" style="margin:4px 0 14px">${dateLabel(p.date)} · ${esc(p.tag)} · ${isPending(p) ? 'to split' : 'all moved'}</p>
    <div class="card">
      ${p.takeOff ? `<div class="kv"><span>Prepaid · left ${esc((p.shares.find(s => s.inbox) ? shareApp(p.shares.find(s => s.inbox)) : stayApp()))}</span><span>−${money(p.takeOff)}</span></div>` : ''}
      <div class="kv"><span>Split</span><span>${esc(p.splitName)} · ${esc(p.pctLabel || '')}</span></div>
      ${p.shares.filter(s => s.amount).map(s => `<div class="kv"><span>${esc(shareName(s))}</span><span>${money(s.amount)}${s.done ? '' : ' · not moved'}</span></div>`).join('')}
      <div style="background:var(--white);border-radius:var(--r-sm);margin-top:10px;padding:8px 14px">${appBlock(t, false)}</div>
    </div>
    ${feeTotal(p) ? `<p class="small muted" style="margin:8px 4px 0">Transfer fees: ${Object.entries(p.fees).filter(([, v]) => +v).map(([a, v]) => `${money(v)} ${(p.feeMode || {})[a] === 'inside' ? `taken out of ${esc(a)}` : 'paid on top'}`).join(', ')}</p>` : ''}
    <div class="btns" style="margin-top:12px">
      <button class="btn primary block" data-act="editPay" data-id="${p.id}">Edit</button>
      <a class="btn block" href="#pay/${p.id}" style="text-align:center;text-decoration:none;line-height:22px">${isPending(p) ? 'Continue transfers' : 'See transfers'}</a>
      <button class="btn danger block" data-act="delPay" data-id="${p.id}">Delete payment</button>
    </div>`);
}

/* ---------- export ---------- */
function exportRows() {
  const cols = []; const label = {};
  S.wallets.forEach(w => { cols.push(w.id); label[w.id] = w.name; });
  S.payments.forEach(p => p.shares.forEach(s => { if (!label[s.walletId]) { cols.push(s.walletId); label[s.walletId] = s.name; } }));
  const expApps = appKeys(appTotals(S.payments));
  const rows = [['Payments'],
    ['Date', 'Client', 'Tag', 'Amount', 'Prepaid', 'Split amount', 'Split used', 'Percentages', ...cols.map(c => label[c]), ...expApps.map(appLabel), 'Transfer fees', 'Status']];
  [...S.payments].sort((a, b) => (a.date + a.created).localeCompare(b.date + b.created)).forEach(p => {
    const by = {}; p.shares.forEach(s => { by[s.walletId] = r2((by[s.walletId] || 0) + s.amount); });
    rows.push([p.date, p.client, p.tag, p.amount, p.takeOff || 0, r2(p.amount - (p.takeOff || 0)), p.splitName, p.pctLabel || '',
      ...cols.map(c => by[c] ?? 0), ...expApps.map(a => appTotals([p])[a] || 0), feeTotal(p), isPending(p) ? 'to split' : 'done']);
  });
  rows.push([], ['Savings withdrawals'], ['Date', 'Amount', 'Kind', 'Reason']);
  [...S.withdrawals].sort((a, b) => a.date.localeCompare(b.date)).forEach(w => rows.push([w.date, w.amount, w.kind || '', w.reason || '']));
  rows.push([], ['Waiting on'], ['Client', 'Amount', 'Expected', 'Note']);
  S.waiting.forEach(w => rows.push([w.client, w.amount, w.expected || '', w.note || '']));
  return rows;
}
const toTSV = rows => rows.map(r => r.map(c => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
const toCSV = rows => rows.map(r => r.map(c => { const s = String(c ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');

/* ---------- backup ---------- */
async function backup() {
  const stamp = new Date().toISOString();
  const text = JSON.stringify({ app: 'BROKE', version: 1, exported: stamp, data: S }, null, 2);
  const ok = await downloadFile(`broke-backup-${todayStr()}.json`, text, 'application/json');
  if (ok) { S.lastBackup = Date.now(); save(); render(); toast('Backup saved'); }
}
function restorePicked(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { const j = JSON.parse(reader.result); data = j && j.data ? j.data : j; if (!data || !Array.isArray(data.wallets) || !Array.isArray(data.payments)) throw 0; }
    catch (e) { toast('That file isn’t a BROKE backup'); return; }
    confirmSheet('Replace everything?',
      `This replaces all current data with the backup (${data.payments.length} payments, ${(data.waiting || []).length} on Waiting on). It can’t be undone.`,
      'Replace with backup', () => { S = migrate(data); S.lastBackup = Date.now(); save(); go('home'); toast('Restored'); });
  };
  reader.onerror = () => toast('Couldn’t read that file');
  reader.readAsText(file);
}

/* ---------- splits / settings ---------- */
function viewSplits() {
  return `<h1>Splits</h1>
  <h2>Wallets</h2>
  <div class="card">${S.wallets.map((w, i) => `<div class="wrow">
      <div class="g"><input type="text" value="${esc(w.name)}" data-wf="name" data-id="${w.id}" aria-label="Wallet name">
        <select data-wf="app" data-id="${w.id}" aria-label="App">${APPS.map(a => `<option ${w.app === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
      <div class="between">
        <div class="wflags">
          <label><input type="radio" name="inbox" data-wf="inbox" data-id="${w.id}" ${w.inbox ? 'checked' : ''}> Inbox</label>
          <label><input type="radio" name="savings" data-wf="savings" data-id="${w.id}" ${w.savings ? 'checked' : ''}> Savings</label>
        </div>
        <div class="btns">
          <button class="btn ghost sm" data-act="wMove" data-i="${i}" data-d="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost sm" data-act="wMove" data-i="${i}" data-d="1" aria-label="Move down" ${i === S.wallets.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn ghost sm" data-act="wDel" data-id="${w.id}">Delete</button>
        </div>
      </div></div>`).join('')}
    <button class="btn sm" data-act="wAdd" style="margin-top:8px">Add wallet</button>
  </div>
  <p class="small muted">Inbox = where payments land; its share stays put. Savings = counted in your savings total and gets the rounding remainder.</p>

  <h2>Saved splits</h2>
  <div class="card">${S.splits.map(s => `<div class="item">
      <div class="between"><b>${esc(s.name)}</b>${s.id === S.defaultSplit ? '<span class="pill acc">Default</span>' : ''}</div>
      <div class="small muted">${S.wallets.map(w => `${esc(w.name)} ${+s.pcts[w.id] || 0}%`).join(' · ')}</div>
      ${pctTotal(s.pcts) !== 100 ? `<div class="small" style="color:var(--danger)">Adds up to ${pctTotal(s.pcts)}% — edit to fix</div>` : ''}
      <div class="btns" style="margin-top:8px">
        <button class="btn sm" data-act="splitSheet" data-id="${s.id}">Edit</button>
        ${s.id !== S.defaultSplit ? `<button class="btn ghost sm" data-act="splitDefault" data-id="${s.id}">Make default</button>
        <button class="btn ghost sm" data-act="splitDel" data-id="${s.id}">Delete</button>` : ''}
      </div></div>`).join('')}
    <button class="btn sm" data-act="splitSheet" style="margin-top:8px">Add split</button>
  </div>

  <h2>Savings</h2>
  <div class="card">
    <label class="fld"><span>Emergency floor</span><input inputmode="decimal" data-set="floor" value="${S.floor}"></label>
    <label class="fld"><span>Already saved before BROKE</span><input inputmode="decimal" data-set="startSavings" value="${S.startSavings || 0}"></label>
    <span class="lbl2">Goals (filled in order, above the floor)</span>
    ${S.goals.map(g => `<div class="goal-row">
      <input type="text" value="${esc(g.name)}" data-goal="name" data-id="${g.id}" aria-label="Goal name">
      <input inputmode="decimal" value="${g.amount}" data-goal="amount" data-id="${g.id}" aria-label="Goal amount">
      <button class="btn ghost sm" data-act="goalDel" data-id="${g.id}" aria-label="Delete goal">✕</button></div>`).join('')}
    <button class="btn sm" data-act="goalAdd">Add goal</button>
  </div>

  <h2>Tags</h2>
  <div class="card">
    ${S.tags.map((t, i) => `<div class="goal-row tag-row">
      <input type="text" value="${esc(t)}" data-tagi="${i}" aria-label="Tag name">
      <span class="small muted">${S.payments.filter(p => p.tag === t).length} used</span>
      <button class="btn ghost sm" data-act="tagDel" data-i="${i}" aria-label="Delete tag">✕</button></div>`).join('')}
    <button class="btn sm" data-act="tagAdd">Add tag</button>
    <p class="small muted" style="margin:10px 0 0">Renaming a tag renames it on past payments too. Deleting one keeps it on past payments.</p>
  </div>

  <h2>This month</h2>
  <div class="card"><label class="fld" style="margin:0"><span>Monthly income target</span><input inputmode="decimal" data-set="target" value="${S.target}"></label></div>

  <h2 id="sync">Google Sheets</h2>
  <div class="card" id="syncCard"></div>

  <h2 id="data">Data</h2>
  <div class="card">
    <p class="small muted">${S.lastBackup ? `Last backup ${new Date(S.lastBackup).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Never backed up'}. The backup file is yours to keep anywhere.</p>
    <div class="btns"><button class="btn sm" data-act="backup">Back up (JSON)</button><button class="btn sm" data-act="restore">Restore</button></div>
  </div>
  <p class="small muted" id="appVersion" style="text-align:center;margin:20px 0 4px">BROKE</p>`;
}
function splitSheet(id) {
  const s = id ? S.splits.find(x => x.id === id) : null;
  const base = s || S.splits.find(x => x.id === S.defaultSplit) || S.splits[0];
  editing = { id: s ? s.id : null, name: s ? s.name : '', pcts: { ...base.pcts } };
  openSheet(`<h3>${s ? 'Edit split' : 'New split'}</h3>
    <label class="fld"><span>Name</span><input id="sp-name" type="text" value="${esc(editing.name)}" placeholder="Slow month"></label>
    <div class="pcts">${S.wallets.map(w => `<div class="pct"><span>${esc(w.name)}</span>
      <div class="in"><input type="number" inputmode="decimal" data-spct="${w.id}" value="${+editing.pcts[w.id] || 0}" data-nofocus="1"></div></div>`).join('')}</div>
    <div class="total" id="sp-total"></div>
    <div class="btns" style="margin-top:16px"><button class="btn primary block" id="sp-save" data-act="splitSave">Save</button><button class="btn block" data-act="closeSheet">Cancel</button></div>`,
    splitSheetInput);
  splitSheetInput();
}
let editing = null;
function splitSheetInput() {
  if (!editing) return;
  editing.name = $('#sp-name').value;
  $$('[data-spct]').forEach(i => { editing.pcts[i.dataset.spct] = num(i.value) || 0; });
  const t = pctTotal(editing.pcts), ok = t === 100 && editing.name.trim();
  const el = $('#sp-total');
  el.textContent = `Total ${t}%` + (t === 100 ? '' : ' — must be exactly 100%');
  el.className = 'total ' + (t === 100 ? 'ok' : 'bad');
  $('#sp-save').disabled = !ok;
}

/* ---------- actions ---------- */
const ACT = {
  closeSheet,
  confirmOk() { const f = pendingConfirm; pendingConfirm = null; closeSheet(); f && f(); },
  newPay(el) {
    draft = null;
    if (el.classList.contains('jar') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (el.classList.contains('go')) return;
      el.classList.add('go');
      try { navigator.vibrate && navigator.vibrate(18); } catch (e) {}
      setTimeout(() => go('new'), 380);
    } else go('new');
  },
  pickTag(el) { readForm(); draft.tag = el.dataset.v; render(); },
  pickSplit(el) { readForm(); const s = S.splits.find(x => x.id === el.dataset.id); draft.splitId = s.id; draft.pcts = { ...s.pcts }; render(); },
  toggleAdjust() { readForm(); draft.adjust = !draft.adjust; render(); },
  toggleDone() { readForm(); draft.done = !draft.done; render(); },
  addPast() { draft = null; go('new/past'); },
  editPay(el) { closeSheet(); draft = null; go('edit/' + el.dataset.id); },
  pickWaiting(el) {
    readForm(); const w = S.waiting.find(x => x.id === el.dataset.id);
    if (draft.waitingId === w.id) { draft.waitingId = null; } else { draft.waitingId = w.id; draft.client = w.client; draft.amount = String(w.amount); }
    render();
  },
  savePay: savePayment,
  step(el) {
    const id = location.hash.split('/')[1]; const p = S.payments.find(x => x.id === id); if (!p) return;
    const st = steps(p), k = el.dataset.key;
    const cur = st.find(s => !s.done), last = [...st].reverse().find(s => s.done);
    const set = (s, v) => { if (s.type === 'hop') p.hops[s.app] = v; else p.shares[s.i].done = v; };
    if (cur && cur.key === k) {
      if (cur.type === 'hop') {
        const raw = ($('#hopFee') || {}).value || '', fee = raw.trim() === '' ? 0 : num(raw);
        if (!(fee >= 0)) return toast('Enter the fee as a number, or leave it empty');
        if (fee >= cur.amount) return toast('That fee is bigger than the transfer');
        const mode = ($('#feeMode') || {}).dataset ? $('#feeMode').dataset.mode : 'top';
        p.fees = p.fees || {}; p.feeMode = p.feeMode || {};
        p.fees[cur.app] = r2(fee); p.feeMode[cur.app] = mode;
        restoreFeeInside(p, cur.app);
        if (fee > 0 && mode === 'inside') takeFeeInside(p, cur.app, r2(fee));
      }
      set(cur, true);
      const next = st[st.indexOf(cur) + 1];
      justUnlocked = next ? next.key : null; justFinished = !next;
      try { navigator.vibrate && navigator.vibrate(next ? 15 : [20, 40, 30]); } catch (e) {}
    } else if (last && last.key === k) {
      set(last, false);
      if (last.type === 'hop') { p.shares.forEach(s => { if (!s.auto && shareApp(s) === last.app) s.done = false; }); restoreFeeInside(p, last.app); }
    } else return;
    save(); render();
    const target = justFinished ? null : $('.step.current');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' }); else $('#view').scrollTo({ top: 0, behavior: 'smooth' });
  },
  feeLast(el) { const i = $('#hopFee'); if (i) { i.value = el.dataset.v; el.remove(); feeLabels(); } },
  feeMode(el) { const m = $('#feeMode'); m.dataset.mode = el.dataset.v; $$('[data-act=feeMode]').forEach(b => b.classList.toggle('on', b === el)); feeLabels(); },
  startSave() {
    const v = num(($('#startAmt') || {}).value), err = $('#startErr');
    if (!(v >= 0)) { if (err) err.textContent = 'Enter the amount, or tap “Starting from zero”.'; return; }
    S.startSavings = r2(v); S.startSet = true; save(); closeSheet(); render(); toast(v ? `Added ${money(v)} to savings` : 'Starting from zero');
  },
  startZero() { S.startSavings = 0; S.startSet = true; save(); render(); toast('Starting from zero'); },
  startEdit() {
    openSheet(`<h3>Money you had before BROKE</h3>
      <p class="muted">What was in your savings account when you started using BROKE. Everything you move in later is counted on top.</p>
      <div class="fee-in light" style="margin:14px 0 6px"><b>$</b><input id="startAmt" inputmode="decimal" value="${S.startSavings || ''}" placeholder="0"></div>
      <p class="err" id="startErr"></p>
      <div class="btns"><button class="btn primary block" data-act="startSave">Save</button><button class="btn block" data-act="closeSheet">Cancel</button></div>`);
  },
  async copy(el) { (await copyText(el.dataset.v)) ? toast(`Copied ${el.dataset.v}`) : toast('Couldn’t copy'); },
  delPay(el) {
    const p = S.payments.find(x => x.id === el.dataset.id);
    confirmSheet('Delete this payment?', `${esc(p.client || 'Payment')} · ${money(p.amount)} on ${dateLabel(p.date)}. Its ticked savings come off your savings total.`,
      'Delete', () => { S.payments = S.payments.filter(x => x !== p); save(); draft = null; if (location.hash.startsWith('#pay/')) go('home', true); else if (location.hash.startsWith('#edit/')) go('history', true); else render(); toast('Deleted'); });
  },
  withdrawSheet,
  wdKind(el) { wd.kind = el.dataset.v; $('#wd-err').textContent = ''; wdUpdate(); },
  payDetail(el) { payDetail(el.dataset.id); },
  wtUseGuess(el) { $('#wt-date').value = el.dataset.v; wtMemory(); },
  delWithdraw(el) {
    const w = S.withdrawals.find(x => x.id === el.dataset.id);
    confirmSheet('Delete this withdrawal?', `${money(w.amount)} · ${esc(w.reason || 'No reason')}. It goes back into your savings total.`, 'Delete',
      () => { S.withdrawals = S.withdrawals.filter(x => x !== w); save(); render(); });
  },
  waitSheet(el) { waitSheet(el.dataset.id); },
  saveWait(el) {
    const client = $('#wt-client').value.trim(), amt = num($('#wt-amt').value), err = $('#wt-err');
    if (!client) return (err.textContent = 'Enter a client.');
    if (!(amt > 0)) return (err.textContent = 'Enter an amount.');
    const rec = { client, amount: r2(amt), expected: $('#wt-date').value, note: $('#wt-note').value.trim() };
    const ex = el.dataset.id && S.waiting.find(x => x.id === el.dataset.id);
    if (ex) Object.assign(ex, rec); else S.waiting.push({ id: uid(), created: Date.now(), added: todayStr(), ...rec });
    save(); closeSheet(); render();
  },
  delWait(el) {
    const w = S.waiting.find(x => x.id === el.dataset.id);
    confirmSheet('Remove from Waiting on?', `${esc(w.client)} · ${money(w.amount)}`, 'Remove', () => { S.waiting = S.waiting.filter(x => x !== w); save(); render(); });
  },
  gotPaidFrom(el) { draft = null; go('new/' + el.dataset.id); },
  async copySheet() { (await copyText(toTSV(exportRows()))) ? toast('Copied — paste into cell A1') : toast('Couldn’t copy'); },
  csv() { downloadFile(`broke-${todayStr()}.csv`, '﻿' + toCSV(exportRows()), 'text/csv'); },
  backup,
  restore() { const f = $('#restoreFile'); f.value = ''; f.click(); },
  wAdd() {
    const w = { id: uid(), name: 'New wallet', app: 'Neo', inbox: false, savings: false };
    S.wallets.push(w); S.splits.forEach(s => { s.pcts[w.id] = 0; }); save(); render();
  },
  wMove(el) {
    const i = +el.dataset.i, j = i + +el.dataset.d; if (j < 0 || j >= S.wallets.length) return;
    [S.wallets[i], S.wallets[j]] = [S.wallets[j], S.wallets[i]]; save(); render();
  },
  wDel(el) {
    const w = wallet(el.dataset.id);
    if (S.wallets.length <= 1) return toast('Keep at least one wallet');
    if (w.inbox || w.savings) return toast(`Make another wallet the ${w.inbox ? 'inbox' : 'savings'} first`);
    const sink = savingsWallet() || inboxWallet() || S.wallets.find(x => x !== w);
    confirmSheet(`Delete ${w.name}?`, `Its percentage in every split moves to ${esc(sink.name)}. Past payments keep their record.`, 'Delete wallet', () => {
      S.splits.forEach(s => { s.pcts[sink.id] = r2((+s.pcts[sink.id] || 0) + (+s.pcts[w.id] || 0)); delete s.pcts[w.id]; });
      S.wallets = S.wallets.filter(x => x !== w); save(); render();
    });
  },
  splitSheet(el) { splitSheet(el.dataset.id); },
  splitSave() {
    splitSheetInput();
    if (pctTotal(editing.pcts) !== 100 || !editing.name.trim()) return;
    const pcts = {}; S.wallets.forEach(w => { pcts[w.id] = +editing.pcts[w.id] || 0; });
    if (editing.id) Object.assign(S.splits.find(s => s.id === editing.id), { name: editing.name.trim(), pcts });
    else S.splits.push({ id: uid(), name: editing.name.trim(), pcts });
    editing = null; save(); closeSheet(); render();
  },
  splitDefault(el) { S.defaultSplit = el.dataset.id; save(); render(); },
  splitDel(el) {
    const s = S.splits.find(x => x.id === el.dataset.id);
    confirmSheet(`Delete “${s.name}”?`, 'Past payments keep the split they used.', 'Delete split', () => { S.splits = S.splits.filter(x => x !== s); save(); render(); });
  },
  goalAdd() { S.goals.push({ id: uid(), name: 'Goal', amount: 1000 }); save(); render(); },
  tagAdd() {
    let n = 1, name = 'new tag'; while (S.tags.some(t => t.toLowerCase() === name)) name = `new tag ${++n}`;
    S.tags.push(name); save(); render();
    const inputs = $$('[data-tagi]'); const last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); }
  },
  tagDel(el) {
    if (S.tags.length <= 1) return toast('Keep at least one tag');
    const t = S.tags[+el.dataset.i];
    S.tags.splice(+el.dataset.i, 1); save(); render(); toast(`Removed “${t}” — past payments keep it`);
  },
  goalDel(el) { S.goals = S.goals.filter(g => g.id !== el.dataset.id); save(); render(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const f = ACT[el.dataset.act]; if (!f) return;
  e.preventDefault(); f(el, e);
});
document.addEventListener('input', e => {
  if (e.target.id === 'hopFee') { feeLabels(); return; }
  if (e.target.closest('#payForm')) { readForm(); updatePreview(); }
  else if (e.target.closest('#sheet') && sheetInput) sheetInput();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'restoreFile' && t.files[0]) { restorePicked(t.files[0]); return; }
  if (t.dataset.wf) {
    const w = wallet(t.dataset.id); const f = t.dataset.wf;
    if (f === 'name') { const v = t.value.trim(); if (!v) { t.value = w.name; return; } w.name = v; }
    else if (f === 'app') w.app = t.value;
    else S.wallets.forEach(x => { x[f] = x === w; });
    save(); render(); return;
  }
  if (t.dataset.set) {
    const v = num(t.value);
    if (!(v >= 0)) { t.value = S[t.dataset.set]; toast('Enter a number'); return; }
    S[t.dataset.set] = r2(v); if (t.dataset.set === 'startSavings') S.startSet = true; save(); toast('Saved'); return;
  }
  if (t.dataset.tagi != null) {
    const i = +t.dataset.tagi, old = S.tags[i], v = t.value.trim();
    if (!v) { t.value = old; return toast('A tag needs a name'); }
    if (v === old) return;
    if (S.tags.some((x, j) => j !== i && x.toLowerCase() === v.toLowerCase())) { t.value = old; return toast('You already have that tag'); }
    S.tags[i] = v;
    S.payments.forEach(p => { if (p.tag === old) p.tag = v; });
    save(); render(); toast('Tag renamed'); return;
  }
  if (t.dataset.goal) {
    const g = S.goals.find(x => x.id === t.dataset.id);
    if (t.dataset.goal === 'name') g.name = t.value.trim() || g.name;
    else { const v = num(t.value); if (v > 0) g.amount = r2(v); else t.value = g.amount; }
    save(); return;
  }
});
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('details.month') || !openMonths) return;
  d.open ? openMonths.add(d.dataset.m) : openMonths.delete(d.dataset.m);
}, true);
document.addEventListener('pointerdown', e => { if (e.target.closest('#wd-hold')) holdStart(e); });
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, holdStop));
document.addEventListener('pointerout', e => { if (e.target.closest && e.target.closest('#wd-hold') && !e.relatedTarget?.closest?.('#wd-hold')) holdStop(); });
document.addEventListener('contextmenu', e => { if (e.target.closest('#wd-hold')) e.preventDefault(); });
document.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && e.target.id === 'wd-hold' && !e.repeat) { e.preventDefault(); holdStart(); } });
document.addEventListener('keyup', e => { if ((e.key === ' ' || e.key === 'Enter') && e.target.id === 'wd-hold') holdStop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheetWrap').hidden) closeSheet(); });


/* ---------- boot ---------- */
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(reg => { reg.update().catch(() => {}); }).catch(() => {}));
  // When a new version takes over, reload once so it shows now, unless you're mid-entry.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    const busy = /^#(new|edit)/.test(location.hash) || !$('#sheetWrap').hidden;
    if (busy) { toast('Update ready — it loads next time'); return; }
    reloading = true; location.reload();
  });
}
