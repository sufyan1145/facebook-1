let selectedFileId = null;

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadPageOptions() {
  const pageSelect = document.getElementById('pageId');
  try {
    const { data: pages } = await apiFetch('/pages');
    const connected = pages.filter((p) => p.is_connected);
    pageSelect.innerHTML =
      connected.map((p) => `<option value="${p.id}">${escapeHtml(p.page_name)}${p.fb_user_name ? ' — ' + escapeHtml(p.fb_user_name) : ''}</option>`).join('') ||
      '<option value="">No pages connected</option>';
  } catch {
    pageSelect.innerHTML = '<option value="">Failed to load pages</option>';
  }
}

async function loadFolderOptions() {
  const folderSelect = document.getElementById('folderId');
  try {
    const { data: folders } = await apiFetch('/drive/folders');
    // Note: value is the real Google Drive folder id (folder_id), not the DB row id -
    // the image listing endpoint queries Drive directly with this value.
    folderSelect.innerHTML =
      folders.map((f) => `<option value="${f.folder_id}">${escapeHtml(f.folder_name)}</option>`).join('') ||
      '<option value="">No folders scanned yet</option>';
    if (folders.length) loadDriveImages(folders[0].folder_id);
  } catch {
    folderSelect.innerHTML = '<option value="">Failed to load folders</option>';
  }
}

function updatePostPreview({ imageSrc } = {}) {
  const card = document.getElementById('previewCard');
  const pageSelect = document.getElementById('pageId');
  const pageLabel = pageSelect.options[pageSelect.selectedIndex] ? pageSelect.options[pageSelect.selectedIndex].text : '';
  const message = document.getElementById('message').value;

  if (!imageSrc) {
    card.style.display = 'none';
    return;
  }

  document.getElementById('postPreviewImg').src = imageSrc;
  document.getElementById('postPreviewPage').textContent = pageLabel || 'Facebook Page';
  document.getElementById('postPreviewMessage').textContent = message || '(no caption text)';
  document.getElementById('previewStatus').textContent = 'This is exactly what will be posted.';
  card.style.display = 'block';
}

async function loadDriveImages(folderId) {
  const grid = document.getElementById('driveImageGrid');
  grid.innerHTML = '<div style="color:var(--text-faint); font-size:13px;">Loading images…</div>';
  selectedFileId = null;
  document.getElementById('selectedDriveFileId').value = '';
  document.getElementById('selectedDriveFileName').value = '';
  updatePostPreview({});

  if (!folderId) {
    grid.innerHTML = '<div style="color:var(--text-faint); font-size:13px;">Select a folder to see its images.</div>';
    return;
  }

  const pageId = document.getElementById('pageId').value;

  try {
    const qs = new URLSearchParams({ folderId });
    if (pageId) qs.set('pageId', pageId);
    const { data: images } = await apiFetch(`/text-image-posts/drive-images?${qs.toString()}`);
    if (!images.length) {
      grid.innerHTML = '<div style="color:var(--text-faint); font-size:13px;">No new images left in this folder for this Page - every image here has already been posted to it. Try another folder, another Page, or add fresh images to Drive.</div>';
      return;
    }
    grid.innerHTML = images
      .map(
        (img) => `<div class="drive-image-thumb" data-id="${img.id}" data-name="${escapeHtml(img.name)}" data-thumb="${img.thumbnailLink ? escapeHtml(img.thumbnailLink) : ''}"
          style="width:88px; height:88px; border-radius:8px; overflow:hidden; cursor:pointer; border:2px solid transparent; display:flex; align-items:center; justify-content:center; background:var(--bg-inset);">
          ${
            img.thumbnailLink
              ? `<img src="${img.thumbnailLink}" style="width:100%; height:100%; object-fit:cover;" alt="${escapeHtml(img.name)}" />`
              : `<span style="font-size:11px; padding:4px; text-align:center; word-break:break-all;">${escapeHtml(img.name)}</span>`
          }
        </div>`
      )
      .join('');

    grid.querySelectorAll('.drive-image-thumb').forEach((el) => {
      el.addEventListener('click', () => {
        grid.querySelectorAll('.drive-image-thumb').forEach((t) => (t.style.borderColor = 'transparent'));
        el.style.borderColor = 'var(--accent, #22c55e)';
        selectedFileId = el.dataset.id;
        document.getElementById('selectedDriveFileId').value = el.dataset.id;
        document.getElementById('selectedDriveFileName').value = el.dataset.name;

        // Drive thumbnail links end in a small size like "=s220" - bump it up for the Preview card.
        const bigThumb = el.dataset.thumb ? el.dataset.thumb.replace(/=s\d+$/, '=s800') : '';
        updatePostPreview({ imageSrc: bigThumb || null });
      });
    });
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--danger, #f87171); font-size:13px;">${escapeHtml(err.message)}</div>`;
  }
}

