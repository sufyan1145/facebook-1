// Website Automation page: connect WordPress / Blogger, write articles, schedules, history.
let accounts = [];
let schedules = [];
let editingId = null;
let fbPages = [];
let xAccounts = [];
let pollTimer = null;
const days = new Set();

const $ = (id) => document.getElementById(id);
const ACTIVE = ['pending', 'writing', 'images', 'publishing'];
const STATUS_LABEL = { pending: 'Waiting', writing: 'Writing article…', images: 'Making pictures…', publishing: 'Publishing…', published: 'Published', draft: 'Saved as draft', failed: 'Failed' };

function say(el, text, bad) {
  el.textContent = text || '';
  el.style.color = bad ? 'var(--signal-red)' : 'var(--signal-green)';
}

// ---- websites ---------------------------------------------------------------
function renderAccounts() {
  const el = $('accountsList');
  if (!accounts.length) el.innerHTML = '<span class="empty">No website connected yet.</span>';
  else {
    el.innerHTML = accounts.map((a) => `<span class="account-chip"><span class="dot ok"></span>${a.platform === 'wordpress' ? 'WordPress' : 'Blogger'}: ${escapeHtml(a.name)}
      <button class="btn xs danger" data-id="${a.id}" title="Disconnect">✕</button></span>`).join('');
    el.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Disconnect this website? Its schedules will be removed (published articles stay on the site).')) return;
      await apiFetch(`/website/accounts/${b.dataset.id}`, { method: 'DELETE' });
      await loadAll();
    }));
  }
  $('fAccount').innerHTML = accounts.length
    ? accounts.map((a) => `<option value="${a.id}">${a.platform === 'wordpress' ? 'WordPress' : 'Blogger'} - ${escapeHtml(a.name)}</option>`).join('')
    : '<option value="">Connect a website first</option>';
}

async function loadAccounts() {
  const { data } = await apiFetch('/website/accounts');
  accounts = data;
  renderAccounts();
}

function initAccountForms() {
  $('showWpBtn').addEventListener('click', () => { $('wpForm').style.display = 'block'; });
  $('wpCancelBtn').addEventListener('click', () => { $('wpForm').style.display = 'none'; $('wpForm').reset(); });
  $('wpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('wpSaveBtn'); btn.disabled = true; btn.textContent = 'Testing…';
    say($('accountMsg'), '');
    try {
      await apiFetch('/website/accounts/wordpress', {
        method: 'POST',
        body: JSON.stringify({ name: $('wpName').value, siteUrl: $('wpUrl').value, username: $('wpUser').value, appPassword: $('wpPass').value }),
      });
      $('wpForm').reset(); $('wpForm').style.display = 'none';
      say($('accountMsg'), 'WordPress site connected.');
      await loadAll();
    } catch (err) { say($('accountMsg'), err.message, true); }
    btn.disabled = false; btn.textContent = 'Test & add';
  });
  $('bloggerBtn').addEventListener('click', async () => {
    try {
      const { data } = await apiFetch('/website/blogger/connect');
      window.location.href = data.url;
    } catch (err) { say($('accountMsg'), err.message, true); }
  });
  const q = new URLSearchParams(window.location.search);
  if (q.get('blogger_connected')) say($('accountMsg'), `Blogger connected (${q.get('blogger_connected')} blog(s)).`);
  if (q.get('blogger_error')) say($('accountMsg'), q.get('blogger_error'), true);
  if (q.toString()) history.replaceState(null, '', 'website.html');
}

// ---- topic: own prompt or category ----------------------------------------------
const CATEGORIES = {
  'Stories': ['True stories', 'Motivational stories', 'History stories', 'Mystery and unsolved', 'Moral stories for kids', 'Success stories of famous people', 'Folk tales and legends'],
  'Fitness and health': ['Gym workouts', 'Home workouts', 'Weight loss', 'Muscle building', 'Yoga and stretching', 'Running and walking', 'Healthy eating', 'Sleep and daily habits', 'Mental wellbeing'],
  'Food and home': ['Desi recipes', 'Easy cooking tips', 'Baking and desserts', 'Home cleaning and tips', 'Gardening and plants', 'DIY and crafts', 'Interior and decor'],
  'Family and relationships': ['Love and relationships', 'Parenting tips', 'Pets and animals', 'Weddings and events'],
  'Money and work': ['Personal finance', 'Earn money online', 'Jobs and careers', 'Small business', 'Crypto guides', 'Investing basics', 'Freelancing'],
  'Tech and online': ['Tech tips and how to', 'AI tools guides', 'Blogging and SEO', 'Social media growth', 'Mobile apps and games', 'Gadgets and reviews', 'Cyber safety'],
  'Learning and facts': ['Study tips', 'Learn English', 'Science facts', 'Space and universe', 'Amazing facts', 'Nature and wildlife', 'Famous people and biographies', 'History and civilizations'],
  'Lifestyle': ['Travel guides', 'Fashion and style', 'Beauty and skincare', 'Self improvement', 'Quotes and wisdom', 'Cars and bikes', 'Movies and books', 'Sports and cricket'],
};
const ALL_CATEGORIES = Object.values(CATEGORIES).flat();

