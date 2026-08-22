function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updatePostPreview({ imageSrc, pageLabel, message } = {}) {
  const card = document.getElementById('previewCard');
  if (!imageSrc) {
    card.style.display = 'none';
    return;
  }
  document.getElementById('postPreviewImg').src = imageSrc;
  document.getElementById('postPreviewPage').textContent = pageLabel || '';
  document.getElementById('postPreviewMessage').textContent = message || '(no caption text)';
  card.style.display = 'block';
}

// ---- History ----
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
        <td>${timeAgo(p.created_at)}</td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-history-preview]').forEach((btn) => {
    btn.addEventListener('click', () => showHistoryPreview(btn.dataset.historyPreview));
  });
}

async function showHistoryPreview(postId) {
  const post = historyPosts.find((p) => p.id === postId);
  const statusEl = document.getElementById('previewStatus');

  document.getElementById('previewCard').style.display = 'block';
  statusEl.textContent = 'Loading…';
  document.getElementById('previewCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const { data } = await apiFetch(`/text-image-posts/${postId}/image`);
    updatePostPreview({
      imageSrc: data.imageUrl,
      pageLabel: post ? post.page_name || '' : '',
      message: post ? post.message || '' : '',
    });
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
        <td style="text-transform:capitalize; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${s.image_source === 'ai' ? escapeHtml(s.topic || '') : ''}">${s.image_source === 'drive' ? escapeHtml(s.folder_name || 'Drive') : 'AI: ' + escapeHtml((s.topic || '').slice(0, 40)) + ((s.topic || '').length > 40 ? '…' : '')}</td>
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
      const isAi = e.target.value === 'ai';
      document.getElementById('schedFolderField').style.display = isAi ? 'none' : 'block';
      document.getElementById('schedMessageField').style.display = isAi ? 'none' : 'block';
      document.getElementById('schedAiField').style.display = isAi ? 'block' : 'none';
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
          message: imageSource === 'drive' ? document.getElementById('schedMessage').value : null,
          imageSource,
          folderId: imageSource === 'drive' ? document.getElementById('schedFolderId').value : null,
          topic: imageSource === 'ai' ? document.getElementById('schedTopic').value : null,
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

  loadHistory();
  document.getElementById('refreshHistoryBtn').addEventListener('click', loadHistory);
  document.getElementById('refreshSchedulesBtn').addEventListener('click', loadSchedules);

  loadSchedPageOptions();
  loadSchedFolderOptions();
  loadSchedules();
  initScheduleForm();
})();
