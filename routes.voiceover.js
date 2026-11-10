const express = require('express');
const { requireAuth } = require('./middleware.auth');
const c = require('./controllers.voiceoverController');

const router = express.Router();
router.get('/voices', requireAuth, c.voices);
router.post('/preview', requireAuth, c.preview);
router.get('/jobs', requireAuth, c.list);
router.post('/jobs', requireAuth, c.create);
router.get('/jobs/:id/file', requireAuth, c.file);
router.delete('/jobs/:id', requireAuth, c.remove);
router.get('/clone/languages', requireAuth, c.cloneLanguages);
router.get('/clones', requireAuth, c.listClones);
router.post('/clones', requireAuth, c.createClone);
router.delete('/clones/:id', requireAuth, c.removeClone);

module.exports = router;
