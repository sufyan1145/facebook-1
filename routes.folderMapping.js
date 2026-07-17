const express = require('express');
const router = express.Router();
const mappingController = require('./controllers.folderMappingController');
const { requireAuth } = require('./middleware.auth');

router.post('/', requireAuth, mappingController.createMapping);
router.get('/', requireAuth, mappingController.listMappings);

module.exports = router;
