const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /users — list (admin/owner only, or filter by role)
router.get('/', requireAuth, async (req, res) => {
  const { role } = req.query;
  try {
    const params = [];
    let where = '';
    if (role) { params.push(role); where = `WHERE role = $1`; }
    const { rows } = await pool.query(
      `SELECT id, name, email, role, created_at FROM users ${where} ORDER BY name`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /users/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
