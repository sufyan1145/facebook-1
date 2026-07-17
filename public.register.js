document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorText = document.getElementById('errorText');
  errorText.textContent = '';
  try {
    await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    document.querySelector('.auth-card').innerHTML =
      '<h2>Check your inbox</h2><p class="sub">We sent a verification link to your email. Verify it, then sign in.</p><a class="btn primary block mt-16" href="login.html">Go to sign in</a>';
  } catch (err) {
    errorText.textContent = err.message;
  }
});
