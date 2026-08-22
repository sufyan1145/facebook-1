const STATUS_LABEL = {
  pending: 'Pending',
  downloading: 'Downloading…',
  regenerating_metadata: 'Rewriting title/hashtags…',
  dubbing: 'Transcribing & dubbing…',
  editing: 'Applying effects…',
  completed: 'Completed',
  failed: 'Failed',
};

let jobsPollTimer = null;
let currentPreviewJobId = null;

// Extracts every http(s) URL found in a blob of text, trimming common trailing
// punctuation that tends to stick to a URL when it's embedded in share text
// (e.g. Douyin's "打开抖音,看看 https://v.douyin.com/xxxx/ 复制此链接..." format).
function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
  return matches.map((u) => u.replace(/[.,;:)\]}'"，。、！]+$/, ''));
}

// Wires an input so pasting into it keeps only the first URL found in the
// pasted text, discarding any extra words/text around it.
function wireSingleUrlAutoClean(inputEl) {
  inputEl.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const urls = extractUrls(pasted);
    if (urls.length) {
      e.preventDefault();
      inputEl.value = urls[0];
    }
  });
}

// Wires a textarea so pasting appends every URL found in the pasted text
// (one per line), discarding any extra words/text around each link - handles
// both a single share-text paste and many lines pasted together at once.
function wireBulkUrlsAutoClean(textareaEl) {
  textareaEl.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const urls = extractUrls(pasted);
    if (urls.length) {
      e.preventDefault();
      const existing = textareaEl.value.trim();
      textareaEl.value = (existing ? existing + '\n' : '') + urls.join('\n');
    }
  });
}

function updateBulkModeVisibility() {
  const bulk = document.getElementById('bulkMode').checked;
  document.getElementById('singleUrlField').style.display = bulk ? 'none' : 'block';
  document.getElementById('bulkUrlField').style.display = bulk ? 'block' : 'none';
  document.getElementById('splitScreenField').style.display = bulk ? 'none' : 'block';
  if (bulk) document.getElementById('secondaryUrlField').style.display = 'none';
  else updateSecondaryUrlVisibility();
  document.getElementById('createBtn').textContent = bulk ? 'Edit Videos' : 'Edit Video';
}

