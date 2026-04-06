const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /users — list (owner/admin only)
router.get('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { role } = req.query;
  try {
    const params = [];
    let where = '';
    if (role) { params.push(role); where = `WHERE role = $1`; }
    const { rows } = await pool.query(
      `SELECT id, name, email, role, active, created_at FROM users ${where} ORDER BY role, name`,
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
      'SELECT id, name, email, role, active, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /users — create employee (owner/admin only)
router.post('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { name, email, role, password } = req.body;
  if (!name || !email || !role) return res.status(400).json({ error: 'name, email, and role required' });
  const validRoles = ['owner', 'admin', 'tech'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role !== 'tech' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can assign admin/owner roles' });

  try {
    const tempPassword = password || Math.random().toString(36).slice(-8);
    const hash = await bcrypt.hash(tempPassword, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1,$2,$3,$4,TRUE) RETURNING id, name, email, role, active, created_at`,
      [name, email.toLowerCase(), hash, role]
    );
    await pool.query(
      `INSERT INTO activity_log (type, message, user_id) VALUES ($1,$2,$3)`,
      ['user_created', `${name} (${role}) added to team by ${req.user.name}`, req.user.id]
    );
    res.status(201).json({ ...rows[0], temp_password: tempPassword });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /users/:id — update role or active status
router.patch('/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { role, active, name } = req.body;
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot modify your own account here' });
  }
  if (role !== undefined && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can change roles' });
  }
  try {
    const updates = [];
    const params = [];
    if (name !== undefined) { params.push(name); updates.push(`name = $${params.length}`); }
    if (role !== undefined) { params.push(role); updates.push(`role = $${params.length}`); }
    if (active !== undefined) { params.push(active); updates.push(`active = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING id, name, email, role, active, created_at`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const action = active === false ? 'deactivated' : active === true ? 'reactivated' : role ? `role changed to ${role}` : 'updated';
    await pool.query(
      `INSERT INTO activity_log (type, message, user_id) VALUES ($1,$2,$3)`,
      ['user_updated', `${rows[0].name} ${action}`, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /users/:id/password — reset password
router.patch('/:id/password', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { password } = req.body;
  const newPass = password || Math.random().toString(36).slice(-8);
  try {
    const hash = await bcrypt.hash(newPass, 10);
    const { rows } = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, name, email, role`,
      [hash, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ ...rows[0], new_password: newPass });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /users/me/preferences — save lunch break and other personal prefs
router.patch('/me/preferences', requireAuth, async (req, res) => {
  const allowed = ['lunch_start', 'lunch_duration', 'day_start', 'day_end'];
  const update = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const { rows } = await pool.query(
      `UPDATE users SET preferences = preferences || $1::jsonb WHERE id = $2
       RETURNING id, name, email, role, preferences`,
      [JSON.stringify(update), req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /users/me/preferences
router.get('/me/preferences', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT preferences FROM users WHERE id = $1', [req.user.id]
    );
    res.json(rows[0]?.preferences || {});
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
