function renderPages(pages) {
  const body = document.getElementById('pagesBody');
  if (!pages.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No pages found. Connect Facebook to import your Pages.</td></tr>';
    return;
  }
  body.innerHTML = pages
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.page_name)}</td>
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
    document.getElementById('pagesBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
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
    document.getElementById('pagesBody').innerHTML = '<tr><td colspan="5" class="empty">Syncing…</td></tr>';
    try {
      await apiFetch('/pages/sync', { method: 'POST' });
      loadPages();
    } catch (err) {
      document.getElementById('pagesBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
    }
  });

  loadPages();
})();
