let selectedDays = new Set();
let cachedSchedules = [];
let editingScheduleId = null;

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
        <td>${escapeHtml(s.folder_name)}</td>
        <td class="mono">${s.upload_time} <span style="color:var(--text-faint);">${escapeHtml(s.timezone)}</span></td>
        <td style="text-transform:capitalize;">${s.repeat_type === 'interval_hours' ? `Every ${s.interval_hours || '?'}h` : s.repeat_type === 'multiple_times' ? (Array.isArray(s.times) ? s.times.join(', ') : 'multiple times') : s.repeat_type.replace('_', ' ')}</td>
        <td><span class="badge ${s.is_active ? 'success' : 'failed'}">${s.is_active ? 'Active' : 'Paused'}</span></td>
        <td style="display:flex; gap:6px;">
          <button class="btn sm" data-edit="${s.id}">Edit</button>
          <button class="btn sm" data-toggle="${s.id}" data-active="${s.is_active}">${s.is_active ? 'Pause' : 'Resume'}</button>
          <button class="btn sm danger" data-delete="${s.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('');

  body.querySelectorAll('button[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const schedule = cachedSchedules.find((s) => s.id === btn.dataset.edit);
      if (schedule) enterScheduleEditMode(schedule);
    });
  });

  body.querySelectorAll('button[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const isActive = btn.dataset.active === 'true';
      await apiFetch(`/schedules/${btn.dataset.toggle}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !isActive }),
      });
      loadSchedules();
    });
  });
  body.querySelectorAll('button[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this schedule?')) return;
      await apiFetch(`/schedules/${btn.dataset.delete}`, { method: 'DELETE' });
      loadSchedules();
    });
  });
}

async function loadSchedules() {
  try {
    const { data } = await apiFetch('/schedules');
    cachedSchedules = data;
    renderScheduleRows(data);
  } catch (err) {
    document.getElementById('scheduleBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function resetMultiTimesList(values) {
  const list = document.getElementById('multipleTimesList');
  const vals = values && values.length ? values : [''];
  list.innerHTML = vals
    .map(
      () => `<div style="display:flex; gap:8px;">
        <input type="time" class="multi-time-input" style="flex:1;" />
        <button type="button" class="btn sm danger remove-time-btn">Remove</button>
      </div>`
    )
    .join('');
  list.querySelectorAll('.multi-time-input').forEach((input, i) => { input.value = vals[i] || ''; });
  list.querySelectorAll('.remove-time-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (list.children.length > 1) btn.closest('div').remove(); });
  });
}

function exitScheduleEditMode() {
  editingScheduleId = null;
  document.getElementById('scheduleSubmitBtn').textContent = 'Create Schedule';
  document.getElementById('scheduleCancelEditBtn').style.display = 'none';
  document.getElementById('scheduleForm').reset();
  document.getElementById('timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  selectedDays.clear();
  document.querySelectorAll('.day-chip.selected').forEach((c) => c.classList.remove('selected'));
  resetMultiTimesList(null);
  document.getElementById('pageIdField').style.display = 'block';
  document.getElementById('musicFolderField').style.display = 'none';
  document.getElementById('specificDaysField').style.display = 'none';
  document.getElementById('intervalHoursField').style.display = 'none';
  document.getElementById('multipleTimesField').style.display = 'none';
}

function enterScheduleEditMode(schedule) {
  editingScheduleId = schedule.id;
  document.getElementById('scheduleSubmitBtn').textContent = 'Update Schedule';
  document.getElementById('scheduleCancelEditBtn').style.display = '';

  document.getElementById('postToFacebook').checked = !!schedule.post_to_facebook;
  document.getElementById('pageIdField').style.display = schedule.post_to_facebook ? 'block' : 'none';
  if (schedule.page_id) document.getElementById('pageId').value = schedule.page_id;

  document.getElementById('folderId').value = schedule.folder_id;

  document.getElementById('autoBackgroundMusic').checked = !!schedule.auto_background_music;
  document.getElementById('musicFolderField').style.display = schedule.auto_background_music ? 'block' : 'none';
  if (schedule.music_folder_id) document.getElementById('musicFolderId').value = schedule.music_folder_id;

  document.getElementById('uploadTime').value = (schedule.upload_time || '').slice(0, 5);
  document.getElementById('timezone').value = schedule.timezone;

  document.getElementById('repeat').value = schedule.repeat_type;
  document.getElementById('repeat').dispatchEvent(new Event('change'));

  selectedDays.clear();
  document.querySelectorAll('.day-chip.selected').forEach((c) => c.classList.remove('selected'));
  (schedule.specific_days || []).forEach((day) => {
    selectedDays.add(day);
    const chip = document.querySelector(`.day-chip[data-day="${day}"]`);
    if (chip) chip.classList.add('selected');
  });

  document.getElementById('intervalHours').value = schedule.interval_hours || '';
  resetMultiTimesList(Array.isArray(schedule.times) ? schedule.times : null);

  document.getElementById('maxUploads').value = schedule.max_uploads || 1;
  document.getElementById('randomDelay').value = schedule.random_delay_seconds || 0;
  document.getElementById('caption').value = schedule.caption || '';
  document.getElementById('hashtags').value = schedule.hashtags || '';
  document.getElementById('privacy').value = schedule.privacy || 'PUBLISHED';
  document.getElementById('publishImmediately').checked = schedule.publish_immediately !== false;

  document.getElementById('youtubeTokenId').value = schedule.youtube_token_id || '';
  document.getElementById('youtubeVideoType').value = schedule.youtube_video_type || 'auto';

  document.getElementById('scheduleForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadOptions() {
  const pageSelect = document.getElementById('pageId');
  const folderSelect = document.getElementById('folderId');
  const youtubeSelect = document.getElementById('youtubeTokenId');
  try {
    const [{ data: pages }, { data: folders }, { data: youtubeAccounts }] = await Promise.all([
      apiFetch('/pages'),
      apiFetch('/drive/folders'),
      apiFetch('/auth/youtube/accounts'),
    ]);
    pageSelect.innerHTML = pages.filter((p) => p.is_connected).map((p) => `<option value="${p.id}">${escapeHtml(p.page_name)}${p.fb_user_name ? ' — ' + escapeHtml(p.fb_user_name) : ''}</option>`).join('') || '<option value="">No pages connected</option>';
    folderSelect.innerHTML = folders.map((f) => `<option value="${f.id}">${escapeHtml(f.folder_name)}</option>`).join('') || '<option value="">No folders scanned</option>';
    document.getElementById('musicFolderId').innerHTML = folders.map((f) => `<option value="${f.id}">${escapeHtml(f.folder_name)}</option>`).join('') || '<option value="">No folders scanned</option>';
    youtubeSelect.innerHTML =
      '<option value="">Don\'t post to YouTube</option>' +
      youtubeAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.channel_title || a.google_user_email || a.google_user_id)}</option>`).join('');
  } catch {
    /* leave empty */
  }
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('schedule');
  document.getElementById('timezone').value = user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  loadOptions();
  loadSchedules();

  document.getElementById('postToFacebook').addEventListener('change', (e) => {
    document.getElementById('pageIdField').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('autoBackgroundMusic').addEventListener('change', (e) => {
    document.getElementById('musicFolderField').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('repeat').addEventListener('change', (e) => {
    document.getElementById('specificDaysField').style.display = e.target.value === 'specific_days' ? 'block' : 'none';
    document.getElementById('intervalHoursField').style.display = e.target.value === 'interval_hours' ? 'block' : 'none';
    document.getElementById('multipleTimesField').style.display = e.target.value === 'multiple_times' ? 'block' : 'none';

    // Switching to "Multiple Times a Day": the Upload Time field above is ignored in this
    // mode, so carry its value into the first time slot instead of silently dropping it -
    // this is exactly what caused schedules to be created with a time nobody ever checks.
    if (e.target.value === 'multiple_times') {
      const uploadTimeVal = document.getElementById('uploadTime').value;
      const firstSlot = document.querySelector('.multi-time-input');
      if (uploadTimeVal && firstSlot && !firstSlot.value) {
        firstSlot.value = uploadTimeVal;
      }
    }
  });

  function wireRemoveButton(btn) {
    btn.addEventListener('click', () => {
      const list = document.getElementById('multipleTimesList');
      if (list.children.length > 1) btn.closest('div').remove();
    });
  }
  document.querySelectorAll('.remove-time-btn').forEach(wireRemoveButton);

  document.getElementById('addTimeBtn').addEventListener('click', () => {
    const list = document.getElementById('multipleTimesList');
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.innerHTML = `<input type="time" class="multi-time-input" style="flex:1;" />
      <button type="button" class="btn sm danger remove-time-btn">Remove</button>`;
    list.appendChild(row);
    wireRemoveButton(row.querySelector('.remove-time-btn'));
  });

  document.querySelectorAll('.day-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const day = Number(chip.dataset.day);
      if (selectedDays.has(day)) { selectedDays.delete(day); chip.classList.remove('selected'); }
      else { selectedDays.add(day); chip.classList.add('selected'); }
    });
  });

  document.getElementById('scheduleCancelEditBtn').addEventListener('click', exitScheduleEditMode);

  document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorText = document.getElementById('errorText');
    errorText.textContent = '';
    const payload = {
      pageId: document.getElementById('postToFacebook').checked ? document.getElementById('pageId').value : null,
      postToFacebook: document.getElementById('postToFacebook').checked,
      folderId: document.getElementById('folderId').value,
      uploadTime: document.getElementById('uploadTime').value,
      timezone: document.getElementById('timezone').value,
      repeat: document.getElementById('repeat').value,
      specificDays: Array.from(selectedDays),
      intervalHours: document.getElementById('intervalHours').value || null,
      times: Array.from(document.querySelectorAll('.multi-time-input'))
        .map((el) => el.value)
        .filter(Boolean),
      maxUploads: Number(document.getElementById('maxUploads').value),
      randomDelaySeconds: Number(document.getElementById('randomDelay').value),
      caption: document.getElementById('caption').value,
      hashtags: document.getElementById('hashtags').value,
      privacy: document.getElementById('privacy').value,
      publishImmediately: document.getElementById('publishImmediately').checked,
      youtubeTokenId: document.getElementById('youtubeTokenId').value || null,
      youtubeVideoType: document.getElementById('youtubeVideoType').value,
      autoBackgroundMusic: document.getElementById('autoBackgroundMusic').checked,
      musicFolderId: document.getElementById('autoBackgroundMusic').checked ? document.getElementById('musicFolderId').value : null,
    };
    try {
      if (editingScheduleId) {
        await apiFetch(`/schedules/${editingScheduleId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await apiFetch('/schedules', { method: 'POST', body: JSON.stringify(payload) });
      }
      exitScheduleEditMode();
      loadSchedules();
    } catch (err) {
      errorText.textContent = err.message;
    }
  });
})();
