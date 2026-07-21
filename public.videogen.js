const STATUS_LABEL = {
  pending: 'Pending',
  generating: 'Generating…',
  downloading: 'Saving to Drive…',
  completed: 'Completed',
  failed: 'Failed',
};

function renderJobs(jobs) {
  const body = document.getElementById('jobsBody');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No videos generated yet.</td></tr>';
    return;
  }
  body.innerHTML = jobs
    .map(
      (j) => `<tr>
        <td>${escapeHtml(j.topic.slice(0, 60))}${j.topic.length > 60 ? '…' : ''}</td>
        <td>${escapeHtml(j.drive_folder_name || '—')}</td>
        <td><span class="badge ${j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : ''}">${STATUS_LABEL[j.status] || j.status}</span></td>
        <td>${j.status === 'failed' ? `<span style="color:var(--signal-red);font-size:12px;">${escapeHtml(j.error_message || '')}</span>` : escapeHtml(j.drive_file_name || '—')}</td>
        <td style="font-size:12px; color:var(--text-muted);">${new Date(j.created_at).toLocaleString()}</td>
      </tr>`
    )
    .join('');
}

async function loadJobs() {
  try {
    const { data } = await apiFetch('/videogen/jobs');
    renderJobs(data);
  } catch (err) {
    document.getElementById('jobsBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
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

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('videogen');

  await loadFolders();
  await loadJobs();

  document.getElementById('refreshJobsBtn').addEventListener('click', loadJobs);

  document.getElementById('generateBtn').addEventListener('click', async () => {
    const topic = document.getElementById('topicInput').value.trim();
    const folderSelect = document.getElementById('folderSelect');
    const driveFolderId = folderSelect.value;
    const driveFolderName = folderSelect.selectedOptions[0]?.dataset.name;
    const duration = document.getElementById('durationSelect').value;
    const aspectRatio = document.getElementById('aspectSelect').value;
    const msg = document.getElementById('generateMsg');

    if (!topic) {
      msg.textContent = 'Please enter a topic or prompt.';
      return;
    }
    if (!driveFolderId) {
      msg.textContent = 'Please select a Drive folder to save the video into.';
      return;
    }

    msg.textContent = 'Starting generation…';
    document.getElementById('generateBtn').disabled = true;
    try {
      await apiFetch('/videogen/generate', {
        method: 'POST',
        body: JSON.stringify({ topic, driveFolderId, driveFolderName, duration, aspectRatio }),
      });
      msg.textContent = 'Started! This usually takes a few minutes — check the history table below for progress.';
      document.getElementById('topicInput').value = '';
      loadJobs();
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
    } finally {
      document.getElementById('generateBtn').disabled = false;
    }
  });
})();
