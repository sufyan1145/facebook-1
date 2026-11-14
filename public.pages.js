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
        <td>${escapeHtml(p.fb_user_name || '—')}</td>
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