function fillCategories() {
  $('fCategory').innerHTML = Object.entries(CATEGORIES).map(([group, items]) =>
    `<optgroup label="${escapeHtml(group)}">${items.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</optgroup>`).join('');
}
function topicMode() { return (document.querySelector('input[name="topicMode"]:checked') || {}).value || 'custom'; }
function syncTopicMode() {
  const cat = topicMode() === 'category';
  $('topicCustom').style.display = cat ? 'none' : '';
  $('topicCategory').style.display = cat ? '' : 'none';
}
function setTopicMode(mode) {
  const r = document.querySelector(`input[name="topicMode"][value="${mode}"]`); if (r) r.checked = true;
  syncTopicMode();
}
function currentTopic() { return topicMode() === 'category' ? $('fCategory').value : $('fTopic').value; }
function setTopic(topic) {
  if (ALL_CATEGORIES.includes(topic)) { setTopicMode('category'); $('fCategory').value = topic; $('fTopic').value = ''; }
  else { setTopicMode('custom'); $('fTopic').value = topic; }
}

// ---- share targets ------------------------------------------------------------
async function loadShareTargets() {
  try { fbPages = (await apiFetch('/pages')).data.filter((p) => p.is_connected); } catch (_) { fbPages = []; }
  try { xAccounts = (await apiFetch('/x/accounts')).data; } catch (_) { xAccounts = []; }
  const box = $('shareBox');
  if (!fbPages.length && !xAccounts.length) { box.innerHTML = '<span class="empty">No social accounts connected yet.</span>'; return; }
  const CB = 'style="width:auto; flex:none; padding:0; margin:0;"';
  box.innerHTML = fbPages.map((p) => `<label class="checkbox-row" style="cursor:pointer;"><input type="checkbox" class="share-page" value="${p.id}" ${CB} /> <span>Facebook: ${escapeHtml(p.page_name || p.page_id)}</span></label>`).join('')
    + xAccounts.map((x) => `<label class="checkbox-row" style="cursor:pointer;"><input type="checkbox" class="share-x" value="${x.id}" ${x.status === 'expired' ? 'disabled' : ''} ${CB} /> <span>X: @${escapeHtml(x.username)}${x.status === 'expired' ? ' (cookies expired)' : ''}</span></label>`).join('');
}
function pickedShare() {
  return {
    sharePageIds: Array.from(document.querySelectorAll('.share-page:checked')).map((i) => i.value),
    shareXIds: Array.from(document.querySelectorAll('.share-x:checked')).map((i) => i.value),
    fbLinkComment: $('fbLinkComment').checked,
    xLinkReply: $('xLinkReply').checked,
  };
}
function setShare(s) {
  document.querySelectorAll('.share-page').forEach((i) => { i.checked = !!s && (s.share_page_ids || []).includes(i.value); });
  document.querySelectorAll('.share-x').forEach((i) => { i.checked = !!s && (s.share_x_ids || []).includes(i.value); });
  $('fbLinkComment').checked = !!s && !!s.share_fb_link_comment;
  $('xLinkReply').checked = !!s && !!s.share_x_link_reply;
}

// ---- form -------------------------------------------------------------------
function addTimeRow(value = '') {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px;';
  row.innerHTML = '<input type="time" class="s-time" style="flex:1;" /><button type="button" class="btn sm danger">Remove</button>';
  row.querySelector('input').value = value;
  row.querySelector('button').addEventListener('click', () => { if ($('sTimesList').children.length > 1) row.remove(); });
  $('sTimesList').appendChild(row);
}

function syncRepeatFields() {
  const r = $('sRepeat').value;
  $('sIntervalField').style.display = r === 'interval_hours' ? 'block' : 'none';
  $('sTimesField').style.display = r === 'multiple_times' ? 'block' : 'none';
  $('sDaysField').style.display = r === 'specific_days' ? 'block' : 'none';
}

function syncMode() {
  const on = $('fScheduleOn').checked;
  $('schedBox').style.display = on ? 'block' : 'none';
  $('formTitle').textContent = editingId ? 'Edit schedule' : on ? 'New schedule' : 'Write an article';
  $('submitBtn').textContent = editingId ? 'Update schedule' : on ? 'Create schedule' : 'Write now';
}

