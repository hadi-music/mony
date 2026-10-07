'use strict';
/* Google Sheets sync.
   The phone stays the fast copy; a "BROKE" spreadsheet in the user's own Drive is the live mirror.
   Sign-in is a plain OAuth redirect (no popup, no Google script) so it works from the iPhone home screen.
   Scope is drive.file: the app can only see files it created. (Internal keys still say "mony"; keep them so data carries over.)
   Sync is a three-way merge against what both sides looked like after the last sync,
   so edits made in the sheet (or on another phone) and edits made here both survive. */
(function () {
  const CFG = window.MONY_CONFIG || {};
  const CLIENT_ID = CFG.googleClientId || '';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
  const SYNC_KEY = 'mony.sync', OAUTH_KEY = 'mony.oauth';
  const TABS = ['Payments', 'Waiting', 'Withdrawals', 'Settings'];
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const SHEET_NAME = 'BROKE';

  const getLS = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const setLS = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  let SY = (() => { try { return JSON.parse(getLS(SYNC_KEY)) || {}; } catch (e) { return {}; } })();
  const saveSync = () => setLS(SYNC_KEY, JSON.stringify(SY));
  const connected = () => !!(CLIENT_ID && SY.connected);
  const tokenOk = () => !!(SY.token && Date.now() < (SY.exp || 0));
  const redirectUri = () => location.origin + location.pathname;
  let state = 'idle', lastError = '', pendingToast = '';

  /* ---------- sign-in (redirect) ---------- */
  function startAuth(mode, back) {
    const st = Math.random().toString(36).slice(2);
    setLS(OAUTH_KEY, JSON.stringify({ st, mode, back: back || (location.hash && !/access_token|error=/.test(location.hash) ? location.hash : '#splits') }));
    const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: st });
    if (mode === 'none') p.set('prompt', 'none');
    if (SY.email) p.set('login_hint', SY.email);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
  }
  function handleReturn() {
    const h = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(h) || !/(^|&)state=/.test(h)) return;
    const q = new URLSearchParams(h);
    let saved = {}; try { saved = JSON.parse(getLS(OAUTH_KEY)) || {}; } catch (e) {}
    setLS(OAUTH_KEY, null);
    history.replaceState(null, '', location.pathname + (saved.back || '#splits'));
    if (q.get('state') !== saved.st) { pendingToast = 'Sign-in didn’t match. Try again.'; return; }
    const err = q.get('error');
    if (err) {
      if (saved.mode === 'none' && /interaction_required|login_required|consent_required|account_selection_required/.test(err)) return startAuth('');
      pendingToast = err === 'access_denied' ? 'Google access wasn’t granted' : 'Google sign-in failed: ' + err;
      return;
    }
    SY.token = q.get('access_token');
    SY.exp = Date.now() + (Math.max(60, +q.get('expires_in') || 3600) - 60) * 1000;
    if (!SY.connected) { SY.connected = true; SY.base = null; SY.fileId = null; }
    saveSync();
    pendingToast = 'Connected to Google';
  }
  handleReturn();

  /* ---------- Google API ---------- */
  class AuthError extends Error {}
  async function g(url, opts = {}) {
    if (!tokenOk()) throw new AuthError('expired');
    const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + SY.token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401) { SY.token = null; saveSync(); throw new AuthError('expired'); }
    if (!res.ok) { const t = await res.text(); const e = new Error(`Google ${res.status}: ${t.slice(0, 160)}`); e.status = res.status; e.body = t; throw e; }
    return res.status === 204 ? null : res.json();
  }
  async function findOrCreateFile() {
    const q = encodeURIComponent("appProperties has { key='mony' and value='1' } and trashed=false");
    const found = await g(`${DRIVE}?q=${q}&fields=files(id,name)&orderBy=createdTime&spaces=drive`);
    if (found.files && found.files.length) {
      const f = found.files[0];
      if (f.name === 'MONY') await g(`${DRIVE}/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name: SHEET_NAME }) }).catch(() => {}); // renamed app
      return { id: f.id, fresh: false };
    }
    const f = await g(DRIVE, { method: 'POST', body: JSON.stringify({ name: SHEET_NAME, mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: { mony: '1' } }) });
    const meta = await g(`${SHEETS}${f.id}?fields=sheets.properties`);
    const first = meta.sheets[0].properties.sheetId;
    const reqs = [{ updateSheetProperties: { properties: { sheetId: first, title: TABS[0], gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } }]
      .concat(TABS.slice(1).map(title => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })));
    await g(`${SHEETS}${f.id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: reqs }) });
    return { id: f.id, fresh: true };
  }
  async function ensureTabs(id) {
    const meta = await g(`${SHEETS}${id}?fields=sheets.properties.title`);
    const have = new Set(meta.sheets.map(s => s.properties.title));
    const reqs = TABS.filter(t => !have.has(t)).map(title => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }));
    if (reqs.length) await g(`${SHEETS}${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: reqs }) });
  }
  async function readGrid(id) {
    const url = `${SHEETS}${id}/values:batchGet?${TABS.map(t => 'ranges=' + encodeURIComponent(t + '!A1:ZZ')).join('&')}&valueRenderOption=UNFORMATTED_VALUE`;
    let r;
    try { r = await g(url); }
    catch (e) { if (e.status === 400 && /parse range/i.test(e.body || '')) { await ensureTabs(id); r = await g(url); } else throw e; }
    return Object.fromEntries(r.valueRanges.map((v, i) => [TABS[i], v.values || []]));
  }

  /* ---------- sheet <-> records ---------- */
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function normDate(v) {
    if (v === '' || v == null) return '';
    if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 864e5)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = Date.parse(s); return Number.isFinite(t) ? isoOf(new Date(t)) : '';
  }
  const str = v => (v == null ? '' : String(v)).trim();
  function rowsToObjs(rows) {
    if (!rows.length) return [];
    const h = rows[0].map(x => str(x).toLowerCase());
    return rows.slice(1).filter(r => r.some(c => str(c) !== '')).map(r => { const o = {}; h.forEach((k, i) => { if (k) o[k] = r[i] ?? ''; }); return o; });
  }
  const canon = {
    payments: p => p,
    waiting: w => ({ id: w.id, client: str(w.client), amount: r2(w.amount), expected: w.expected || '', note: str(w.note), added: w.added || (w.created ? tsDate(w.created) : '') }),
    withdrawals: w => ({ id: w.id, date: w.date, amount: r2(w.amount), kind: w.kind || '', reason: str(w.reason) }),
  };
  const settingsOf = s => ({ wallets: s.wallets, splits: s.splits, defaultSplit: s.defaultSplit, floor: s.floor, startSavings: s.startSavings || 0, goals: s.goals, tags: s.tags, target: s.target });
  // a tag typed in the sheet: reuse an existing tag if it matches, else keep what was typed
  const tagOf = (v, fallback) => { const t = str(v); if (!t) return fallback; return S.tags.find(x => x.toLowerCase() === t.toLowerCase()) || t; };
  function hash(o) { // cyrb53
    const s = JSON.stringify(o); let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function parseRemote(grid) {
    const out = { payments: [], waiting: [], withdrawals: [], settings: null, has: false };
    const def = () => S.splits.find(x => x.id === S.defaultSplit) || S.splits[0];
    for (const o of rowsToObjs(grid.Payments)) {
      let p = null; try { p = o.data ? JSON.parse(o.data) : null; } catch (e) {}
      if (p && p.id) {
        const d = normDate(o.date); if (d) p.date = d;
        if ('client' in o) p.client = str(o.client);
        if ('tag' in o) p.tag = tagOf(o.tag, p.tag);
      } else { // a row typed by hand
        const amount = num(o.amount); if (!(amount > 0)) continue;
        const sp = def(), take = Math.max(0, num(o['take off first']) || 0);
        p = { id: str(o.id) || uid(), created: Date.now(), date: normDate(o.date) || todayStr(), client: str(o.client),
          tag: tagOf(o.tag, S.tags[S.tags.length - 1] || ''), amount: r2(amount), takeOff: r2(take < amount ? take : 0),
          splitName: sp.name, pcts: { ...sp.pcts }, pctLabel: pctString(sp.pcts) };
        p.shares = computeShares(p.amount, p.takeOff, p.pcts);
        if (str(o.status).toLowerCase() !== 'to split') p.shares.forEach(s => { s.done = true; });
      }
      out.payments.push(p);
    }
    for (const o of rowsToObjs(grid.Waiting)) {
      const amount = num(o.amount); if (!str(o.client) || !(amount > 0)) continue;
      out.waiting.push({ id: str(o.id) || uid(), client: str(o.client), amount: r2(amount), expected: normDate(o.expected), note: str(o.note), added: normDate(o.added) || todayStr() });
    }
    for (const o of rowsToObjs(grid.Withdrawals)) {
      const amount = num(o.amount); if (!(amount > 0)) continue;
      out.withdrawals.push({ id: str(o.id) || uid(), date: normDate(o.date) || todayStr(), amount: r2(amount), kind: str(o.kind).toLowerCase(), reason: str(o.reason) });
    }
    const st = rowsToObjs(grid.Settings).find(o => str(o.key) === 'settings');
    if (st) { try { out.settings = JSON.parse(st.value); } catch (e) {} }
    out.has = !!(out.payments.length || out.waiting.length || out.withdrawals.length || out.settings);
    return out;
  }
  function buildGrid(D) {
    const home = (D.wallets.find(w => w.inbox) || {}).app || 'Whish';
    const apps = appKeys(appTotals(D.payments));
    const label = a => (a === home ? `Stays in ${a}` : `To ${a}`);
    const payments = [['ID', 'Date', 'Client', 'Tag', 'Amount', 'Take off first', 'Split used', 'Percentages', ...D.wallets.map(w => w.name), ...apps.map(label), 'Status', 'Data']];
    [...D.payments].sort((a, b) => (a.date + a.created).localeCompare(b.date + b.created)).forEach(p => {
      const by = {}; p.shares.forEach(s => { by[s.walletId] = r2((by[s.walletId] || 0) + s.amount); });
      const t = appTotals([p]);
      payments.push([p.id, p.date, p.client, p.tag, p.amount, p.takeOff || 0, p.splitName, p.pctLabel || '',
        ...D.wallets.map(w => by[w.id] || 0), ...apps.map(a => t[a] || 0), isPending(p) ? 'to split' : 'done', JSON.stringify(p)]);
    });
    const waiting = [['ID', 'Client', 'Amount', 'Expected', 'Note', 'Added']]
      .concat(D.waiting.map(w => { const c = canon.waiting(w); return [c.id, c.client, c.amount, c.expected, c.note, c.added]; }));
    const withdrawals = [['ID', 'Date', 'Amount', 'Kind', 'Reason']]
      .concat([...D.withdrawals].sort((a, b) => a.date.localeCompare(b.date)).map(w => { const c = canon.withdrawals(w); return [c.id, c.date, c.amount, c.kind, c.reason]; }));
    const settings = [['Key', 'Value'], ['settings', JSON.stringify(settingsOf(D))], ['', ''], ['Note', 'Managed by BROKE. Change settings in the app.']];
    return { Payments: payments, Waiting: waiting, Withdrawals: withdrawals, Settings: settings };
  }
  const colName = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  async function writeGrid(id, grid) {
    await g(`${SHEETS}${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: TABS.map(t => ({ range: `${t}!A1`, values: grid[t] })) }) });
    const ranges = [];
    TABS.forEach(t => { const rows = grid[t], w = Math.max(...rows.map(r => r.length)); ranges.push(`${t}!A${rows.length + 1}:ZZ`, `${t}!${colName(w)}1:ZZ`); });
    await g(`${SHEETS}${id}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges }) });
  }

  /* ---------- three-way merge ---------- */
  function snapshot(D) {
    const b = { settings: hash(settingsOf(D)) };
    for (const k of ['payments', 'waiting', 'withdrawals']) { b[k] = {}; D[k].forEach(r => { b[k][r.id] = hash(canon[k](r)); }); }
    return b;
  }
  function mergeList(k, local, remote, base) {
    const L = new Map(local.map(r => [r.id, r])), R = new Map(remote.map(r => [r.id, r]));
    const order = [...new Set([...L.keys(), ...R.keys()])];
    const out = []; let deletions = 0;
    for (const id of order) {
      const l = L.get(id), r = R.get(id), b = base ? (base[id] ?? null) : undefined;
      const lh = l ? hash(canon[k](l)) : null, rh = r ? hash(canon[k](r)) : null;
      let pick;
      if (lh === rh) pick = l;
      else if (base === null) pick = l || r;                      // first sync: union, phone wins on clashes
      else if (lh === b) pick = r ? { ...(l || {}), ...r } : null; // only the sheet changed
      else if (rh === b) pick = l;                                 // only the phone changed
      else pick = l || r;                                          // both changed: phone wins
      if (pick) out.push(pick); else if (l) deletions++;
    }
    return { list: out, deletions };
  }
  function merge(remote, base) {
    let first = !base;
    let m = {};
    for (const k of ['payments', 'waiting', 'withdrawals']) m[k] = mergeList(k, S[k], remote[k], first ? null : base[k] || {});
    const dels = m.payments.deletions + m.waiting.deletions + m.withdrawals.deletions;
    const localCount = S.payments.length + S.waiting.length + S.withdrawals.length;
    if (!first && dels >= 5 && dels >= localCount / 2) { // the sheet looks wiped — don't follow it, restore it
      first = true; pendingToast = 'The sheet looked empty — refilled it from this phone';
      for (const k of ['payments', 'waiting', 'withdrawals']) m[k] = mergeList(k, S[k], remote[k], null);
    }
    let settings = settingsOf(S);
    if (remote.settings) {
      const lh = hash(settingsOf(S)), rh = hash(settingsOf(remote.settings));
      if (lh !== rh && (first ? remote.has : lh === base.settings)) settings = settingsOf(remote.settings);
    }
    return migrate({ ...S, ...settings, payments: m.payments.list, waiting: m.waiting.list, withdrawals: m.withdrawals.list });
  }

  /* ---------- sync loop ---------- */
  let busy = false, again = false, timer = null, quiet = false;
  async function syncNow(manual) {
    if (!connected()) return paint();
    if (busy) { again = true; return; }
    if (!navigator.onLine) { state = 'offline'; return paint(); }
    if (!tokenOk()) { state = 'auth'; return paint(); }
    busy = true; state = 'syncing'; paint();
    try {
      if (!SY.email) { const u = await g('https://www.googleapis.com/oauth2/v3/userinfo'); SY.email = u.email || ''; }
      if (!SY.fileId) { const f = await findOrCreateFile(); SY.fileId = f.id; SY.base = null; saveSync(); }
      let grid;
      try { grid = await readGrid(SY.fileId); }
      catch (e) { if (e.status === 404) { SY.fileId = null; SY.base = null; const f = await findOrCreateFile(); SY.fileId = f.id; grid = await readGrid(SY.fileId); } else throw e; }
      const before = JSON.stringify(S);
      const merged = merge(parseRemote(grid), SY.base);
      S = merged; quiet = true; save(); quiet = false;
      await writeGrid(SY.fileId, buildGrid(merged));
      SY.base = snapshot(merged); SY.lastSync = Date.now(); SY.dirty = false;
      state = 'ok'; lastError = '';
      if (manual === true && !pendingToast) pendingToast = 'Synced';
      if (before !== JSON.stringify(S) && $('#sheetWrap').hidden && !location.hash.startsWith('#new')) render();
    } catch (e) {
      if (e instanceof AuthError) state = 'auth';
      else { state = 'error'; lastError = e.message || String(e); console.warn('BROKE sync', e); }
    } finally {
      busy = false; saveSync(); paint();
      if (pendingToast) { toast(pendingToast); pendingToast = ''; }
      if (again) { again = false; schedule(500); }
    }
  }
  function schedule(ms = 2500) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }

  /* ---------- UI ---------- */
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  function statusText() {
    if (state === 'syncing') return 'Syncing…';
    if (state === 'auth') return SY.dirty ? 'Changes waiting — reconnect' : 'Reconnect to sync';
    if (state === 'offline') return SY.dirty ? 'Offline — will sync later' : 'Offline';
    if (state === 'error') return 'Sync failed';
    if (SY.dirty) return 'Saving…';
    return SY.lastSync ? `Synced ${ago(SY.lastSync)}` : 'Not synced yet';
  }
  function paint() {
    const pill = document.getElementById('syncPill');
    if (pill) {
      pill.hidden = !connected();
      const kind = state === 'syncing' || (SY.dirty && state !== 'auth' && state !== 'error') ? 'busy' : state === 'auth' || state === 'offline' ? 'warn' : state === 'error' ? 'bad' : 'ok';
      pill.className = 'sync-pill ' + kind;
      pill.innerHTML = `<i></i><span>${state === 'auth' ? 'Reconnect' : state === 'error' ? 'Sync failed' : state === 'offline' ? 'Offline' : kind === 'busy' ? 'Syncing' : 'Synced'}</span>`;
    }
    const card = document.getElementById('syncCard');
    if (!card) return;
    if (!CLIENT_ID) { card.innerHTML = '<p class="small muted">Google sync isn’t set up in config.js.</p>'; return; }
    if (!connected()) {
      card.innerHTML = `<p class="small muted">Keep a live copy in a Google Sheet in your own Drive. It syncs both ways and works across phones. BROKE can only see the sheet it creates.</p>
        <button class="btn sm" data-act="syncConnect">Connect Google Sheets</button>`;
      return;
    }
    card.innerHTML = `<div class="between"><b>${esc(SY.email || 'Google account')}</b><span class="small muted">${esc(statusText())}</span></div>
      ${state === 'error' ? `<p class="small" style="color:var(--danger);margin-top:6px">${esc(lastError)}</p>` : ''}
      <div class="btns" style="margin-top:10px">
        ${state === 'auth' ? '<button class="btn primary sm" data-act="syncReconnect">Reconnect</button>' : '<button class="btn sm" data-act="syncTap">Sync now</button>'}
        ${SY.fileId ? `<a class="btn sm" href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(SY.fileId)}/edit" target="_blank" rel="noopener" style="text-decoration:none">Open sheet</a>` : ''}
        <button class="btn ghost sm" data-act="syncDisconnect">Disconnect</button>
      </div>`;
  }

  window.MonySync = {
    changed() { if (!connected() || quiet) return; SY.dirty = true; saveSync(); paint(); schedule(); },
    paint,
    needsSignIn: () => !!CLIENT_ID && !SY.connected,
    _test: { parseRemote, merge, buildGrid, snapshot, normDate },
  };

  document.addEventListener('DOMContentLoaded', () => {
    Object.assign(ACT, {
      syncConnect(el) {
        if (el && el.classList.contains('gbtn')) { el.disabled = true; el.querySelector('span').textContent = 'Opening Google…'; }
        startAuth('', MonySync.needsSignIn() ? '#home' : null);
      },
      syncReconnect() { startAuth('none'); },
      syncTap() {
        if (state === 'auth') return startAuth('none');
        if (state === 'offline' || !navigator.onLine) return toast('You’re offline — it’ll sync when you’re back');
        if (state === 'syncing') return;
        syncNow(true);
      },
      syncDisconnect() {
        confirmSheet('Disconnect Google?', 'Sync stops on this phone. Your data stays here, and the BROKE sheet stays in your Drive.', 'Disconnect', () => {
          if (SY.token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(SY.token), { method: 'POST', mode: 'no-cors' }).catch(() => {});
          SY = {}; saveSync(); state = 'idle'; render(); toast('Disconnected');
        }, false);
      },
    });
    paint();
    if (pendingToast && !connected()) { toast(pendingToast); pendingToast = ''; }
    if (connected()) syncNow();
  });
  window.addEventListener('online', () => connected() && syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && connected() && (SY.dirty || !SY.lastSync || Date.now() - SY.lastSync > 60000)) syncNow();
  });
})();
