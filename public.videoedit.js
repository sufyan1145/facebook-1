const STATUS_LABEL = {
  pending: 'Pending',
  downloading: 'Downloading…',
  analyzing_video: 'Watching & analyzing video…',
  regenerating_metadata: 'Rewriting title/hashtags…',
  dubbing: 'Transcribing & dubbing…',
  editing: 'Applying effects…',
  splitting: 'Cutting clips…',
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
          ? `<button class="btn xs" data-error="${j.id}" title="Error dekhne ke liye click karein" aria-label="Show error" style="background:var(--signal-red-dim);color:var(--signal-red);border:1px solid rgba(240,85,90,0.4);border-radius:50%;width:26px;height:26px;padding:0;font-weight:700;line-height:1;cursor:pointer;">!</button>`
          : j.status === 'completed' && j.clip_summary && !j.drive_file_id && !j.local_file_path
          ? '—'
          : j.status === 'completed' && j.generated_explanation
          ? `<button class="btn xs" data-preview="${j.id}" data-name="${escapeHtml(j.drive_file_name || 'video.mp4')}">Preview</button> <button class="btn xs" data-explanation="${j.id}">Script</button>`
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
        <td><span class="badge ${j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : ''}">${STATUS_LABEL[j.status] || j.status}</span>${j.clip_summary ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px; max-width:260px;">${escapeHtml(j.clip_summary)}</div>` : ''}</td>
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

  body.querySelectorAll('button[data-error]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const job = jobs.find((j) => j.id === btn.dataset.error);
      if (job) showErrorModal(job.error_message || 'Unknown error');
    });
  });

  body.querySelectorAll('button[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => showPreview(btn.dataset.preview, btn.dataset.name));
  });
  body.querySelectorAll('button[data-explanation]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const job = jobs.find((j) => j.id === btn.dataset.explanation);
      if (job) showExplanation(job.generated_explanation);
    });
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

  const stillActive = jobs.some((j) => ['pending', 'downloading', 'analyzing_video', 'dubbing', 'editing', 'splitting'].includes(j.status));
  clearTimeout(jobsPollTimer);
  if (stillActive) jobsPollTimer = setTimeout(loadJobs, 8000);
}

const warmed = new Set();

function showPreview(jobId, fileName) {
  currentPreviewJobId = jobId;
  const card = document.getElementById('previewCard');
  const player = document.getElementById('previewPlayer');
  const downloadBtn = document.getElementById('downloadFileBtn');
  player.preload = 'auto';
  player.src = `/api/videoedit/jobs/${jobId}/file`;
  player.load();
  downloadBtn.href = `/api/videoedit/jobs/${jobId}/file?download=1`;
  downloadBtn.download = fileName;
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  player.play().catch(() => {});
}

function showErrorModal(text) {
  const old = document.getElementById('errorModal');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'errorModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-card,#10151d);border:1px solid rgba(240,85,90,.4);border-radius:12px;max-width:760px;width:100%;max-height:80vh;display:flex;flex-direction:column;padding:16px;';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;color:var(--signal-red);font-weight:600;';
  head.textContent = 'Error details';
  const actions = document.createElement('div');
  const copy = document.createElement('button');
  copy.className = 'btn xs'; copy.textContent = 'Copy'; copy.style.marginRight = '6px';
  copy.onclick = () => { navigator.clipboard.writeText(text).catch(() => {}); copy.textContent = 'Copied'; };
  const close = document.createElement('button');
  close.className = 'btn xs'; close.textContent = 'Close';
  close.onclick = () => wrap.remove();
  const ai = document.createElement('button');
  ai.className = 'btn xs'; ai.textContent = 'AI se poochein'; ai.style.marginRight = '6px';
  ai.onclick = () => { wrap.remove(); if (window.openAiChat) window.openAiChat(text); };
  actions.append(ai, copy, close); head.appendChild(actions);
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--signal-red);';
  pre.textContent = text;
  box.append(head, pre); wrap.appendChild(box);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
}

function showExplanation(text) {
  document.getElementById('previewCard').style.display = 'none';
  const card = document.getElementById('explanationCard');
  document.getElementById('explanationText').textContent = text || '';
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('copyExplanationBtn').onclick = () => {
    navigator.clipboard.writeText(text || '').catch(() => {});
  };
}

