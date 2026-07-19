const bcrypt = require('bcryptjs');
const User = require('./models.User');
const Log = require('./models.Log');

// Plan durations the admin can grant, in days. "trial" is the free preview.
const PLAN_DURATIONS_DAYS = {
  trial_1_day: 1,
  week_1: 7,
  month_1: 30,
  month_3: 90,
  month_6: 180,
  year_1: 365,
};

function computeExpiry(planKey, customDays) {
  const days = customDays ? Number(customDays) : PLAN_DURATIONS_DAYS[planKey];
  if (!days || Number.isNaN(days) || days <= 0) return null; // null = never expires
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function getStats(req, res, next) {
  try {
    const stats = await User.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const users = await User.listAll();
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
}

async function createUser(req, res, next) {
  try {
    const { name, email, password, planKey, customDays, isAdmin } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required' });
    }

    const existing = await User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, message: 'A user with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const planType = planKey === 'trial_1_day' ? 'trial' : 'paid';
    const planExpiresAt = computeExpiry(planKey, customDays);

    const user = await User.create({
      name,
      email,
      passwordHash,
      isEmailVerified: true,
      planType,
      planExpiresAt,
      isAdmin: !!isAdmin,
      createdBy: req.user.email,
    });

    await Log.record(req.user.id, 'Admin Created User', { createdUserEmail: email, planKey, planExpiresAt });

    res.status(201).json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        planType: user.plan_type,
        planExpiresAt: user.plan_expires_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function updatePlan(req, res, next) {
  try {
    const { id } = req.params;
    const { planKey, customDays } = req.body;

    const planType = planKey === 'trial_1_day' ? 'trial' : 'paid';
    const planExpiresAt = computeExpiry(planKey, customDays);

    const user = await User.setPlan(id, { planType, planExpiresAt });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    await Log.record(req.user.id, 'Admin Updated Plan', { targetUserId: id, planKey, planExpiresAt });

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

async function setActive(req, res, next) {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const user = await User.setActive(id, !!isActive);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    await Log.record(req.user.id, isActive ? 'Admin Activated User' : 'Admin Deactivated User', { targetUserId: id });

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

async function deleteUser(req, res, next) {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ success: false, message: "You can't delete your own account" });
    }
    await User.remove(id);
    await Log.record(req.user.id, 'Admin Deleted User', { targetUserId: id });
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStats, listUsers, createUser, updatePlan, setActive, deleteUser, PLAN_DURATIONS_DAYS };
