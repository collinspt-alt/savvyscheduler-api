const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

function signAccess(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function signRefresh() {
  return jwt.sign({ jti: uuidv4() }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Invalid email or password' });

    const access_token = signAccess(user);
    const refresh_token = signRefresh();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [user.id, refresh_token, expires]
    );

    res.json({
      access_token,
      refresh_token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, first_name: user.name.split(' ')[0] },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const { rows } = await pool.query(
      'SELECT rt.*, u.* FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token = $1 AND rt.expires_at > NOW()',
      [refreshToken]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid refresh token' });

    const user = rows[0];
    const access_token = signAccess(user);
    res.json({ access_token });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]).catch(() => {});
  }
  res.json({ ok: true });
});

module.exports = router;
