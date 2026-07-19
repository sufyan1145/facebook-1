(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;

  if (!user.isAdmin) {
    document.querySelector('.content').innerHTML =
      '<div class="empty">You do not have access to this page.</div>';
    return;
  }

  renderNav('admin');

  const pillsEl = document.getElementById('statusPills');
  pillsEl.innerHTML = `<span class="pill ok"><span class="dot"></span>Admin</span>`;

  const planLabels = {
    trial_1_day: '1 Day Trial',
    week_1: '1 Week',
    month_1: '1 Month',
    month_3: '3 Months',
    month_6: '6 Months',
    year_1: '1 Year',
  };

  function planLabelFor(planType, planExpiresAt) {
    if (!planExpiresAt) return planType === 'trial' ? 'Trial (no expiry)' : 'No expiry';
    return planType === 'trial' ? 'Trial' : 'Paid';
  }

  function statusBadge(u) {
    if (u.is_active === false) return '<span class="badge failed">Deactivated</span>';
    if (u.plan_expires_at && new Date(u.plan_expires_at) < new Date()) {
      return '<span class="badge failed">Expired</span>';
    }
    if (u.plan_type === 'trial') return '<span class="badge pending">Trial</span>';
    return '<span class="badge success">Active</span>';
  }

  async function loadStats() {
    const { data } = await apiFetch('/admin/stats');
    document.getElementById('statTotal').textContent = data.total_users;
    document.getElementById('statTrial').textContent = data.trial_users;
    document.getElementById('statPaid').textContent = data.paid_users;
    document.getElementById('statExpired').textContent = data.expired_users;
    document.getElementById('statNew7').textContent = data.new_last_7_days;
    document.getElementById('statActive24').textContent = data.active_last_24h;
  }

  async function loadUsers() {
    const { data } = await apiFetch('/admin/users');
    const body = document.getElementById('usersBody');

    if (!data.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No users yet.</td></tr>';
      return;
    }

    body.innerHTML = data
      .map(
        (u) => `
      <tr>
        <td>${escapeHtml(u.name)}${u.is_admin ? ' <span class="badge success">Admin</span>' : ''}</td>
        <td class="mono">${escapeHtml(u.email)}</td>
        <td>${planLabelFor(u.plan_type, u.plan_expires_at)}</td>
        <td>${u.plan_expires_at ? new Date(u.plan_expires_at).toLocaleDateString() : '—'}</td>
        <td>${statusBadge(u)}</td>
        <td>${u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</td>
        <td>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <select class="planSelect" data-id="${u.id}" style="padding:5px 8px; font-size:12px; background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px;">
              <option value="">Change plan…</option>
              <option value="trial_1_day">1 Day Trial</option>
              <option value="week_1">1 Week</option>
              <option value="month_1">1 Month</option>
              <option value="month_3">3 Months</option>
              <option value="month_6">6 Months</option>
              <option value="year_1">1 Year</option>
              <option value="never">No expiry</option>
            </select>
            <button class="btn sm toggleActiveBtn" data-id="${u.id}" data-active="${u.is_active !== false}">${u.is_active === false ? 'Activate' : 'Deactivate'}</button>
            <button class="btn sm danger deleteBtn" data-id="${u.id}">Delete</button>
          </div>
        </td>
      </tr>`
      )
      .join('');

    document.querySelectorAll('.planSelect').forEach((el) => {
      el.addEventListener('change', async (e) => {
        const planKey = e.target.value;
        if (!planKey) return;
        const id = e.target.dataset.id;
        try {
          await apiFetch(`/admin/users/${id}/plan`, {
            method: 'PATCH',
            body: JSON.stringify({ planKey: planKey === 'never' ? undefined : planKey, customDays: planKey === 'never' ? null : undefined }),
          });
          await Promise.all([loadUsers(), loadStats()]);
        } catch (err) {
          alert(err.message);
        }
      });
    });

    document.querySelectorAll('.toggleActiveBtn').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        const currentlyActive = e.target.dataset.active === 'true';
        try {
          await apiFetch(`/admin/users/${id}/active`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive: !currentlyActive }),
          });
          await loadUsers();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    document.querySelectorAll('.deleteBtn').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        if (!confirm('Delete this user permanently? This cannot be undone.')) return;
        try {
          await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
          await Promise.all([loadUsers(), loadStats()]);
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  document.getElementById('newPlan').addEventListener('change', (e) => {
    document.getElementById('customDaysField').style.display = e.target.value === 'custom' ? 'flex' : 'none';
  });

  document.getElementById('createUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('errorText');
    errorEl.textContent = '';

    const planValue = document.getElementById('newPlan').value;
    const payload = {
      name: document.getElementById('newName').value,
      email: document.getElementById('newEmail').value,
      password: document.getElementById('newPassword').value,
      isAdmin: document.getElementById('newIsAdmin').checked,
    };
    if (planValue === 'custom') {
      payload.customDays = document.getElementById('customDays').value;
    } else if (planValue !== 'never') {
      payload.planKey = planValue;
    }

    try {
      await apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(payload) });
      document.getElementById('createUserForm').reset();
      document.getElementById('customDaysField').style.display = 'none';
      await Promise.all([loadUsers(), loadStats()]);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  await Promise.all([loadStats(), loadUsers()]);
})();