function resetForm() {
  editingId = null;
  $('articleForm').reset();
  setTopicMode('custom');
  days.clear();
  document.querySelectorAll('.sched-day-chip.selected').forEach((c) => c.classList.remove('selected'));
  $('sTimesList').innerHTML = ''; addTimeRow();
  $('sTz').value = (currentUser && currentUser.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Karachi';
  $('cancelEditBtn').style.display = 'none';
  $('fScheduleOn').disabled = false;
  setShare(null);
  syncRepeatFields(); syncMode();
}

function editSchedule(s) {
  editingId = s.id;
  $('fAccount').value = s.account_id; setTopic(s.topic); $('fLanguage').value = s.language;
  $('fLength').value = s.article_length; $('fImages').value = String(s.image_count); $('fMode').value = s.publish_mode;
  $('fScheduleOn').checked = true; $('fScheduleOn').disabled = true;
  $('sTime').value = (s.upload_time || '').slice(0, 5); $('sTz').value = s.timezone; $('sRepeat').value = s.repeat_type;
  $('sInterval').value = s.interval_hours || '';
  days.clear(); document.querySelectorAll('.sched-day-chip').forEach((c) => {
    const on = (s.specific_days || []).includes(Number(c.dataset.day));
    c.classList.toggle('selected', on); if (on) days.add(Number(c.dataset.day));
  });
  $('sTimesList').innerHTML = ''; (Array.isArray(s.times) && s.times.length ? s.times : ['']).forEach(addTimeRow);
  $('cancelEditBtn').style.display = '';
  setShare(s);
  syncRepeatFields(); syncMode();
  $('articleForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initForm() {
  $('fScheduleOn').addEventListener('change', syncMode);
  $('sRepeat').addEventListener('change', () => {
    syncRepeatFields();
    if ($('sRepeat').value === 'multiple_times' && $('sTime').value) {
      const first = document.querySelector('.s-time'); if (first && !first.value) first.value = $('sTime').value;
    }
  });
  $('sAddTime').addEventListener('click', () => addTimeRow());
  document.querySelectorAll('.sched-day-chip').forEach((chip) => chip.addEventListener('click', () => {
    const d = Number(chip.dataset.day);
    if (days.has(d)) { days.delete(d); chip.classList.remove('selected'); } else { days.add(d); chip.classList.add('selected'); }
  }));
  $('cancelEditBtn').addEventListener('click', resetForm);
  fillCategories();
  document.querySelectorAll('input[name="topicMode"]').forEach((r) => r.addEventListener('change', syncTopicMode));

  $('articleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('formError').textContent = '';
    if (!$('fAccount').value) { $('formError').textContent = 'Connect a website first.'; return; }
    const payload = {
      accountId: $('fAccount').value, topic: currentTopic(), language: $('fLanguage').value,
      articleLength: $('fLength').value, imageCount: Number($('fImages').value), publishMode: $('fMode').value,
      ...pickedShare(),
    };
    const isSchedule = $('fScheduleOn').checked;
    if (isSchedule) {
      Object.assign(payload, {
        uploadTime: $('sTime').value, timezone: $('sTz').value, repeat: $('sRepeat').value,
        intervalHours: $('sInterval').value || null, specificDays: Array.from(days),
        times: Array.from(document.querySelectorAll('.s-time')).map((i) => i.value).filter(Boolean),
      });
    }
    const btn = $('submitBtn'); btn.disabled = true;
    try {
      if (isSchedule) {
        await apiFetch(editingId ? `/website/schedules/${editingId}` : '/website/schedules', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        resetForm(); await loadSchedules();
      } else {
        await apiFetch('/website/posts', { method: 'POST', body: JSON.stringify(payload) });
        $('fTopic').value = '';
        await loadPosts();
      }
    } catch (err) { $('formError').textContent = err.message; }
    btn.disabled = false;
  });
}

// ---- schedules ---------------------------------------------------------------
function repeatText(s) {
  if (s.repeat_type === 'interval_hours') return `Every ${s.interval_hours}h`;
  if (s.repeat_type === 'multiple_times') return (s.times || []).join(', ');
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const base = s.repeat_type === 'specific_days' ? (s.specific_days || []).map((d) => names[d]).join(' ') : s.repeat_type;
  return `${base} ${(s.upload_time || '').slice(0, 5)}`;
}

function renderSchedules() {
  const body = $('schedBody');
  if (!schedules.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No schedules yet. Tick "Repeat automatically" to create one.</td></tr>'; return; }
  body.innerHTML = schedules.map((s) => `<tr>
    <td>${escapeHtml(s.account_name || '—')}</td>
    <td style="max-width:200px;">${escapeHtml(s.topic.length > 60 ? s.topic.slice(0, 60) + '…' : s.topic)}</td>
    <td style="font-size:12px; text-transform:capitalize;">${escapeHtml(repeatText(s))} <span style="color:var(--text-faint);">${escapeHtml(s.timezone)}</span></td>
    <td><input type="checkbox" data-toggle="${s.id}" ${s.is_active ? 'checked' : ''} /></td>
    <td style="white-space:nowrap;"><button class="btn xs" data-edit="${s.id}">Edit</button> <button class="btn xs danger" data-del="${s.id}">Delete</button></td></tr>`).join('');
  body.querySelectorAll('[data-toggle]').forEach((c) => c.addEventListener('change', async () => {
    await apiFetch(`/website/schedules/${c.dataset.toggle}/toggle`, { method: 'PATCH', body: JSON.stringify({ isActive: c.checked }) });
  }));
  body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editSchedule(schedules.find((s) => s.id === b.dataset.edit))));
  body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this schedule?')) return;
    await apiFetch(`/website/schedules/${b.dataset.del}`, { method: 'DELETE' });
    if (editingId === b.dataset.del) resetForm();
    loadSchedules();
  }));
}

