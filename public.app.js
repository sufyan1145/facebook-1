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

// Maps each page's filename to the section key an admin can hide. Pages not
// listed here (dashboard, admin) are never hidden this way.
const PAGE_SECTION_MAP = {
  'drive.html': 'drive',
  'videogen.html': 'videogen',
  'content-schedule.html': 'content-schedule',
  'tiktok.html': 'tiktok',
  'pages.html': 'pages',
  'schedule.html': 'schedule',
  'queue.html': 'queue',
  'history.html': 'history',
  'logs.html': 'logs',
  'settings.html': 'settings',
};

async function requireAuthOrRedirect() {
  try {
    const res = await apiFetch('/auth/me');
    currentUser = res.data;

    const page = window.location.pathname.split('/').pop();
    const section = PAGE_SECTION_MAP[page];
    const disabled = Array.isArray(currentUser.disabledSections) ? currentUser.disabledSections : [];
    if (section && disabled.includes(section)) {
      window.location.href = 'dashboard.html';
      return null;
    }

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
    { href: 'tiktok.html', label: 'TikTok Downloader', icon: '♪', key: 'tiktok' },
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

  const disabled = currentUser && Array.isArray(currentUser.disabledSections) ? currentUser.disabledSections : [];
  const visibleItems = items.filter((i) => !disabled.includes(i.key));

  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = visibleItems
    .map(
      (i) =>
        `<a href="${i.href}" class="${i.key === active ? 'active' : ''}"><span class="nav-icon">${i.icon}</span>${i.label}</a>`
    )
    .join('');

  renderCreditsBadge();
}

function renderCreditsBadge() {
  const topbar = document.querySelector('.topbar');
  if (!topbar || !currentUser || currentUser.creditsRemaining == null) return;
  let badge = document.getElementById('creditsBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'creditsBadge';
    badge.className = 'pill';
    topbar.appendChild(badge);
  }
  const remaining = currentUser.creditsRemaining;
  const total = currentUser.monthlyCredits || 45000;
  const low = remaining < total * 0.1;
  badge.className = `pill ${low ? 'warn' : 'ok'}`;
  badge.title = currentUser.creditsResetAt ? `Resets ${new Date(currentUser.creditsResetAt).toLocaleDateString()}` : '';
  badge.innerHTML = `<span class="dot"></span>${remaining.toLocaleString()} credits`;
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
