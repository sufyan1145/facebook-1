document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorText = document.getElementById('errorText');
  errorText.textContent = '';
  try {
    await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    window.location.href = 'dashboard.html';
  } catch (err) {
    errorText.textContent = err.message;
  }
});
