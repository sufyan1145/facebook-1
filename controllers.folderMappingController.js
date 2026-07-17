const { query } = require('./config.database');
const Log = require('./models.Log');

async function createMapping(req, res, next) {
  try {
    const { pageId, folderId } = req.body;
    const res1 = await query(
      `INSERT INTO folder_mapping (user_id, page_id, folder_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (page_id, folder_id) DO NOTHING
       RETURNING *`,
      [req.user.id, pageId, folderId]
    );
    await Log.record(req.user.id, 'Folder Linked', { pageId, folderId });
    res.status(201).json({ success: true, data: res1.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function listMappings(req, res, next) {
  try {
    const result = await query(
      `SELECT fm.*, p.page_name, df.folder_name
       FROM folder_mapping fm
       JOIN pages p ON p.id = fm.page_id
       JOIN drive_folders df ON df.id = fm.folder_id
       WHERE fm.user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { createMapping, listMappings };
