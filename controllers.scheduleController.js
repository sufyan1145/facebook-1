const Schedule = require('./models.Schedule');
const Log = require('./models.Log');

async function createSchedule(req, res, next) {
  try {
    const schedule = await Schedule.create(req.user.id, req.body);
    await Log.record(req.user.id, 'Schedule Created', { scheduleId: schedule.id });
    res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
}

async function listSchedules(req, res, next) {
  try {
    const schedules = await Schedule.listByUser(req.user.id);
    res.json({ success: true, data: schedules });
  } catch (err) {
    next(err);
  }
}

async function toggleSchedule(req, res, next) {
  try {
    const { isActive } = req.body;
    const schedule = await Schedule.setActive(req.user.id, req.params.id, isActive);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    res.json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
}

async function deleteSchedule(req, res, next) {
  try {
    await Schedule.remove(req.user.id, req.params.id);
    await Log.record(req.user.id, 'Schedule Deleted', { scheduleId: req.params.id });
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { createSchedule, listSchedules, toggleSchedule, deleteSchedule };
