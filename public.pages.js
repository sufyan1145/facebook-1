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
        <td>${escapeHtml(p.page_name)}</td>
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

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('pages');

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
