let selectedDays = new Set();

const RUN_STATUS_LABEL = {
  pending: 'Pending',
  writing_script: 'Writing script…',
  generating_voiceover: 'Recording voiceover…',
  generating_clips: 'Generating video…',
  stitching: 'Editing video…',
  uploading_drive: 'Saving to Drive…',
  posting_facebook: 'Posting to Facebook…',
  completed: 'Completed',
  failed: 'Failed',
};

function renderScheduleRows(schedules) {
  const body = document.getElementById('scheduleBody');
  if (!schedules.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No content schedules yet. Create one on the left.</td></tr>';
    return;
  }
  body.innerHTML = schedules
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.keyword)}</td>
        <td>${escapeHtml(s.page_name || '—')}</td>
        <td>${s.target_duration_seconds}s</td>
        <td style="text-transform:capitalize;">${s.repeat_type === 'interval_hours' ? `Every ${s.interval_hours || '?'}h` : s.repeat_type === 'multiple_times' ? (Array.isArray(s.times) ? s.times.join(', ') : 'multiple times') : s.repeat_type.replace('_', ' ')}</td>
        <td>${s.repeat_type === 'interval_hours' || s.repeat_type === 'multiple_times' ? '—' : `${escapeHtml(s.upload_time || '—')}${s.timezone ? ` (${escapeHtml(s.timezone)})` : ''}`}</td>
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
      await apiFetch(`/content-schedules/${btn.dataset.toggle}/toggle`, { method: 'PATCH', body: JSON.stringify({ isActive: !isActive }) });
      loadSchedules();
    });
  });
  body.querySelectorAll('button[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this content schedule?')) return;
      await apiFetch(`/content-schedules/${btn.dataset.delete}`, { method: 'DELETE' });
      loadSchedules();
    });
  });
}

async function loadSchedules() {
  try {
    const { data } = await apiFetch('/content-schedules');
    renderScheduleRows(data);
  } catch (err) {
    document.getElementById('scheduleBody').innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderRuns(runs) {
  const body = document.getElementById('runsBody');
  if (!runs.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">No runs yet.</td></tr>';
    return;
  }
  body.innerHTML = runs
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.keyword)}</td>
        <td>${escapeHtml(r.topic || '—')}</td>
        <td>
          <span class="badge ${r.status === 'completed' ? 'success' : r.status === 'failed' ? 'failed' : ''}">${RUN_STATUS_LABEL[r.status] || r.status}</span>
          ${r.status === 'failed' && r.error_message ? `<div style="font-size:11px; color:var(--signal-red); margin-top:4px;">${escapeHtml(r.error_message)}</div>` : ''}
        </td>
        <td style="font-size:12px; color:var(--text-muted);">${new Date(r.created_at).toLocaleString()}</td>
      </tr>`
    )
    .join('');
}

async function loadRuns() {
  try {
    const { data } = await apiFetch('/content-schedules/runs');
    renderRuns(data);
  } catch (err) {
    document.getElementById('runsBody').innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
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
  renderNav('content-schedule');
  document.getElementById('timezone').value = user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  loadOptions();
  loadSchedules();
  loadRuns();
  document.getElementById('refreshRunsBtn').addEventListener('click', loadRuns);

  document.getElementById('postToFacebook').addEventListener('change', (e) => {
    document.getElementById('pageIdField').style.display = e.target.checked ? 'block' : 'none';
  });

  function syncDurationOptions() {
    const isLongForm = document.getElementById('youtubeVideoType').value === 'long';
    const durationSelect = document.getElementById('duration');
    Array.from(durationSelect.options).forEach((opt) => {
      const isLongOnly = Number(opt.value) > 120;
      opt.disabled = isLongOnly && !isLongForm;
    });
    if (durationSelect.options[durationSelect.selectedIndex].disabled) durationSelect.value = '60';
  }
  document.getElementById('youtubeVideoType').addEventListener('change', syncDurationOptions);
  syncDurationOptions();

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

  document.getElementById('contentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorText = document.getElementById('errorText');
    errorText.textContent = '';
    try {
      await apiFetch('/content-schedules', {
        method: 'POST',
        body: JSON.stringify({
          keyword: document.getElementById('keyword').value,
          pageId: document.getElementById('postToFacebook').checked ? document.getElementById('pageId').value : null,
          postToFacebook: document.getElementById('postToFacebook').checked,
          folderId: document.getElementById('folderId').value,
          targetDurationSeconds: Number(document.getElementById('duration').value),
          voiceName: document.getElementById('voiceName').value,
          language: document.getElementById('language').value,
          uploadTime: document.getElementById('uploadTime').value,
          timezone: document.getElementById('timezone').value,
          repeat: document.getElementById('repeat').value,
          specificDays: Array.from(selectedDays),
          intervalHours: document.getElementById('intervalHours').value || null,
          times: Array.from(document.querySelectorAll('.multi-time-input')).map((el) => el.value).filter(Boolean),
          masterPrompt: document.getElementById('masterPrompt').value,
          caption: document.getElementById('caption').value,
          hashtags: document.getElementById('hashtags').value,
          publishImmediately: document.getElementById('publishImmediately').checked,
          youtubeTokenId: document.getElementById('youtubeTokenId').value || null,
          youtubeVideoType: document.getElementById('youtubeVideoType').value,
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
