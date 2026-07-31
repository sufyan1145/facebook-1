const STATUS_LABEL = {
  pending: 'Pending',
  fetching_info: 'Reading video info…',
  downloading: 'Downloading…',
  regenerating_metadata: 'Rewriting title/hashtags…',
  completed: 'Completed',
  failed: 'Failed',
};

let jobsPollTimer = null;
let currentPreviewJobId = null;

function renderJobs(jobs) {
  const body = document.getElementById('jobsBody');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No downloads yet.</td></tr>';
    return;
  }
  body.innerHTML = jobs
    .map((j) => {
      const resultCell =
        j.status === 'failed'
          ? `<span style="color:var(--signal-red);font-size:12px;">${escapeHtml(j.error_message || '')}</span>`
          : j.status === 'completed'
          ? `<button class="btn xs" data-preview="${j.id}" data-name="${escapeHtml(j.drive_file_name || 'video.mp4')}" data-title="${escapeHtml(j.generated_title || '')}" data-hashtags="${escapeHtml(j.generated_hashtags || '')}">Preview</button>`
          : '—';
      return `<tr>
        <td>${escapeHtml((j.generated_title || '(pending)').slice(0, 50))}</td>
        <td style="font-size:12px; color:var(--text-muted);">${escapeHtml((j.generated_hashtags || '').slice(0, 60))}</td>
        <td>${escapeHtml(j.drive_folder_name || 'Local only')}</td>
        <td><span class="badge ${j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : ''}">${STATUS_LABEL[j.status] || j.status}</span></td>
        <td>${resultCell}</td>
        <td style="font-size:12px; color:var(--text-muted);">${new Date(j.created_at).toLocaleString()}</td>
        <td><button class="btn xs danger" data-delete="${j.id}">Delete</button></td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () =>
      showPreview(btn.dataset.preview, btn.dataset.name, btn.dataset.title, btn.dataset.hashtags)
    );
  });

  body.querySelectorAll('button[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this entry from the download history? (The Drive file itself, if saved, is not deleted.)')) return;
      try {
        await apiFetch(`/tiktok/jobs/${btn.dataset.delete}`, { method: 'DELETE' });
        loadJobs();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  if (currentPreviewJobId && jobs.some((j) => j.id === currentPreviewJobId)) {
    document.getElementById('previewCard').style.display = 'block';
  }

  const stillActive = jobs.some((j) => ['pending', 'fetching_info', 'downloading', 'regenerating_metadata'].includes(j.status));
  clearTimeout(jobsPollTimer);
  if (stillActive) jobsPollTimer = setTimeout(loadJobs, 6000);
}

function showPreview(jobId, fileName, title, hashtags) {
  currentPreviewJobId = jobId;
  const card = document.getElementById('previewCard');
  const player = document.getElementById('previewPlayer');
  const downloadBtn = document.getElementById('downloadFileBtn');
  player.src = `/api/tiktok/jobs/${jobId}/file`;
  downloadBtn.href = `/api/tiktok/jobs/${jobId}/file?download=1`;
  downloadBtn.download = fileName;
  document.getElementById('previewMeta').innerHTML =
    `<div><strong>${escapeHtml(title)}</strong></div><div style="color:var(--text-muted); margin-top:4px;">${escapeHtml(hashtags)}</div>`;
  document.getElementById('copyHashtagsBtn').onclick = () => {
    navigator.clipboard.writeText(`${title}\n\n${hashtags}`).catch(() => {});
  };
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  player.play().catch(() => {});
}

async function loadJobs() {
  try {
    const { data } = await apiFetch('/tiktok/jobs');
    renderJobs(data);
  } catch (err) {
    document.getElementById('jobsBody').innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(err.message)}</td></tr>`;
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

function updateFolderFieldVisibility() {
  const saveToDrive = document.getElementById('saveToDrive').checked;
  document.getElementById('folderField').style.display = saveToDrive ? '' : 'none';
}

function updateUrlModeVisibility() {
  const multi = document.getElementById('multiMode').checked;
  document.getElementById('singleUrlField').style.display = multi ? 'none' : '';
  document.getElementById('multiUrlField').style.display = multi ? '' : 'none';
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('tiktok');

  await loadFolders();
  await loadJobs();
  updateFolderFieldVisibility();
  updateUrlModeVisibility();

  document.getElementById('refreshJobsBtn').addEventListener('click', loadJobs);
  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Clear all download history? (Drive files that were saved are not deleted, only the history list.)')) return;
    try {
      await apiFetch('/tiktok/jobs', { method: 'DELETE' });
      currentPreviewJobId = null;
      document.getElementById('previewCard').style.display = 'none';
      loadJobs();
    } catch (err) {
      alert(err.message);
    }
  });
  document.getElementById('saveToDrive').addEventListener('change', updateFolderFieldVisibility);
  document.getElementById('multiMode').addEventListener('change', updateUrlModeVisibility);

  document.getElementById('downloadBtn').addEventListener('click', async () => {
    const multi = document.getElementById('multiMode').checked;
    const regenerateMetadata = document.getElementById('regenerateMetadata').checked;
    const saveToDrive = document.getElementById('saveToDrive').checked;
    const folderSelect = document.getElementById('folderSelect');
    const driveFolderId = saveToDrive ? folderSelect.value : null;
    const driveFolderName = saveToDrive ? folderSelect.selectedOptions[0]?.dataset.name : null;
    const msg = document.getElementById('downloadMsg');

    if (saveToDrive && !driveFolderId) {
      msg.textContent = 'Please select a Drive folder, or turn off "Save to Google Drive".';
      return;
    }

    let urls;
    if (multi) {
      urls = document.getElementById('urlsTextarea').value
        .split('\n')
        .map((u) => u.trim())
        .filter(Boolean)
        .slice(0, 20);
      if (!urls.length) {
        msg.textContent = 'Please paste at least one TikTok video URL.';
        return;
      }
    } else {
      const url = document.getElementById('urlInput').value.trim();
      if (!url) {
        msg.textContent = 'Please paste a TikTok video URL.';
        return;
      }
      urls = [url];
    }

    msg.textContent = urls.length > 1 ? `Queuing ${urls.length} videos…` : 'Starting download…';
    document.getElementById('downloadBtn').disabled = true;
    let queued = 0;
    let failed = 0;
    for (const url of urls) {
      try {
        await apiFetch('/tiktok/download', {
          method: 'POST',
          body: JSON.stringify({ url, driveFolderId, driveFolderName, saveToDrive, regenerateMetadata }),
        });
        queued += 1;
      } catch (err) {
        failed += 1;
      }
    }
    msg.textContent =
      urls.length > 1
        ? `Queued ${queued} of ${urls.length} video(s)${failed ? `, ${failed} failed to queue` : ''}. They'll process one at a time — check the history table below.`
        : queued
        ? 'Started! Check the history table below for progress.'
        : 'Failed to start this download.';
    if (queued) {
      document.getElementById('urlInput').value = '';
      document.getElementById('urlsTextarea').value = '';
    }
    loadJobs();
    document.getElementById('downloadBtn').disabled = false;
  });
})();
