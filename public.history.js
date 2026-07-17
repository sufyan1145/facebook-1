(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('history');
  try {
    const { data } = await apiFetch('/uploads/history');
    const body = document.getElementById('historyBody');
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No uploads yet.</td></tr>';
    } else {
      body.innerHTML = data.map((h) => `<tr>
        <td>${escapeHtml(h.video_name || h.drive_file_id)}</td>
        <td>${escapeHtml(h.drive_folder_name || '—')}</td>
        <td class="mono" style="font-size:12px; color:var(--text-muted);">${escapeHtml(h.facebook_video_id || '—')}</td>
        <td><span class="badge ${h.status}">${h.status}</span></td>
        <td>${timeAgo(h.created_at)}</td>
      </tr>`).join('');
    }
  } catch (err) {
    document.getElementById('historyBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
})();
