const STATUS_LABEL = {
  pending: 'Pending',
  generating: 'Generating…',
  downloading: 'Saving to Drive…',
  completed: 'Completed',
  failed: 'Failed',
};

let jobsPollTimer = null;
let currentPreviewJobId = null;

function renderJobs(jobs) {
  const body = document.getElementById('jobsBody');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No videos generated yet.</td></tr>';
    return;
  }
  body.innerHTML = jobs
    .map((j) => {
      const resultCell =
        j.status === 'failed'
          ? `<span style="color:var(--signal-red);font-size:12px;">${escapeHtml(j.error_message || '')}</span>`
          : j.status === 'completed'
          ? `<button class="btn xs" data-preview="${j.id}" data-name="${escapeHtml(j.drive_file_name || 'video.mp4')}">Preview</button>`
          : '—';
      return `<tr>
        <td>${escapeHtml(j.topic.slice(0, 60))}${j.topic.length > 60 ? '…' : ''}</td>
        <td>${j.provider === 'vertex' ? 'Veo 3' : 'Kie.ai'}</td>
        <td>${escapeHtml(j.drive_folder_name || 'Local only')}</td>
        <td><span class="badge ${j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : ''}">${STATUS_LABEL[j.status] || j.status}</span></td>
        <td>${resultCell}</td>
        <td style="font-size:12px; color:var(--text-muted);">${timeAgo(j.created_at)}</td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => showPreview(btn.dataset.preview, btn.dataset.name));
  });

  // If a preview is currently open, keep it open across this re-render
  // (e.g. after clicking Refresh) instead of it disappearing.
  if (currentPreviewJobId && jobs.some((j) => j.id === currentPreviewJobId)) {
    document.getElementById('previewCard').style.display = 'block';
  }

  // Keep polling while anything is still in progress, so status/preview update live.
  const stillActive = jobs.some((j) => j.status === 'pending' || j.status === 'generating' || j.status === 'downloading');
  clearTimeout(jobsPollTimer);
  if (stillActive) jobsPollTimer = setTimeout(loadJobs, 8000);
}

function showPreview(jobId, fileName) {
  currentPreviewJobId = jobId;
  const card = document.getElementById('previewCard');
  const player = document.getElementById('previewPlayer');
  const downloadBtn = document.getElementById('downloadBtn');
  player.src = `/api/videogen/jobs/${jobId}/file`;
  downloadBtn.href = `/api/videogen/jobs/${jobId}/file?download=1`;
  downloadBtn.download = fileName;
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  player.play().catch(() => {});
}

async function loadJobs() {
  try {
    const { data } = await apiFetch('/videogen/jobs');
    renderJobs(data);
  } catch (err) {
    document.getElementById('jobsBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadFolders() {
  const select = document.getElementById('folderSelect');
  try {
    const { data } = await apiFetch('/drive/folders');
    select.innerHTML =
      data.map((f) => `<option value="${f.folder_id}" data-name="${escapeHtml(f.folder_name)}">${escapeHtml(f.folder_name)}</option>`).join('') ||
      '<option value="">No folders scanned — visit Drive Folders first</option>';
  } catch (err) {
    select.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`;
  }
}

function updateCostHint() {
  const provider = document.getElementById('providerSelect').value;
  const hint = document.getElementById('costHint');
  const duration = Number(document.getElementById('durationInput').value) || 0;
  if (provider !== 'vertex') {
    hint.textContent = 'Kie.ai generation does not use credits.';
    return;
  }
  const cost = Math.max(1, Math.round(duration * 18.75));
  const remaining = currentUser && currentUser.creditsRemaining != null ? currentUser.creditsRemaining : null;
  hint.textContent = `This will cost ${cost} credits (~18.75/sec)${remaining != null ? ` — you have ${remaining.toLocaleString()} remaining` : ''}.`;
}

function updateFolderFieldVisibility() {
  const saveToDrive = document.getElementById('saveToDrive').checked;
  document.getElementById('folderField').style.display = saveToDrive ? '' : 'none';
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('videogen');

  await loadFolders();
  await loadJobs();
  updateCostHint();
  updateFolderFieldVisibility();

  document.getElementById('refreshJobsBtn').addEventListener('click', loadJobs);
  document.getElementById('providerSelect').addEventListener('change', updateCostHint);
  document.getElementById('durationInput').addEventListener('input', updateCostHint);
  document.getElementById('saveToDrive').addEventListener('change', updateFolderFieldVisibility);

  document.getElementById('generateBtn').addEventListener('click', async () => {
    const topic = document.getElementById('topicInput').value.trim();
    const saveToDrive = document.getElementById('saveToDrive').checked;
    const folderSelect = document.getElementById('folderSelect');
    const driveFolderId = saveToDrive ? folderSelect.value : null;
    const driveFolderName = saveToDrive ? folderSelect.selectedOptions[0]?.dataset.name : null;
    const provider = document.getElementById('providerSelect').value;
    const duration = document.getElementById('durationInput').value;
    const aspectRatio = document.getElementById('aspectSelect').value;
    const msg = document.getElementById('generateMsg');

    if (!topic) {
      msg.textContent = 'Please enter a topic or prompt.';
      return;
    }
    if (saveToDrive && !driveFolderId) {
      msg.textContent = 'Please select a Drive folder, or turn off "Save to Google Drive".';
      return;
    }

    msg.textContent = 'Starting generation…';
    document.getElementById('generateBtn').disabled = true;
    try {
      await apiFetch('/videogen/generate', {
        method: 'POST',
        body: JSON.stringify({ topic, driveFolderId, driveFolderName, duration, aspectRatio, provider, saveToDrive }),
      });
      msg.textContent =
        provider === 'vertex'
          ? 'Started! Veo 3 generation can take several minutes — check the history table below for progress.'
          : 'Started! This usually takes a few minutes — check the history table below for progress.';
      document.getElementById('topicInput').value = '';
      loadJobs();
      // Refresh the credits badge shortly after a vertex generation starts (charge happens async).
      if (provider === 'vertex') setTimeout(async () => { currentUser = (await apiFetch('/auth/me')).data; renderCreditsBadge(); }, 3000);
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
    } finally {
      document.getElementById('generateBtn').disabled = false;
    }
  });
})();
