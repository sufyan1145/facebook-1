const driveService = require('./services.googleDriveService');
const DriveFolder = require('./models.DriveFolder');
const Log = require('./models.Log');

async function browseFolders(req, res, next) {
  try {
    const folders = await driveService.listFolders(req.user.id);
    const saved = await DriveFolder.upsertMany(req.user.id, folders);
    res.json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
}

async function searchFolders(req, res, next) {
  try {
    const { q } = req.query;
    if (!q) {
      const all = await DriveFolder.listByUser(req.user.id);
      return res.json({ success: true, data: all });
    }
    const folders = await driveService.listFolders(req.user.id, { search: q });
    const saved = await DriveFolder.upsertMany(req.user.id, folders);
    res.json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
}

async function listSavedFolders(req, res, next) {
  try {
    const folders = await DriveFolder.listByUser(req.user.id);
    res.json({ success: true, data: folders });
  } catch (err) {
    next(err);
  }
}

module.exports = { browseFolders, searchFolders, listSavedFolders };