let historyPosts = [];

function renderHistoryRows(posts) {
  historyPosts = posts;
  const body = document.getElementById('historyBody');
  if (!posts.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No posts yet.</td></tr>';
    return;
  }
  const statusClass = { success: 'success', failed: 'failed', processing: 'pending', queued: 'pending' };
  body.innerHTML = posts
    .map((p) => {
      const resultCell =
        p.status === 'failed'
          ? `<span style="color:var(--signal-red); font-size:12px;">${escapeHtml(p.error_message || '')}</span>`
          : p.status === 'success'
          ? `<button class="btn xs" data-history-preview="${p.id}">Preview</button>`
          : '—';
      return `<tr>
        <td>${escapeHtml(p.page_name || '—')}</td>
        <td style="text-transform:capitalize;">${escapeHtml(p.image_source)}</td>
        <td><span class="badge ${statusClass[p.status] || ''}">${escapeHtml(p.status)}</span></td>
        <td>${resultCell}</td>
        <td>${new Date(p.created_at).toLocaleString()}</td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-history-preview]').forEach((btn) => {
    btn.addEventListener('click', () => showHistoryPreview(btn.dataset.historyPreview));
  });
}

async function showHistoryPreview(postId) {
  const post = historyPosts.find((p) => p.id === postId);
  const card = document.getElementById('previewCard');
  const statusEl = document.getElementById('previewStatus');

  card.style.display = 'block';
  statusEl.textContent = 'Loading…';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const { data } = await apiFetch(`/text-image-posts/${postId}/image`);
    document.getElementById('postPreviewImg').src = data.imageUrl;
    document.getElementById('postPreviewPage').textContent = post ? post.page_name || '' : '';
    document.getElementById('postPreviewMessage').textContent = post ? post.message || '(no caption text)' : '';
    statusEl.textContent = 'This is the actual image that was posted.';
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

async function loadHistory() {
  try {
    const { data } = await apiFetch('/text-image-posts');
    renderHistoryRows(data);
  } catch (err) {
    document.getElementById('historyBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- Scheduling ----
let schedSelectedDays = new Set();

async function loadSchedPageOptions() {
  const select = document.getElementById('schedPageId');
  try {
    const { data: pages } = await apiFetch('/pages');
    const connected = pages.filter((p) => p.is_connected);
    select.innerHTML =
      connected.map((p) => `<option value="${p.id}">${escapeHtml(p.page_name)}${p.fb_user_name ? ' — ' + escapeHtml(p.fb_user_name) : ''}</option>`).join('') ||
      '<option value="">No pages connected</option>';
  } catch {
    select.innerHTML = '<option value="">Failed to load pages</option>';
  }
}

async function loadSchedFolderOptions() {
  const select = document.getElementById('schedFolderId');
  try {
    const { data: folders } = await apiFetch('/drive/folders');
    // Uses the DB row id (f.id), matching how the video Schedules page references
    // a folder - the backend joins drive_folders on this id.
    select.innerHTML =
      folders.map((f) => `<option value="${f.id}">${escapeHtml(f.folder_name)}</option>`).join('') ||
      '<option value="">No folders scanned yet</option>';
  } catch {
    select.innerHTML = '<option value="">Failed to load folders</option>';
  }
}

function renderScheduleRows(schedules) {
  const body = document.getElementById('scheduleBody');
  if (!schedules.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No schedules yet. Create one on the left.</td></tr>';
    return;
  }
  body.innerHTML = schedules
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.page_name || '—')}</td>
        <td style="text-transform:capitalize;">${s.image_source === 'drive' ? escapeHtml(s.folder_name || 'Drive') : 'AI generated'}</td>
        <td class="mono">${escapeHtml(s.upload_time)} <span style="color:var(--text-faint);">${escapeHtml(s.timezone)}</span></td>
        <td style="text-transform:capitalize;">${s.repeat_type === 'interval_hours' ? `Every ${s.interval_hours || '?'}h` : s.repeat_type === 'multiple_times' ? (Array.isArray(s.times) ? s.times.join(', ') : 'multiple times') : s.repeat_type.replace('_', ' ')}</td>
        <td><span class="badge ${s.is_active ? 'success' : 'failed'}">${s.is_active ? 'Active' : 'Paused'}</span></td>
        <td style="display:flex; gap:6px;">
          <button class="btn sm" data-sched-toggle="${s.id}" data-active="${s.is_active}">${s.is_active ? 'Pause' : 'Resume'}</button>
          <button class="btn sm danger" data-sched-delete="${s.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('');

  body.querySelectorAll('button[data-sched-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const isActive = btn.dataset.active === 'true';
      await apiFetch(`/text-image-schedules/${btn.dataset.schedToggle}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !isActive }),
      });
      loadSchedules();
    });
  });
  body.querySelectorAll('button[data-sched-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this schedule?')) return;
      await apiFetch(`/text-image-schedules/${btn.dataset.schedDelete}`, { method: 'DELETE' });
      loadSchedules();
    });
  });
}

