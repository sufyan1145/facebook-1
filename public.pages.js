function renderAccounts(accounts) {
  const el = document.getElementById('accountsList');
  if (!accounts.length) {
    el.innerHTML = '<span class="empty">No Facebook accounts connected yet.</span>';
    return;
  }
  el.innerHTML = accounts
    .map(
      (a) => `<span class="account-chip">
        <span class="dot ok"></span>${escapeHtml(a.fb_user_name || a.fb_user_id)}
        <button class="btn xs danger" data-account-id="${a.id}" title="Disconnect this Facebook account">✕</button>
      </span>`
    )
    .join('');

  el.querySelectorAll('button[data-account-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Disconnect this Facebook account? Its pages will stop being usable in schedules.')) return;
      await apiFetch(`/auth/facebook/disconnect/${btn.dataset.accountId}`, { method: 'POST' });
      loadAccounts();
      loadPages();
    });
  });
}

async function loadAccounts() {
  try {
    const { data } = await apiFetch('/auth/facebook/accounts');
    renderAccounts(data);
  } catch (err) {
    document.getElementById('accountsList').innerHTML = `<span class="empty">${escapeHtml(err.message)}</span>`;
  }
}

function renderPages(pages) {
  const body = document.getElementById('pagesBody');
  if (!pages.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No pages found. Add a Facebook account to import your Pages.</td></tr>';
    return;
  }
  body.innerHTML = pages
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.page_name)}${p.instagram_username ? ` <span class="pill ok" title="Linked Instagram account">IG @${escapeHtml(p.instagram_username)}</span>` : ''}</td>
        <td>${escapeHtml(p.fb_user_name || (p.token_added ? 'Page token' : '—'))}</td>
        <td class="mono" style="font-size:12px; color:var(--text-muted);">${escapeHtml(p.page_id)}</td>
        <td>${p.followers?.toLocaleString?.() ?? p.followers}</td>
        <td><span class="badge ${p.is_connected ? 'success' : 'failed'}">${p.is_connected ? 'Connected' : 'Disconnected'}</span></td>
        <td>${p.is_connected ? `<button class="btn sm danger" data-id="${p.id}">Disconnect</button>` : ''}</td>
      </tr>`
    )
    .join('');

  body.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Disconnect this page?')) return;
      await apiFetch(`/pages/${btn.dataset.id}/disconnect`, { method: 'POST' });
      loadPages();
    });
  });
}

async function loadPages() {
  try {
    const { data } = await apiFetch('/pages');
    renderPages(data);
  } catch (err) {
    document.getElementById('pagesBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- X (Twitter) accounts, connected with browser cookies ----
const xel = (id) => document.getElementById(id);
function xSay(text, bad) { const m = xel('xMsg'); m.textContent = text || ''; m.style.color = bad ? 'var(--signal-red)' : 'var(--signal-green)'; }

async function loadX() {
  try {
    const { data } = await apiFetch('/x/accounts');
    const el = xel('xList');
    if (!data.length) { el.innerHTML = '<span class="empty">No X account connected yet.</span>'; return; }
    el.innerHTML = data.map((a) => `<span class="account-chip">
      <span class="dot ${a.status === 'active' ? 'ok' : ''}"></span>@${escapeHtml(a.username)}${a.status === 'expired' ? ' <span class="badge failed" title="' + escapeHtml(a.last_error || '') + '">Expired</span>' : ''}
      <button class="btn xs" data-xcheck="${a.id}" title="Check the cookies still work">Check</button>
      <button class="btn xs" data-xtest="${a.id}" title="Post a short test tweet to prove the account works">Test post</button>
      <button class="btn xs danger" data-xdel="${a.id}" title="Disconnect this X account">✕</button></span>`).join('');
    el.querySelectorAll('[data-xcheck]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; xSay('Checking…');
      try { await apiFetch(`/x/accounts/${b.dataset.xcheck}/check`, { method: 'POST' }); xSay('Cookies are working.'); }
      catch (err) { xSay(err.message, true); }
      loadX();
    }));
    el.querySelectorAll('[data-xtest]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Ye X par ek chhoti test post karega (baad mein aap delete kar sakte hain). Jari rakhein?')) return;
      b.disabled = true; xSay('Posting test tweet…');
      try {
        const { data } = await apiFetch(`/x/accounts/${b.dataset.xtest}/test`, { method: 'POST' });
        xSay(`Test post ho gayi: ${data.url}`);
      } catch (err) { xSay(err.message, true); }
      loadX();
    }));
    el.querySelectorAll('[data-xdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Disconnect this X account?')) return;
      await apiFetch(`/x/accounts/${b.dataset.xdel}`, { method: 'DELETE' });
      loadX();
    }));
  } catch (err) { xel('xList').innerHTML = `<span class="empty">${escapeHtml(err.message)}</span>`; }
}

// ---- Pinterest (official OAuth) ----
function pinSay(text, bad) { const m = xel('pinMsg'); m.textContent = text || ''; m.style.color = bad ? 'var(--signal-red)' : 'var(--signal-green)'; }

async function loadPinterest() {
  try {
    const { data } = await apiFetch('/pinterest/accounts');
    const el = xel('pinList');
    if (!data.length) { el.innerHTML = '<span class="empty">No Pinterest account connected yet.</span>'; return; }
    el.innerHTML = data.map((a) => `<div class="account-chip" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
      <span class="dot ${a.status === 'active' ? 'ok' : ''}"></span>@${escapeHtml(a.username)}${a.status === 'expired' ? ' <span class="badge failed" title="' + escapeHtml(a.last_error || '') + '">Expired - add again</span>' : ''}
      <span style="color:var(--text-faint); font-size:12px;">Board: <b>${a.board_name ? escapeHtml(a.board_name) : 'not chosen'}</b></span>
      <button class="btn xs" data-pinboards="${a.id}">Choose board</button>
      <select id="pinSel_${a.id}" style="display:none; max-width:240px;"></select>
      <button class="btn xs danger" data-pindel="${a.id}" title="Disconnect this Pinterest account">✕</button></div>`).join('');
    el.querySelectorAll('[data-pinboards]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; pinSay('Loading boards…');
      try {
        const { data: boards } = await apiFetch(`/pinterest/accounts/${b.dataset.pinboards}/boards`);
        if (!boards.length) { pinSay('This Pinterest account has no boards yet. Create a board on pinterest.com first.', true); b.disabled = false; return; }
        const sel = xel(`pinSel_${b.dataset.pinboards}`);
        sel.innerHTML = '<option value="">Select a board…</option>' + boards.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
        sel.style.display = 'inline-block'; pinSay('');
        sel.addEventListener('change', async () => {
          if (!sel.value) return;
          try {
            await apiFetch(`/pinterest/accounts/${b.dataset.pinboards}/board`, { method: 'POST', body: JSON.stringify({ boardId: sel.value, boardName: sel.options[sel.selectedIndex].text }) });
            pinSay('Board saved.'); loadPinterest();
          } catch (err) { pinSay(err.message, true); }
        });
      } catch (err) { pinSay(err.message, true); }
      b.disabled = false;
    }));
    el.querySelectorAll('[data-pindel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Disconnect this Pinterest account?')) return;
      await apiFetch(`/pinterest/accounts/${b.dataset.pindel}`, { method: 'DELETE' });
      loadPinterest();
    }));
  } catch (err) { xel('pinList').innerHTML = `<span class="empty">${escapeHtml(err.message)}</span>`; }
}

function initPinterest() {
  xel('addPinBtn').addEventListener('click', async () => {
    try { const { data } = await apiFetch('/pinterest/connect'); window.location.href = data.url; }
    catch (err) { xel('pinCard').scrollIntoView({ behavior: 'smooth' }); pinSay(err.message, true); }
  });
  const q = new URLSearchParams(window.location.search);
  if (q.get('pinterest_connected')) pinSay('Pinterest connected. Now choose a board.');
  if (q.get('pinterest_error')) pinSay(`Pinterest: ${q.get('pinterest_error')}`, true);
  loadPinterest();
}

// ---- Threads (official OAuth) ----
function thSay(text, bad) { const m = xel('thMsg'); m.textContent = text || ''; m.style.color = bad ? 'var(--signal-red)' : 'var(--signal-green)'; }

async function loadThreads() {
  try {
    const { data } = await apiFetch('/threads/accounts');
    const el = xel('thList');
    if (!data.length) { el.innerHTML = '<span class="empty">No Threads account connected yet.</span>'; return; }
    el.innerHTML = data.map((a) => `<div class="account-chip" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
      <span class="dot ${a.status === 'active' ? 'ok' : ''}"></span>@${escapeHtml(a.username)}${a.status === 'expired' ? ' <span class="badge failed" title="' + escapeHtml(a.last_error || '') + '">Expired - add again</span>' : ''}
      <button class="btn xs danger" data-thdel="${a.id}" title="Disconnect this Threads account">✕</button></div>`).join('');
    el.querySelectorAll('[data-thdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Disconnect this Threads account?')) return;
      await apiFetch(`/threads/accounts/${b.dataset.thdel}`, { method: 'DELETE' });
      loadThreads();
    }));
  } catch (err) { xel('thList').innerHTML = `<span class="empty">${escapeHtml(err.message)}</span>`; }
}

function initThreads() {
  xel('addThreadsBtn').addEventListener('click', async () => {
    try { const { data } = await apiFetch('/threads/connect'); window.location.href = data.url; }
    catch (err) { xel('thCard').scrollIntoView({ behavior: 'smooth' }); thSay(err.message, true); }
  });
  const q = new URLSearchParams(window.location.search);
  if (q.get('threads_connected')) thSay('Threads connected.');
  if (q.get('threads_error')) thSay(`Threads: ${q.get('threads_error')}`, true);
  loadThreads();
}

// ---- Add Pages by Page token (paid plans) ----
function parseTokenInput(text) {
  const t = String(text || '').trim();
  const items = [];
  if (!t) return items;
  let json = null;
  try { json = JSON.parse(t); } catch (_) { /* not JSON: line format */ }
  if (json) {
    const arr = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : [json]);
    arr.forEach((p) => { const tok = p && (p.access_token || p.token); if (tok) items.push({ id: p.id ? String(p.id) : '', token: String(tok).trim() }); });
  } else {
    t.split(/\r?\n/).forEach((line) => {
      const parts = line.trim().split(/[|,;\s]+/).filter(Boolean);
      if (parts.length === 1) items.push({ id: '', token: parts[0] });
      else if (parts.length >= 2) items.push({ id: /^\d+$/.test(parts[0]) ? parts[0] : '', token: /^\d+$/.test(parts[0]) ? parts[1] : parts[0] });
    });
  }
  const seen = new Set();
  return items.filter((i) => (seen.has(i.token) ? false : (seen.add(i.token), true)));
}

function initPageTokens(user) {
  if (!user || !(user.isAdmin || user.planType === 'paid')) return;
  const btn = xel('addTokBtn'); const card = xel('tokCard');
  btn.style.display = '';
  btn.addEventListener('click', () => { card.style.display = 'block'; card.scrollIntoView({ behavior: 'smooth' }); });
  xel('tokCancelBtn').addEventListener('click', () => { card.style.display = 'none'; });
  xel('tokGoBtn').addEventListener('click', async () => {
    const items = parseTokenInput(xel('tokText').value);
    const msg = xel('tokMsg'); const fails = xel('tokFails');
    fails.textContent = '';
    if (!items.length) { msg.style.color = 'var(--signal-red)'; msg.textContent = 'Nothing to add - paste the JSON or PAGE_ID|TOKEN lines.'; return; }
    if (items.length > 1000) { msg.style.color = 'var(--signal-red)'; msg.textContent = 'Max 1000 pages at once.'; return; }
    const go = xel('tokGoBtn'); go.disabled = true;
    let added = 0; const bad = [];
    for (let i = 0; i < items.length; i += 25) {
      msg.style.color = 'var(--text-muted)'; msg.textContent = `Verifying ${Math.min(i + 25, items.length)} / ${items.length}…`;
      try {
        const { data } = await apiFetch('/pages/add-by-token', { method: 'POST', body: JSON.stringify({ items: items.slice(i, i + 25) }) });
        data.forEach((r, k) => { if (r.ok) added += 1; else bad.push(`${r.id || ('token #' + (i + k + 1))}: ${r.error}`); });
      } catch (err) { items.slice(i, i + 25).forEach((_, k) => bad.push(`token #${i + k + 1}: ${err.message}`)); }
    }
    go.disabled = false;
    msg.style.color = added ? 'var(--signal-green)' : 'var(--signal-red)';
    msg.textContent = `${added} page(s) added${bad.length ? `, ${bad.length} failed` : ''}.`;
    if (bad.length) fails.textContent = bad.slice(0, 40).join('\n') + (bad.length > 40 ? `\n… and ${bad.length - 40} more` : '');
    if (added) { xel('tokText').value = ''; loadPages(); }
  });
}

