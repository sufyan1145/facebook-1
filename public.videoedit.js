const STATUS_LABEL = {
  pending: 'Pending',
  downloading: 'Downloading…',
  editing: 'Applying effects…',
  completed: 'Completed',
  failed: 'Failed',
};

let jobsPollTimer = null;
let currentPreviewJobId = null;

function renderJobs(jobs) {
  const body = document.getElementById('jobsBody');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No edits yet.</td></tr>';
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
        <td style="font-size:12px;">${escapeHtml(j.source_url.slice(0, 45))}${j.source_url.length > 45 ? '…' : ''}</td>
        <td>${escapeHtml(j.drive_folder_name || 'Local only')}</td>
        <td><span class="badge ${j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : ''}">${STATUS_LABEL[j.status] || j.status}</span></td>
        <td>${resultCell}</td>
        <td style="font-size:12px; color:var(--text-muted);">${new Date(j.created_at).toLocaleString()}</td>
        <td><button class="btn xs danger" data-delete="${j.id}">Delete</button></td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => showPreview(btn.dataset.preview, btn.dataset.name));
  });
  body.querySelectorAll('button[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this entry from the edit history? (The Drive file itself, if saved, is not deleted.)')) return;
      try {
        await apiFetch(`/videoedit/jobs/${btn.dataset.delete}`, { method: 'DELETE' });
        loadJobs();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  if (currentPreviewJobId && jobs.some((j) => j.id === currentPreviewJobId)) {
    document.getElementById('previewCard').style.display = 'block';
  }

  const stillActive = jobs.some((j) => ['pending', 'downloading', 'editing'].includes(j.status));
  clearTimeout(jobsPollTimer);
  if (stillActive) jobsPollTimer = setTimeout(loadJobs, 8000);
}

function showPreview(jobId, fileName) {
  currentPreviewJobId = jobId;
  const card = document.getElementById('previewCard');
  const player = document.getElementById('previewPlayer');
  const downloadBtn = document.getElementById('downloadFileBtn');
  player.src = `/api/videoedit/jobs/${jobId}/file`;
  downloadBtn.href = `/api/videoedit/jobs/${jobId}/file?download=1`;
  downloadBtn.download = fileName;
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  player.play().catch(() => {});
}

