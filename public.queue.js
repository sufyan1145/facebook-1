async function loadQueue() {
  try {
    const { data } = await apiFetch('/queue/status');
    document.getElementById('cWaiting').textContent = data.counts.waiting || 0;
    document.getElementById('cActive').textContent = data.counts.active || 0;
    document.getElementById('cCompleted').textContent = data.counts.completed || 0;
    document.getElementById('cFailed').textContent = data.counts.failed || 0;

    const body = document.getElementById('jobsBody');
    if (!data.jobs.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No jobs yet. Jobs appear here once a schedule runs.</td></tr>';
      return;
    }
    body.innerHTML = data.jobs
      .map(
        (j) => `<tr>
          <td class="mono" style="font-size:12px;">${escapeHtml(j.bullmq_job_id)}</td>
          <td><span class="badge ${j.status}">${j.status}</span></td>
          <td>${j.attempts}/${j.max_attempts}</td>
          <td>${timeAgo(j.created_at)}</td>
          <td>${j.status === 'waiting' || j.status === 'delayed' ? `<button class="btn sm danger" data-cancel="${j.bullmq_job_id}">Cancel</button>` : ''}</td>
        </tr>`
      )
      .join('');

    body.querySelectorAll('button[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await apiFetch(`/queue/${btn.dataset.cancel}`, { method: 'DELETE' });
        loadQueue();
      });
    });
  } catch (err) {
    document.getElementById('jobsBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('queue');

  document.getElementById('pauseBtn').addEventListener('click', async () => { await apiFetch('/queue/pause', { method: 'POST' }); loadQueue(); });
  document.getElementById('resumeBtn').addEventListener('click', async () => { await apiFetch('/queue/resume', { method: 'POST' }); loadQueue(); });

  loadQueue();
  setInterval(loadQueue, 8000);
})();
