document.getElementById('submitBtn').addEventListener('click', async () => {
  const fbId = document.getElementById('fbId').value.trim();
  const box = document.getElementById('resultBox');
  const btn = document.getElementById('submitBtn');
  box.className = 'result';
  box.style.display = 'none';

  if (!fbId || !/^\d+$/.test(fbId)) {
    box.className = 'result err';
    box.textContent = 'Please enter a valid numeric Facebook ID.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Adding...';
  try {
    const res = await fetch('/become-tester/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fbUserId: fbId }),
    });
    const data = await res.json();
    box.className = 'result ' + (data.success ? 'ok' : 'err');
    box.textContent = data.success ? "You're added as a tester! You can close this page." : (data.message || 'Something went wrong.');
  } catch (err) {
    box.className = 'result err';
    box.textContent = 'Network error - please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add me as a tester';
  }
});
