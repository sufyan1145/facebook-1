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
      <button class="btn xs danger" data-xdel="${a.id}" title="Disconnect this X account">✕</button></span>`).join('');
    el.querySelectorAll('[data-xcheck]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; xSay('Checking…');
      try { await apiFetch(`/x/accounts/${b.dataset.xcheck}/check`, { method: 'POST' }); xSay('Cookies are working.'); }
      catch (err) { xSay(err.message, true); }
      loadX();
    }));
    el.querySelectorAll('[data-xdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Disconnect this X account?')) return;
      await apiFetch(`/x/accounts/${b.dataset.xdel}`, { method: 'DELETE' });
      loadX();
    }));
  } catch (err) { xel('xList').innerHTML = `<span class="empty">${escapeHtml(err.message)}</span>`; }
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