async function loadJobs() {
  try {
    const { data } = await apiFetch('/videoedit/jobs');
    renderJobs(data);
    if (typeof refreshClipProgress === 'function') refreshClipProgress();
    // pre-warm server cache so Preview starts instantly
    data.filter((j) => j.status === 'completed' && !warmed.has(j.id)).slice(0, 3).forEach((j) => {
      warmed.add(j.id);
      fetch(`/api/videoedit/jobs/${j.id}/file?warm=1`, { credentials: 'include' }).catch(() => {});
    });
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

function updateNewsReactionFieldsVisibility() {
  const on = document.getElementById('newsReactionEnabled').checked;
  document.getElementById('newsReactionFields').style.display = on ? '' : 'none';
}

function updateProductExplainerFieldsVisibility() {
  const on = document.getElementById('productExplainerEnabled').checked;
  document.getElementById('productExplainerFields').style.display = on ? '' : 'none';
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


// ---------------------------------------------------------------------------
// "Make clips from a long video": paste a long video, pick the length of each
// clip and how many to make now. Clips continue from where the last batch for
// the same video ended, so a part is never made twice (see
// services.clipSplitService.js). The card is built here so no HTML file changes.
// ---------------------------------------------------------------------------
function fmtClipTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? h + ':' : ''}${h ? String(m).padStart(2, '0') : m}:${String(r).padStart(2, '0')}`;
}

let clipsProgressTimer = null;
async function refreshClipProgress() {
  const box = document.getElementById('clipsProgress');
  const urlEl = document.getElementById('clipsUrl');
  if (!box || !urlEl) return;
  const url = urlEl.value.trim();
  if (!/^https?:\/\//i.test(url)) { box.textContent = ''; return; }
  try {
    const { data } = await apiFetch(`/videoedit/clips/progress?url=${encodeURIComponent(url)}`);
    box.textContent = '';
    if (!data || !data.partsMade) {
      box.textContent = 'No clips made from this video yet - clips will start from 0:00.';
      return;
    }
    const info = document.createElement('span');
    info.textContent = data.finished
      ? `✔ ${data.partsMade} clip(s) made - the whole video is done.`
      : `✔ ${data.partsMade} clip(s) already made (up to ${fmtClipTime(data.nextStart)}${data.sourceDuration ? ' of ' + fmtClipTime(data.sourceDuration) : ''}). New clips continue from ${fmtClipTime(data.nextStart)}.`;
    box.appendChild(info);
    if (!data.busy) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn xs';
      reset.style.marginLeft = '8px';
      reset.textContent = 'Reset';
      reset.title = 'Start again from 0:00 for this video (existing clips are not deleted)';
      reset.onclick = async () => {
        if (!confirm('Reset the clip record for this video? The next clips will start from 0:00 again. (Clips that already exist are not deleted.)')) return;
        try {
          await apiFetch(`/videoedit/clips/progress?url=${encodeURIComponent(url)}`, { method: 'DELETE' });
          refreshClipProgress();
        } catch (err) { alert(err.message); }
      };
      box.appendChild(reset);
    } else {
      const busy = document.createElement('span');
      busy.style.marginLeft = '8px';
      busy.textContent = '(clips are being made now...)';
      box.appendChild(busy);
    }
  } catch (_) { box.textContent = ''; }
}

function buildClipsCard() {
  if (document.getElementById('clipsCard')) return;
  const card = document.createElement('div');
  card.className = 'card mb-16';
  card.id = 'clipsCard';
  card.innerHTML = `
    <div class="section-title">✂ Make clips from a long video</div>
    <div style="font-size:12px; color:var(--text-muted); margin:-6px 0 14px;">Paste a long video, choose how long each clip should be and how many clips you want. Each time, clips continue from where the last ones ended - a part that was already made is never made again, so you can make them part by part (for example 3 now, 3 later). In this mode only cutting is done; other editing effects are not applied.</div>
    <div class="field">
      <label for="clipsUrl">Video URL</label>
      <input id="clipsUrl" type="url" placeholder="https://..." />
    </div>
    <div id="clipsProgress" style="font-size:12px; color:var(--text-muted); margin:-4px 0 12px;"></div>
    <div class="field-row">
      <div class="field">
        <label for="clipsLength">Length of each clip</label>
        <div style="display:flex; gap:6px;">
          <input id="clipsLength" type="number" min="1" step="any" value="1" style="flex:1;" />
          <select id="clipsUnit" style="width:110px;"><option value="60" selected>minutes</option><option value="1">seconds</option></select>
        </div>
      </div>
      <div class="field">
        <label for="clipsCount">How many clips now</label>
        <input id="clipsCount" type="number" min="1" max="100" step="1" placeholder="Empty = all remaining" />
      </div>
    </div>
    <label class="checkbox-row" style="margin-bottom:10px;">
      <input id="clipsSaveToDrive" type="checkbox" checked /> Save clips to Google Drive
    </label>
    <div class="field" id="clipsFolderField">
      <label for="clipsFolder">Save into Drive folder</label>
      <select id="clipsFolder"></select>
    </div>
    <div style="font-size:11px; color:var(--text-muted); margin-bottom:10px;">Up to 100 clips per run with Drive (20 without Drive). The last piece is skipped if it is shorter than 5 seconds.</div>
    <button class="btn primary" id="clipsBtn">Make clips</button>
    <div id="clipsMsg" style="margin-top:8px; font-size:13px; color:var(--text-muted);"></div>`;

  const explainBtn = document.getElementById('explainBtn');
  const anchor = explainBtn ? explainBtn.closest('.card') : null;
  if (anchor) anchor.after(card);
  else { const c = document.querySelector('.content'); if (!c) return; c.prepend(card); }

  const folderSel = document.getElementById('clipsFolder');
  const mainFolders = document.getElementById('folderSelect');
  folderSel.innerHTML = mainFolders ? mainFolders.innerHTML : '';
  const folderField = document.getElementById('clipsFolderField');
  const saveBox = document.getElementById('clipsSaveToDrive');
  saveBox.addEventListener('change', () => { folderField.style.display = saveBox.checked ? '' : 'none'; });

  const urlEl = document.getElementById('clipsUrl');
  wireSingleUrlAutoClean(urlEl);
  const schedule = () => { clearTimeout(clipsProgressTimer); clipsProgressTimer = setTimeout(refreshClipProgress, 400); };
  urlEl.addEventListener('input', schedule);
  urlEl.addEventListener('change', schedule);
  urlEl.addEventListener('paste', schedule);

  document.getElementById('clipsBtn').addEventListener('click', async () => {
    const msg = document.getElementById('clipsMsg');
    const btn = document.getElementById('clipsBtn');
    const url = urlEl.value.trim();
    if (!url) { msg.textContent = 'Please paste a video URL.'; return; }
    const seconds = Math.round(Number(document.getElementById('clipsLength').value) * Number(document.getElementById('clipsUnit').value));
    if (!(seconds >= 5)) { msg.textContent = 'Each clip must be at least 5 seconds long.'; return; }
    const countRaw = document.getElementById('clipsCount').value.trim();
    const maxClips = countRaw ? parseInt(countRaw, 10) : null;
    if (countRaw && !(maxClips >= 1)) { msg.textContent = 'How many clips: enter 1 or more, or leave it empty for all remaining.'; return; }
    const saveToDrive = saveBox.checked;
    const driveFolderId = saveToDrive ? folderSel.value : null;
    const driveFolderName = saveToDrive ? folderSel.selectedOptions[0]?.dataset.name : null;
    if (saveToDrive && !driveFolderId) { msg.textContent = 'Please select a Drive folder, or turn off "Save clips to Google Drive".'; return; }

    btn.disabled = true;
    msg.textContent = 'Starting…';
    try {
      await apiFetch('/videoedit/create', {
        method: 'POST',
        body: JSON.stringify({
          url, secondaryUrl: null,
          effects: { clipSplit: { enabled: true, clipSeconds: seconds, maxClips } },
          driveFolderId, driveFolderName, saveToDrive, regenerateMetadata: false,
        }),
      });
      msg.textContent = 'Started! The clips appear in the history table below as they are made.';
      loadJobs();
    } catch (err) {
      msg.textContent = `Error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}


// ---------------------------------------------------------------------------
// Dub extras, added to the existing "Transcribe & dub" section (no HTML change):
//  - "Different voice for each speaker": male voices for men, female voices for
//    women, each speaker keeps their own voice (services.multiVoiceDubService.js)
//  - "Original audio volume": keep the video's own audio quietly under the dub
// ---------------------------------------------------------------------------
function buildDubExtras() {
  const fields = document.getElementById('dubFields');
  if (!fields || document.getElementById('dubMultiVoice')) return;
  const box = document.createElement('div');
  box.id = 'dubExtras';
  box.innerHTML = `
    <label class="checkbox-row" style="margin-bottom:6px; display:flex; align-items:center; justify-content:flex-start; gap:8px; text-align:left;">
      <input id="dubMultiVoice" style="width:auto; flex:0 0 auto;" type="checkbox" /> Different voice for each speaker (male / female, detected automatically)
    </label>
    <div style="font-size:11px; color:var(--text-muted); margin:0 0 12px;">The AI works out who is speaking and whether it is a man or a woman, and gives every person their own voice, spoken at the same moment as the original line. Up to 60 minutes. The speaker detection is the AI's best guess, so check the result. The "Dub voice" above is then only used if a voice cannot be chosen.</div>
    <div class="field">
      <label for="dubOriginalVolume">Original audio volume: <span id="dubOriginalVolumeLabel">0% (off - original is replaced)</span></label>
      <input id="dubOriginalVolume" type="range" min="0" max="50" step="5" value="0" />
      <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">0% = only the dub is heard (same as before). Higher = the video's original sound (voices, music, effects) stays quietly underneath. 10-20% is a good start. Only keep the original sound if you have the rights to this video's audio.</div>
    </div>`;
  fields.appendChild(box);
  const slider = document.getElementById('dubOriginalVolume');
  const label = document.getElementById('dubOriginalVolumeLabel');
  const update = () => {
    const v = Number(slider.value);
    label.textContent = v === 0 ? '0% (off - original is replaced)' : `${v}%`;
  };
  slider.addEventListener('input', update);
  update();
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('videoedit');

  await loadFolders();
  buildClipsCard();
  buildDubExtras();
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
  document.getElementById('newsReactionEnabled').addEventListener('change', updateNewsReactionFieldsVisibility);
  updateNewsReactionFieldsVisibility();
  document.getElementById('productExplainerEnabled').addEventListener('change', updateProductExplainerFieldsVisibility);
  updateProductExplainerFieldsVisibility();
  document.getElementById('bulkMode').addEventListener('change', updateBulkModeVisibility);
  updateBulkModeVisibility();
  wireSingleUrlAutoClean(document.getElementById('urlInput'));
  wireSingleUrlAutoClean(document.getElementById('secondaryUrlInput'));
  wireSingleUrlAutoClean(document.getElementById('explainUrlInput'));
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

  document.getElementById('explainBtn').addEventListener('click', async () => {
    const url = document.getElementById('explainUrlInput').value.trim();
    if (!url) { alert('Please paste a video URL.'); return; }
    const btn = document.getElementById('explainBtn');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      await apiFetch('/videoedit/create', {
        method: 'POST',
        body: JSON.stringify({ url, secondaryUrl: null, effects: { explainOnly: true, explainVoiceName: document.getElementById('explainVoiceName').value || null }, driveFolderId: null, driveFolderName: null, saveToDrive: false, regenerateMetadata: false }),
      });
      document.getElementById('explainUrlInput').value = '';
      loadJobs();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Explain this video';
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
    const newsReactionEnabled = document.getElementById('newsReactionEnabled').checked;
    const productExplainerEnabled = document.getElementById('productExplainerEnabled').checked;

    const baseEffects = {
      dubTargetLanguage: dubEnabled ? document.getElementById('dubTargetLanguage').value : null,
      autoHighlightMinutes: autoHighlightEnabled ? (Number(document.getElementById('autoHighlightMinutes').value) || 1.5) : null,
      dubSourceLanguage: dubEnabled ? (document.getElementById('dubSourceLanguage').value || null) : null,
      dubVoiceName: dubEnabled ? (document.getElementById('dubVoiceName').value || null) : null,
      dubMultiVoice: dubEnabled && !!(document.getElementById('dubMultiVoice') || {}).checked,
      dubOriginalVolume: dubEnabled ? (Number((document.getElementById('dubOriginalVolume') || {}).value || 0) / 100) : 0,
      newsReaction: newsReactionEnabled ? { enabled: true, narrationLanguage: document.getElementById('newsReactionLanguage').value, orientation: document.getElementById('newsReactionOrientation').value } : null,
      productExplainer: productExplainerEnabled ? {
        enabled: true,
        narrationLanguage: document.getElementById('productExplainerLanguage').value,
        orientation: document.getElementById('productExplainerOrientation').value,
        targetMinutes: Number(document.getElementById('productExplainerMinutes').value) || 12,
        customScript: document.getElementById('productExplainerScript').value || null,
      } : null,
      colorGrade: document.getElementById('colorGrade').value || null,
      effectCues,
      autoLoopEffects: Array.from(document.querySelectorAll('.loopEffect:checked')).map((el) => el.value),
      autoLoopIntervalSeconds: Number(document.getElementById('loopIntervalInput').value) || 5,
      speedFactor: Number(document.getElementById('speedFactor').value) || 1,
      beatSyncBpm: document.getElementById('beatSyncBpm').value ? Number(document.getElementById('beatSyncBpm').value) : null,
      freezeFrameAt: document.getElementById('freezeFrameAt').value ? Number(document.getElementById('freezeFrameAt').value) : null,
      freezeFrameDuration: Number(document.getElementById('freezeFrameDuration').value) || 1,
      blackAndWhite: document.getElementById('blackAndWhite').checked,
      verticalConvert: document.getElementById('outputRatio').value === 'vertical',
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
