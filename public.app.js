/* Shared frontend helpers: API client, auth guard, nav rendering */

const API_BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return data;
}

async function requireAuthOrRedirect() {
  try {
    const res = await apiFetch('/auth/me');
    return res.data;
  } catch {
    window.location.href = 'login.html';
    return null;
  }
}

function renderNav(active) {
  const items = [
    { href: 'dashboard.html', label: 'Dashboard', icon: '◆', key: 'dashboard' },
    { href: 'drive.html', label: 'Drive Folders', icon: '▤', key: 'drive' },
    { href: 'pages.html', label: 'Facebook Pages', icon: '▣', key: 'pages' },
    { href: 'schedule.html', label: 'Schedules', icon: '◷', key: 'schedule' },
    { href: 'queue.html', label: 'Queue', icon: '≣', key: 'queue' },
    { href: 'history.html', label: 'Upload History', icon: '⬒', key: 'history' },
    { href: 'logs.html', label: 'Activity Logs', icon: '▦', key: 'logs' },
    { href: 'settings.html', label: 'Settings', icon: '⚙', key: 'settings' },
  ];
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = items
    .map(
      (i) =>
        `<a href="${i.href}" class="${i.key === active ? 'active' : ''}"><span class="nav-icon">${i.icon}</span>${i.label}</a>`
    )
    .join('');
}

async function logout() {
  await apiFetch('/auth/logout', { method: 'POST' });
  window.location.href = 'login.html';
}

const signOutBtn = document.getElementById('signOutBtn');
if (signOutBtn) signOutBtn.addEventListener('click', logout);

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
