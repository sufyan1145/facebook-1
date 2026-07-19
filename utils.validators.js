const { body, param, validationResult } = require('express-validator');

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

const registerRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').trim().notEmpty().withMessage('Name is required'),
];

const loginRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const scheduleRules = [
  body('pageId').notEmpty().withMessage('Facebook Page is required'),
  body('folderId').notEmpty().withMessage('Google Drive folder is required'),
  body('uploadTime').matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('uploadTime must be HH:mm'),
  body('timezone').notEmpty().withMessage('Timezone is required'),
  body('repeat').isIn(['daily', 'weekly', 'monthly', 'specific_days', 'interval_hours', 'multiple_times']).withMessage('Invalid repeat type'),
  body('intervalHours').optional({ checkFalsy: true }).isInt({ min: 1, max: 168 }).withMessage('intervalHours must be between 1 and 168'),
  body('times').optional().isArray({ max: 24 }).withMessage('times must be an array'),
  body('times.*').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('each time must be HH:mm'),
];

const idParamRule = [param('id').isUUID().withMessage('Invalid id')];

module.exports = {
  handleValidation,
  registerRules,
  loginRules,
  scheduleRules,
  idParamRule,
};
