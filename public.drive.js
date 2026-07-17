function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function renderFolders(folders) {
  const body = document.getElementById('folderBody');
  if (!folders.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No folders found. Click "Rescan Drive" after connecting your account.</td></tr>';
    return;
  }
  body.innerHTML = folders
    .map(
      (f) => `<tr>
        <td>${escapeHtml(f.folder_name)}</td>
        <td class="mono" style="font-size:12px; color:var(--text-muted);">${escapeHtml(f.folder_id)}</td>
        <td>${f.video_count}</td>
        <td>${formatBytes(f.storage_bytes)}</td>
        <td>${escapeHtml(f.owner_email || '—')}</td>
        <td>${f.last_modified ? timeAgo(f.last_modified) : '—'}</td>
      </tr>`
    )
    .join('');
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('drive');

  document.getElementById('connectBtn').addEventListener('click', async () => {
    const { data } = await apiFetch('/drive/browse'); // ensures connection exists via API error if not
  });

  try {
    const { data } = await apiFetch('/drive/folders');
    renderFolders(data);
    if (data.length) document.getElementById('disconnectBtn').style.display = 'inline-flex';
  } catch (err) {
    document.getElementById('folderBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }

  document.getElementById('connectBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/auth/google/connect', { credentials: 'include' });
      const json = await res.json();
      window.location.href = json.data.url;
    } catch (err) {
      alert('Could not start Google connection: ' + err.message);
    }
  });

  document.getElementById('disconnectBtn').addEventListener('click', async () => {
    if (!confirm('Disconnect Google Drive?')) return;
    await apiFetch('/auth/google/disconnect', { method: 'POST' });
    window.location.reload();
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    document.getElementById('folderBody').innerHTML = '<tr><td colspan="6" class="empty">Scanning Drive…</td></tr>';
    try {
      const { data } = await apiFetch('/drive/browse');
      renderFolders(data);
    } catch (err) {
      document.getElementById('folderBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
    }
  });

  document.getElementById('searchInput').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    try {
      const { data } = await apiFetch(`/drive/search?q=${encodeURIComponent(q)}`);
      renderFolders(data);
    } catch (err) {
      // ignore transient search errors
    }
  });
})();