async function loadSchedules() {
  try {
    const { data } = await apiFetch('/text-image-schedules');
    renderScheduleRows(data);
  } catch (err) {
    document.getElementById('scheduleBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function initScheduleForm() {
  document.getElementById('schedTimezone').value = currentUser && currentUser.timezone ? currentUser.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;

  document.querySelectorAll('input[name="schedImageSource"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      document.getElementById('schedFolderField').style.display = e.target.value === 'drive' ? 'block' : 'none';
      document.getElementById('schedAiField').style.display = e.target.value === 'ai' ? 'block' : 'none';
    });
  });

  document.getElementById('schedRepeat').addEventListener('change', (e) => {
    document.getElementById('schedSpecificDaysField').style.display = e.target.value === 'specific_days' ? 'block' : 'none';
    document.getElementById('schedIntervalHoursField').style.display = e.target.value === 'interval_hours' ? 'block' : 'none';
    document.getElementById('schedMultipleTimesField').style.display = e.target.value === 'multiple_times' ? 'block' : 'none';

    if (e.target.value === 'multiple_times') {
      const uploadTimeVal = document.getElementById('schedUploadTime').value;
      const firstSlot = document.querySelector('.sched-multi-time-input');
      if (uploadTimeVal && firstSlot && !firstSlot.value) firstSlot.value = uploadTimeVal;
    }
  });

  function wireRemoveButton(btn) {
    btn.addEventListener('click', () => {
      const list = document.getElementById('schedMultipleTimesList');
      if (list.children.length > 1) btn.closest('div').remove();
    });
  }
  document.querySelectorAll('.sched-remove-time-btn').forEach(wireRemoveButton);

  document.getElementById('schedAddTimeBtn').addEventListener('click', () => {
    const list = document.getElementById('schedMultipleTimesList');
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.innerHTML = `<input type="time" class="sched-multi-time-input" style="flex:1;" />
      <button type="button" class="btn sm danger sched-remove-time-btn">Remove</button>`;
    list.appendChild(row);
    wireRemoveButton(row.querySelector('.sched-remove-time-btn'));
  });

  document.querySelectorAll('.sched-day-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const day = Number(chip.dataset.day);
      if (schedSelectedDays.has(day)) { schedSelectedDays.delete(day); chip.classList.remove('selected'); }
      else { schedSelectedDays.add(day); chip.classList.add('selected'); }
    });
  });

  document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorText = document.getElementById('schedErrorText');
    errorText.textContent = '';
    const imageSource = document.querySelector('input[name="schedImageSource"]:checked').value;

    try {
      await apiFetch('/text-image-schedules', {
        method: 'POST',
        body: JSON.stringify({
          pageId: document.getElementById('schedPageId').value,
          message: document.getElementById('schedMessage').value,
          imageSource,
          folderId: imageSource === 'drive' ? document.getElementById('schedFolderId').value : null,
          aiPrompt: imageSource === 'ai' ? document.getElementById('schedAiPrompt').value : null,
          uploadTime: document.getElementById('schedUploadTime').value,
          timezone: document.getElementById('schedTimezone').value,
          repeat: document.getElementById('schedRepeat').value,
          specificDays: Array.from(schedSelectedDays),
          intervalHours: document.getElementById('schedIntervalHours').value || null,
          times: Array.from(document.querySelectorAll('.sched-multi-time-input')).map((el) => el.value).filter(Boolean),
        }),
      });
      e.target.reset();
      schedSelectedDays.clear();
      document.querySelectorAll('.sched-day-chip.selected').forEach((c) => c.classList.remove('selected'));
      loadSchedules();
    } catch (err) {
      errorText.textContent = err.message;
    }
  });
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('text-post');

  await loadPageOptions();
  await loadFolderOptions();
  loadHistory();

  loadSchedPageOptions();
  loadSchedFolderOptions();
  loadSchedules();
  initScheduleForm();

  document.getElementById('refreshHistoryBtn').addEventListener('click', loadHistory);
  document.getElementById('refreshSchedulesBtn').addEventListener('click', loadSchedules);

  document.getElementById('folderId').addEventListener('change', (e) => loadDriveImages(e.target.value));

  document.querySelectorAll('input[name="imageSource"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      document.getElementById('driveSourceField').style.display = e.target.value === 'drive' ? 'block' : 'none';
      document.getElementById('aiSourceField').style.display = e.target.value === 'ai' ? 'block' : 'none';
      updatePostPreview({});
    });
  });

  document.getElementById('aiPrompt').addEventListener('input', () => {
    // Prompt changed since the last preview - the shown image no longer matches
    // what would actually get posted, so clear it and require a fresh preview.
    document.getElementById('aiPreviewId').value = '';
    updatePostPreview({});
  });

  document.getElementById('message').addEventListener('input', () => {
    // Keep the Preview card's caption text in sync as the person types, as
    // long as an image is already showing there.
    const img = document.getElementById('postPreviewImg');
    if (document.getElementById('previewCard').style.display !== 'none' && img.src) {
      updatePostPreview({ imageSrc: img.src });
    }
  });

  document.getElementById('pageId').addEventListener('change', () => {
    const folderId = document.getElementById('folderId').value;
    if (folderId) loadDriveImages(folderId);
    const img = document.getElementById('postPreviewImg');
    if (document.getElementById('previewCard').style.display !== 'none' && img.src) {
      updatePostPreview({ imageSrc: img.src });
    }
  });

  document.getElementById('previewAiBtn').addEventListener('click', async () => {
    const prompt = document.getElementById('aiPrompt').value.trim();
    const errorText = document.getElementById('errorText');
    errorText.textContent = '';
    if (!prompt) {
      errorText.textContent = 'Describe the image you want AI to generate first.';
      return;
    }

    const btn = document.getElementById('previewAiBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    document.getElementById('previewCard').style.display = 'block';
    document.getElementById('previewStatus').textContent = 'Generating preview…';

    try {
      const { data } = await apiFetch('/text-image-posts/preview-ai', {
        method: 'POST',
        body: JSON.stringify({ aiPrompt: prompt }),
      });
      document.getElementById('aiPreviewId').value = data.previewId;
      updatePostPreview({ imageSrc: `/api/text-image-posts/preview-ai/${data.previewId}` });
    } catch (err) {
      document.getElementById('previewStatus').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Regenerate preview';
    }
  });

  document.getElementById('postForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorText = document.getElementById('errorText');
    errorText.textContent = '';

    const imageSource = document.querySelector('input[name="imageSource"]:checked').value;
    if (imageSource === 'drive' && !document.getElementById('selectedDriveFileId').value) {
      errorText.textContent = 'Please select an image from the Drive folder above.';
      return;
    }
    if (imageSource === 'ai' && !document.getElementById('aiPrompt').value.trim()) {
      errorText.textContent = 'Please describe the image you want AI to generate.';
      return;
    }

    try {
      await apiFetch('/text-image-posts', {
        method: 'POST',
        body: JSON.stringify({
          pageId: document.getElementById('pageId').value,
          message: document.getElementById('message').value,
          imageSource,
          driveFileId: document.getElementById('selectedDriveFileId').value || null,
          driveFileName: document.getElementById('selectedDriveFileName').value || null,
          aiPrompt: document.getElementById('aiPrompt').value || null,
          previewId: document.getElementById('aiPreviewId').value || null,
        }),
      });
      e.target.reset();
      document.getElementById('driveSourceField').style.display = 'block';
      document.getElementById('aiSourceField').style.display = 'none';
      updatePostPreview({});
      document.getElementById('previewAiBtn').textContent = 'Preview image';
      selectedFileId = null;
      loadHistory();
    } catch (err) {
      errorText.textContent = err.message;
    }
  });
})();