function initX() {
  xel('showXBtn').addEventListener('click', () => { xel('xForm').style.display = 'block'; xel('xCard').scrollIntoView({ behavior: 'smooth' }); });
  xel('xCancelBtn').addEventListener('click', () => { xel('xForm').style.display = 'none'; xel('xForm').reset(); });
  xel('xForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = xel('xSaveBtn'); btn.disabled = true; btn.textContent = 'Verifying…'; xSay('');
    try {
      const { data } = await apiFetch('/x/accounts', { method: 'POST', body: JSON.stringify({ authToken: xel('xAuth').value, ct0: xel('xCt0').value, cookies: xel('xRaw').value, username: xel('xUser').value }) });
      xel('xForm').reset(); xel('xForm').style.display = 'none';
      xSay(`X account @${data.username} connected.`);
      loadX();
    } catch (err) { xSay(err.message, true); }
    btn.disabled = false; btn.textContent = 'Verify & add';
  });
  loadX();
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('pages');
  initX();
  initPinterest();
  initThreads();
  initPageTokens(user);

  document.getElementById('connectBtn').addEventListener('click', async () => {
    const res = await fetch('/api/auth/facebook/connect', { credentials: 'include' });
    const json = await res.json();
    window.location.href = json.data.url;
  });

  document.getElementById('syncBtn').addEventListener('click', async () => {
    document.getElementById('pagesBody').innerHTML = '<tr><td colspan="6" class="empty">Syncing…</td></tr>';
    try {
      await apiFetch('/pages/sync', { method: 'POST', body: JSON.stringify({}) }); // syncs every connected account
      loadPages();
    } catch (err) {
      document.getElementById('pagesBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
    }
  });

  loadAccounts();
  loadPages();
})();
