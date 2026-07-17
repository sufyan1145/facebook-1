fetch('/api/auth/me', { credentials: 'include' })
  .then((r) => (r.ok ? (window.location.href = 'dashboard.html') : (window.location.href = 'login.html')))
  .catch(() => (window.location.href = 'login.html'));
