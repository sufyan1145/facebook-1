(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('settings');

  try {
    const { data } = await apiFetch('/settings');
    document.getElementById('timezone').value = data.timezone || '';
    document.getElementById('language').value = data.language || 'en';
    document.getElementById('emailAlerts').checked = !!data.email_alerts;
    document.getElementById('autoRetry').checked = !!data.auto_retry;
    document.getElementById('uploadSpeed').value = data.upload_speed || 'normal';
    document.getElementById('queueSize').value = data.queue_size || 5;
  } catch (err) {
    document.getElementById('errorText').textContent = err.message;
  }

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorText = document.getElementById('errorText');
    errorText.textContent = '';
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          timezone: document.getElementById('timezone').value,
          language: document.getElementById('language').value,
          emailAlerts: document.getElementById('emailAlerts').checked,
          autoRetry: document.getElementById('autoRetry').checked,
          uploadSpeed: document.getElementById('uploadSpeed').value,
          queueSize: Number(document.getElementById('queueSize').value),
        }),
      });
      errorText.style.color = 'var(--signal-green)';
      errorText.textContent = 'Saved.';
    } catch (err) {
      errorText.style.color = 'var(--signal-red)';
      errorText.textContent = err.message;
    }
  });
})();
