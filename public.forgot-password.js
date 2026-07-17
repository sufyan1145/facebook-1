document.getElementById('forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorText = document.getElementById('errorText');
  errorText.textContent = '';
  try {
    await apiFetch('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: document.getElementById('email').value }),
    });
    document.querySelector('.auth-card').innerHTML =
      '<h2>Check your inbox</h2><p class="sub">If that email is registered, a reset link is on its way.</p><a class="btn primary block mt-16" href="login.html">Back to sign in</a>';
  } catch (err) {
    errorText.textContent = err.message;
  }
});