async function loadJobs() {
  try {
    const { data } = await apiFetch('/videoedit/jobs');
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

function updateFolderFieldVisibility() {
  const on = document.getElementById('saveToDrive').checked;
  document.getElementById('folderField').style.display = on ? '' : 'none';
}

function updateSecondaryUrlVisibility() {
  const mode = document.getElementById('splitScreenMode').value;
  document.getElementById('secondaryUrlField').style.display = mode ? '' : 'none';
}

const EFFECT_LABELS = {
  flash: 'Flash', blur_transition: 'Blur', spin: 'Spin', glitch: 'Glitch', shake: 'Shake',
  whip_pan: 'Whip Pan', light_leak: 'Light Leak', zoom_punch: 'Zoom Punch',
  jump_cut: 'Cutting / Jump Cut', slide: 'Slide (drag-in)', fade_out: 'Fade Out',
};
let effectCues = [];

function renderCueList() {
  const list = document.getElementById('cueList');
  if (!effectCues.length) {
    list.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No effects added yet.</div>';
    return;
  }
  list.innerHTML = effectCues
    .map(
      (cue, i) =>
        `<div style="display:flex; align-items:center; gap:8px; font-size:13px; background:var(--panel-2); padding:6px 10px; border-radius:6px;">
          <span style="flex:1;">${EFFECT_LABELS[cue.effect] || cue.effect} @ ${cue.at}s</span>
          <button type="button" class="btn xs danger" data-remove-cue="${i}">Remove</button>
        </div>`
    )
    .join('');
  list.querySelectorAll('button[data-remove-cue]').forEach((btn) => {
    btn.addEventListener('click', () => {
      effectCues.splice(Number(btn.dataset.removeCue), 1);
      renderCueList();
    });
  });
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('videoedit');

  await loadFolders();
  await loadJobs();
  updateFolderFieldVisibility();
  updateSecondaryUrlVisibility();
  renderCueList();

  document.getElementById('refreshJobsBtn').addEventListener('click', loadJobs);
  document.getElementById('saveToDrive').addEventListener('change', updateFolderFieldVisibility);
  document.getElementById('splitScreenMode').addEventListener('change', updateSecondaryUrlVisibility);
  document.getElementById('addCueBtn').addEventListener('click', () => {
    const at = Number(document.getElementById('cueAtInput').value) || 0;
    const checked = Array.from(document.querySelectorAll('.cueEffect:checked'));
    if (!checked.length) return;
    checked.forEach((cb) => {
      effectCues.push({ effect: cb.value, at });
      cb.checked = false;
    });
    renderCueList();
  });
  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Clear all edit history? (Drive files that were saved are not deleted, only the history list.)')) return;
    try {
      await apiFetch('/videoedit/jobs', { method: 'DELETE' });
      currentPreviewJobId = null;
      document.getElementById('previewCard').style.display = 'none';
      loadJobs();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('createBtn').addEventListener('click', async () => {
    const url = document.getElementById('urlInput').value.trim();
    const msg = document.getElementById('createMsg');
    if (!url) { msg.textContent = 'Please paste a video URL.'; return; }

    const saveToDrive = document.getElementById('saveToDrive').checked;
    const folderSelect = document.getElementById('folderSelect');
    const driveFolderId = saveToDrive ? folderSelect.value : null;
    const driveFolderName = saveToDrive ? folderSelect.selectedOptions[0]?.dataset.name : null;
    if (saveToDrive && !driveFolderId) { msg.textContent = 'Please select a Drive folder, or turn off "Save to Google Drive".'; return; }

    const splitScreenMode = document.getElementById('splitScreenMode').value;
    const secondaryUrl = document.getElementById('secondaryUrlInput').value.trim();
    if (splitScreenMode && !secondaryUrl) { msg.textContent = 'Split screen needs a second video URL.'; return; }

    const effects = {
      colorGrade: document.getElementById('colorGrade').value || null,
      effectCues,
      autoLoopEffects: Array.from(document.querySelectorAll('.loopEffect:checked')).map((el) => el.value),
      autoLoopIntervalSeconds: Number(document.getElementById('loopIntervalInput').value) || 5,
      speedFactor: Number(document.getElementById('speedFactor').value) || 1,
      beatSyncBpm: document.getElementById('beatSyncBpm').value ? Number(document.getElementById('beatSyncBpm').value) : null,
      freezeFrameAt: document.getElementById('freezeFrameAt').value ? Number(document.getElementById('freezeFrameAt').value) : null,
      freezeFrameDuration: Number(document.getElementById('freezeFrameDuration').value) || 1,
      blackAndWhite: document.getElementById('blackAndWhite').checked,
      verticalConvert: document.getElementById('verticalConvert').checked,
      vineBoomAt: document.getElementById('vineBoomAt').value ? Number(document.getElementById('vineBoomAt').value) : null,
      splitScreen: splitScreenMode || null,
    };

    msg.textContent = 'Starting…';
    document.getElementById('createBtn').disabled = true;
    try {
      await apiFetch('/videoedit/create', {
        method: 'POST',
        body: JSON.stringify({ url, secondaryUrl: secondaryUrl || null, effects, driveFolderId, driveFolderName, saveToDrive }),
      });
      msg.textContent = 'Started! Editing can take a few minutes depending on the effects chosen — check the history table below.';
      effectCues = [];
      document.querySelectorAll('.loopEffect:checked').forEach((cb) => { cb.checked = false; });
      renderCueList();
      loadJobs();
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
    } finally {
      document.getElementById('createBtn').disabled = false;
    }
  });
})();
