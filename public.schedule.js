let selectedDays = new Set();

function renderScheduleRows(schedules) {
  const body = document.getElementById('scheduleBody');
  if (!schedules.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No schedules yet. Create one on the left.</td></tr>';
    return;
  }
  body.innerHTML = schedules
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.page_name)}</td>
        <td>${escapeHtml(s.folder_name)}</td>
        <td class="mono">${s.upload_time} <span style="color:var(--text-faint);">${escapeHtml(s.timezone)}</span></td>
        <td style="text-transform:capitalize;">${s.repeat_type === 'interval_hours' ? `Every ${s.interval_hours || '?'}h` : s.repeat_type === 'multiple_times' ? (Array.isArray(s.times) ? s.times.join(', ') : 'multiple times') : s.repeat_type.replace('_', ' ')}</td>
        <td><span class="badge ${s.is_active ? 'success' : 'failed'}">${s.is_active ? 'Active' : 'Paused'}</span></td>
        <td style="display:flex; gap:6px;">
          <button class="btn sm" data-toggle="${s.id}" data-active="${s.is_active}">${s.is_active ? 'Pause' : 'Resume'}</button>
          <button class="btn sm danger" data-delete="${s.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('');

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
    renderScheduleRows(data);
  } catch (err) {
    document.getElementById('scheduleBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadOptions() {
  const pageSelect = document.getElementById('pageId');
  const folderSelect = document.getElementById('folderId');
  try {
    const [{ data: pages }, { data: folders }] = await Promise.all([apiFetch('/pages'), apiFetch('/drive/folders')]);
    pageSelect.innerHTML = pages.filter((p) => p.is_connected).map((p) => `<option value="${p.id}">${escapeHtml(p.page_name)}</option>`).join('') || '<option value="">No pages connected</option>';
    folderSelect.innerHTML = folders.map((f) => `<option value="${f.id}">${escapeHtml(f.folder_name)}</option>`).join('') || '<option value="">No folders scanned</option>';
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

  document.getElementById('repeat').addEventListener('change', (e) => {
    document.getElementById('specificDaysField').style.display = e.target.value === 'specific_days' ? 'block' : 'none';
    document.getElementById('intervalHoursField').style.display = e.target.value === 'interval_hours' ? 'block' : 'none';
    document.getElementById('multipleTimesField').style.display = e.target.value === 'multiple_times' ? 'block' : 'none';
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

  document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorText = document.getElementById('errorText');
    errorText.textContent = '';
    try {
      await apiFetch('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          pageId: document.getElementById('pageId').value,
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
        }),
      });
      e.target.reset();
      selectedDays.clear();
      document.querySelectorAll('.day-chip.selected').forEach((c) => c.classList.remove('selected'));
      loadSchedules();
    } catch (err) {
      errorText.textContent = err.message;
    }
  });
})();