async function loadSchedules() {
  try { schedules = (await apiFetch('/website/schedules')).data; renderSchedules(); }
  catch (err) { $('schedBody').innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`; }
}

// ---- articles ------------------------------------------------------------------
function renderPosts(posts) {
  const body = $('postsBody');
  if (!posts.length) { body.innerHTML = '<tr><td colspan="6" class="empty">No articles yet.</td></tr>'; return; }
  body.innerHTML = posts.map((p) => {
    const cls = p.status === 'failed' ? 'failed' : (p.status === 'published' || p.status === 'draft') ? 'success' : 'pending';
    const title = p.title || p.topic;
    const result = p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="btn xs">${p.status === 'draft' ? 'Open draft' : 'Open'}</a>`
      : p.status === 'failed' ? `<span title="${escapeHtml(p.error_message || '')}" style="font-size:12px; color:var(--signal-red);">${escapeHtml((p.error_message || 'Failed').slice(0, 80))}</span>` : '—';
    const note = (p.image_note ? `<div style="font-size:11px; color:var(--signal-amber);">${escapeHtml(p.image_note)}</div>` : '')
      + (p.share_note ? `<div style="font-size:11px; color:${/failed/i.test(p.share_note) ? 'var(--signal-red)' : 'var(--text-faint)'};">${escapeHtml(p.share_note)}</div>` : '');
    return `<tr>
      <td style="max-width:260px;">${escapeHtml(title.length > 80 ? title.slice(0, 80) + '…' : title)}${note}</td>
      <td>${escapeHtml(p.account_name || '—')}</td>
      <td><span class="badge ${cls}">${STATUS_LABEL[p.status] || p.status}</span></td>
      <td>${result}</td>
      <td style="font-size:12px; color:var(--text-faint);">${timeAgo(p.created_at)}</td>
      <td style="white-space:nowrap;">${p.status === 'published' && p.url ? `<button class="btn xs" data-share="${p.id}" title="Share this article on the Facebook pages / X accounts ticked in the form">Share</button> ` : ''}${p.status === 'failed' ? `<button class="btn xs" data-retry="${p.id}">Retry</button> ` : ''}<button class="btn xs danger" data-delpost="${p.id}">✕</button></td></tr>`;
  }).join('');
  body.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await apiFetch(`/website/posts/${b.dataset.retry}/retry`, { method: 'POST' }); } catch (err) { alert(err.message); }
    loadPosts();
  }));
  body.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', async () => {
    const pick = pickedShare();
    if (!pick.sharePageIds.length && !pick.shareXIds.length) { alert('Pehle form mein "Share the published article" list mein Facebook page / X account tick karein.'); return; }
    b.disabled = true; b.textContent = 'Sharing…';
    try { const { data } = await apiFetch(`/website/posts/${b.dataset.share}/share`, { method: 'POST', body: JSON.stringify(pick) }); alert(data.note || 'Done'); }
    catch (err) { alert(err.message); }
    loadPosts();
  }));
  body.querySelectorAll('[data-delpost]').forEach((b) => b.addEventListener('click', async () => {
    await apiFetch(`/website/posts/${b.dataset.delpost}`, { method: 'DELETE' });
    loadPosts();
  }));
}

async function loadPosts() {
  clearTimeout(pollTimer);
  try {
    const { data } = await apiFetch('/website/posts');
    renderPosts(data);
    if (data.some((p) => ACTIVE.includes(p.status))) pollTimer = setTimeout(loadPosts, 6000);
  } catch (err) {
    $('postsBody').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadAll() {
  await loadAccounts();
  await loadShareTargets();
  await Promise.all([loadSchedules(), loadPosts()]);
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('website');
  initAccountForms();
  initForm();
  resetForm();
  $('refreshSchedBtn').addEventListener('click', loadSchedules);
  $('refreshPostsBtn').addEventListener('click', loadPosts);
  await loadAll();
})();
