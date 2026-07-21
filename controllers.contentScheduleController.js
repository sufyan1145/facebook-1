const ContentSchedule = require('./models.ContentSchedule');
const ContentScheduleRun = require('./models.ContentScheduleRun');
const Log = require('./models.Log');

async function create(req, res, next) {
  try {
    const schedule = await ContentSchedule.create(req.user.id, req.body);
    await Log.record(req.user.id, 'Content Schedule Created', { keyword: schedule.keyword });
    res.json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const schedules = await ContentSchedule.listByUser(req.user.id);
    res.json({ success: true, data: schedules });
  } catch (err) {
    next(err);
  }
}

async function toggle(req, res, next) {
  try {
    const schedule = await ContentSchedule.setActive(req.user.id, req.params.id, req.body.isActive);
    res.json({ success: true, data: schedule });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await ContentSchedule.remove(req.user.id, req.params.id);
    res.json({ success: true, message: 'Content schedule deleted' });
  } catch (err) {
    next(err);
  }
}

async function listRuns(req, res, next) {
  try {
    const runs = await ContentScheduleRun.listByUser(req.user.id);
    res.json({ success: true, data: runs });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, toggle, remove, listRuns };
