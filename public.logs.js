(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('logs');
  try {
    const { data } = await apiFetch('/logs');
    const body = document.getElementById('logsBody');
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">No log entries yet.</td></tr>';
    } else {
      body.innerHTML = data.map((l) => `<tr>
        <td>${escapeHtml(l.action)}</td>
        <td><span class="badge ${l.level === 'error' ? 'failed' : l.level === 'warning' ? 'pending' : 'success'}">${l.level}</span></td>
        <td class="mono" style="font-size:12px; color:var(--text-muted);">${escapeHtml(JSON.stringify(l.details || {}))}</td>
        <td>${timeAgo(l.created_at)}</td>
      </tr>`).join('');
    }
  } catch (err) {
    document.getElementById('logsBody').innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
})();
