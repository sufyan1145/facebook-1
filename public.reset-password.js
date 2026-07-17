document.getElementById('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorText = document.getElementById('errorText');
  const token = new URLSearchParams(window.location.search).get('token');
  try {
    await apiFetch('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: document.getElementById('password').value }),
    });
    window.location.href = 'login.html';
  } catch (err) {
    errorText.textContent = err.message;
  }
});