function renderJobs(jobs) {
  const body = document.getElementById('jobsBody');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No edits yet.</td></tr>';
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
        <td style="font-size:12px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(j.generated_title || '')}">
          ${j.generated_title ? escapeHtml(j.generated_title) : '<span style="color:var(--text-faint);">—</span>'}
          ${j.generated_title ? `<button class="btn xs" data-copy-title="${j.id}" style="margin-left:4px;">Copy</button>` : ''}
        </td>
        <td style="font-size:12px; color:var(--text-muted); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(j.generated_hashtags || '')}">${escapeHtml(j.generated_hashtags || '')}</td>
        <td>${escapeHtml(j.drive_folder_name || 'Local only')}</td>
        <td><span class="badge ${j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : ''}">${STATUS_LABEL[j.status] || j.status}</span></td>
        <td>${resultCell}</td>
        <td style="font-size:12px; color:var(--text-muted);">${timeAgo(j.created_at)}</td>
        <td><button class="btn xs danger" data-delete="${j.id}">Delete</button></td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-copy-title]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const job = jobs.find((j) => j.id === btn.dataset.copyTitle);
      if (job) navigator.clipboard.writeText(`${job.generated_title || ''}\n\n${job.generated_hashtags || ''}`).catch(() => {});
    });
  });

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

  const stillActive = jobs.some((j) => ['pending', 'downloading', 'dubbing', 'editing'].includes(j.status));
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
    document.getElementById('jobsBody').innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(err.message)}</td></tr>`;
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

function updateDubFieldsVisibility() {
  const on = document.getElementById('dubEnabled').checked;
  document.getElementById('dubFields').style.display = on ? '' : 'none';
}

function updateAutoHighlightFieldsVisibility() {
  const on = document.getElementById('autoHighlightEnabled').checked;
  document.getElementById('autoHighlightFields').style.display = on ? '' : 'none';
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
  updateDubFieldsVisibility();
  renderCueList();

  document.getElementById('refreshJobsBtn').addEventListener('click', loadJobs);
  document.getElementById('saveToDrive').addEventListener('change', updateFolderFieldVisibility);
  document.getElementById('splitScreenMode').addEventListener('change', updateSecondaryUrlVisibility);
  document.getElementById('dubEnabled').addEventListener('change', updateDubFieldsVisibility);
  document.getElementById('autoHighlightEnabled').addEventListener('change', updateAutoHighlightFieldsVisibility);
  updateAutoHighlightFieldsVisibility();
  document.getElementById('bulkMode').addEventListener('change', updateBulkModeVisibility);
  updateBulkModeVisibility();
  wireSingleUrlAutoClean(document.getElementById('urlInput'));
  wireSingleUrlAutoClean(document.getElementById('secondaryUrlInput'));
  wireBulkUrlsAutoClean(document.getElementById('bulkUrlsTextarea'));
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
    const bulk = document.getElementById('bulkMode').checked;
    const msg = document.getElementById('createMsg');

    const saveToDrive = document.getElementById('saveToDrive').checked;
    const folderSelect = document.getElementById('folderSelect');
    const driveFolderId = saveToDrive ? folderSelect.value : null;
    const driveFolderName = saveToDrive ? folderSelect.selectedOptions[0]?.dataset.name : null;
    if (saveToDrive && !driveFolderId) { msg.textContent = 'Please select a Drive folder, or turn off "Save to Google Drive".'; return; }

    const dubEnabled = document.getElementById('dubEnabled').checked;
    const autoHighlightEnabled = document.getElementById('autoHighlightEnabled').checked;

    const baseEffects = {
      dubTargetLanguage: dubEnabled ? document.getElementById('dubTargetLanguage').value : null,
      autoHighlightMinutes: autoHighlightEnabled ? (Number(document.getElementById('autoHighlightMinutes').value) || 1.5) : null,
      dubSourceLanguage: dubEnabled ? (document.getElementById('dubSourceLanguage').value || null) : null,
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
      splitScreen: null, // not available in bulk mode; single-video path below sets its own value
    };

    if (bulk) {
      const urls = extractUrls(document.getElementById('bulkUrlsTextarea').value).slice(0, 100);
      if (!urls.length) { msg.textContent = 'Please paste at least one video URL.'; return; }

      msg.textContent = `Queuing ${urls.length} video(s)…`;
      document.getElementById('createBtn').disabled = true;
      let queued = 0;
      let failed = 0;
      for (const url of urls) {
        try {
          await apiFetch('/videoedit/create', {
            method: 'POST',
            body: JSON.stringify({ url, secondaryUrl: null, effects: baseEffects, driveFolderId, driveFolderName, saveToDrive, regenerateMetadata: document.getElementById('regenerateTitleEnabled').checked }),
          });
          queued += 1;
        } catch (err) {
          failed += 1;
        }
      }
      msg.textContent = `Queued ${queued} of ${urls.length} video(s)${failed ? `, ${failed} failed to queue` : ''}. They process one at a time - check the history table below.`;
      if (queued) document.getElementById('bulkUrlsTextarea').value = '';
      loadJobs();
      document.getElementById('createBtn').disabled = false;
      return;
    }

    const url = document.getElementById('urlInput').value.trim();
    if (!url) { msg.textContent = 'Please paste a video URL.'; return; }

    const splitScreenMode = document.getElementById('splitScreenMode').value;
    const secondaryUrl = document.getElementById('secondaryUrlInput').value.trim();
    if (splitScreenMode && !secondaryUrl) { msg.textContent = 'Split screen needs a second video URL.'; return; }

    const effects = { ...baseEffects, splitScreen: splitScreenMode || null };

    msg.textContent = 'Starting…';
    document.getElementById('createBtn').disabled = true;
    try {
      await apiFetch('/videoedit/create', {
        method: 'POST',
        body: JSON.stringify({ url, secondaryUrl: secondaryUrl || null, effects, driveFolderId, driveFolderName, saveToDrive, regenerateMetadata: document.getElementById('regenerateTitleEnabled').checked }),
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
