'use strict';

const express = require('express');
const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/login', authController.login);
router.get('/verify', requireAuth, authController.verify);
router.post('/logout', authController.logout);

module.exports = router;
