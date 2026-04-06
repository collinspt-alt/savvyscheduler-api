const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /activity/recent
router.get('/recent', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
