(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('dashboard');

  try {
    const { data } = await apiFetch('/dashboard/overview');

    document.getElementById('pipeDrive').textContent = data.connectedDrives ? 'Connected' : 'Not connected';
    document.getElementById('pipeQueue').textContent = `${data.queue.active || 0} active / ${data.queue.waiting || 0} waiting`;
    document.getElementById('pipePages').textContent = `${data.connectedPages} page${data.connectedPages === 1 ? '' : 's'}`;

    if ((data.queue.active || 0) > 0) {
      document.getElementById('pulse1').style.display = 'block';
      document.getElementById('pulse2').style.display = 'block';
    }

    document.getElementById('statToday').textContent = data.todaysUploads;
    document.getElementById('statSchedules').textContent = data.activeSchedules;
    document.getElementById('statFailed').textContent = data.failedUploads;
    document.getElementById('statTotal').textContent = data.totalUploads;

    const pillsEl = document.getElementById('statusPills');
    pillsEl.innerHTML = `
      <span class="pill ${data.connectedDrives ? 'ok' : ''}"><span class="dot"></span>Drive</span>
      <span class="pill ${data.connectedPages ? 'ok' : ''}"><span class="dot"></span>Facebook</span>
    `;

    const body = document.getElementById('activityBody');
    if (!data.recentActivity.length) {
      body.innerHTML = '<tr><td colspan="3" class="empty">No activity yet. Connect Drive and Facebook to get started.</td></tr>';
    } else {
      body.innerHTML = data.recentActivity
        .map(
          (log) => `<tr>
            <td>${escapeHtml(log.action)}</td>
            <td class="mono" style="color:var(--text-muted); font-size:12px;">${escapeHtml(JSON.stringify(log.details || {}))}</td>
            <td>${timeAgo(log.created_at)}</td>
          </tr>`
        )
        .join('');
    }
  } catch (err) {
    document.getElementById('activityBody').innerHTML = `<tr><td colspan="3" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
})();
