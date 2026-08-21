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

async function loadDriveImages(folderId) {
  const grid = document.getElementById('driveImageGrid');
  grid.innerHTML = '<div style="color:var(--text-faint); font-size:13px;">Loading images…</div>';
  selectedFileId = null;
  document.getElementById('selectedDriveFileId').value = '';
  document.getElementById('selectedDriveFileName').value = '';

  if (!folderId) {
    grid.innerHTML = '<div style="color:var(--text-faint); font-size:13px;">Select a folder to see its images.</div>';
    return;
  }

  try {
    const { data: images } = await apiFetch(`/text-image-posts/drive-images?folderId=${encodeURIComponent(folderId)}`);
    if (!images.length) {
      grid.innerHTML = '<div style="color:var(--text-faint); font-size:13px;">No images found in this folder.</div>';
      return;
    }
    grid.innerHTML = images
      .map(
        (img) => `<div class="drive-image-thumb" data-id="${img.id}" data-name="${escapeHtml(img.name)}"
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
      });
    });
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--danger, #f87171); font-size:13px;">${escapeHtml(err.message)}</div>`;
  }
}

function renderHistoryRows(posts) {
  const body = document.getElementById('historyBody');
  if (!posts.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">No posts yet.</td></tr>';
    return;
  }
  const statusClass = { success: 'success', failed: 'failed', processing: 'pending', queued: 'pending' };
  body.innerHTML = posts
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.page_name || '—')}</td>
        <td style="text-transform:capitalize;">${escapeHtml(p.image_source)}</td>
        <td><span class="badge ${statusClass[p.status] || ''}">${escapeHtml(p.status)}</span></td>
        <td>${new Date(p.created_at).toLocaleString()}</td>
      </tr>`
    )
    .join('');
}

async function loadHistory() {
  try {
    const { data } = await apiFetch('/text-image-posts');
    renderHistoryRows(data);
  } catch (err) {
    document.getElementById('historyBody').innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('text-post');

  loadPageOptions();
  loadFolderOptions();
  loadHistory();

  document.getElementById('folderId').addEventListener('change', (e) => loadDriveImages(e.target.value));

  document.querySelectorAll('input[name="imageSource"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      document.getElementById('driveSourceField').style.display = e.target.value === 'drive' ? 'block' : 'none';
      document.getElementById('aiSourceField').style.display = e.target.value === 'ai' ? 'block' : 'none';
    });
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
        }),
      });
      e.target.reset();
      document.getElementById('driveSourceField').style.display = 'block';
      document.getElementById('aiSourceField').style.display = 'none';
      selectedFileId = null;
      loadHistory();
    } catch (err) {
      errorText.textContent = err.message;
    }
  });
})();
