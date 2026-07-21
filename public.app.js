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

(function setFavicon() {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = 'logo.png';
  document.head.appendChild(link);
})();

let currentUser = null;

async function requireAuthOrRedirect() {
  try {
    const res = await apiFetch('/auth/me');
    currentUser = res.data;
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
    { href: 'videogen.html', label: 'Video Generator', icon: '✦', key: 'videogen' },
    { href: 'content-schedule.html', label: 'Content Pipeline', icon: '⟳', key: 'content-schedule' },
    { href: 'pages.html', label: 'Facebook Pages', icon: '▣', key: 'pages' },
    { href: 'schedule.html', label: 'Schedules', icon: '◷', key: 'schedule' },
    { href: 'queue.html', label: 'Queue', icon: '≣', key: 'queue' },
    { href: 'history.html', label: 'Upload History', icon: '⬒', key: 'history' },
    { href: 'logs.html', label: 'Activity Logs', icon: '▦', key: 'logs' },
    { href: 'settings.html', label: 'Settings', icon: '⚙', key: 'settings' },
  ];
  if (currentUser && currentUser.isAdmin) {
    items.push({ href: 'admin.html', label: 'Admin', icon: '★', key: 'admin' });
  }
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

function setupMobileNav() {
  const sidebar = document.querySelector('.sidebar');
  const topbar = document.querySelector('.topbar');
  if (!sidebar || !topbar) return; // auth pages have no sidebar/topbar

  const toggle = document.createElement('button');
  toggle.className = 'menu-toggle';
  toggle.setAttribute('aria-label', 'Toggle menu');
  toggle.setAttribute('type', 'button');
  toggle.innerHTML = '☰';
  topbar.prepend(toggle);

  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  function closeMenu() {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  }
  function toggleMenu() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('visible');
  }

  toggle.addEventListener('click', toggleMenu);
  overlay.addEventListener('click', closeMenu);
  sidebar.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') closeMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) closeMenu();
  });
}

setupMobileNav();

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
