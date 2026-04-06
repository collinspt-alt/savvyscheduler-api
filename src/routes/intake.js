const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// ── Rate limiters ────────────────────────────────────────────────────────────
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,       // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => hashIp(req.ip || req.headers['x-forwarded-for'] || 'unknown'),
  message: { error: 'Too many submissions. Please try again later.' },
  skip: (req) => false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,       // 15 min
  max: 10,
  keyGenerator: (req) => hashIp(req.ip || req.headers['x-forwarded-for'] || 'unknown'),
  message: { error: 'Too many attempts. Please wait.' },
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'savvy_salt_2026')).digest('hex');
}

function fingerprint(req) {
  // Use only User-Agent — IP is unreliable behind Railway's proxy layer
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ua + (process.env.IP_SALT || 'savvy_salt_2026')).digest('hex').slice(0, 32);
}

function sanitize(str, maxLen = 300) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/['"`;\\]/g, '').trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email) && email.length < 150;
}

function isValidPhone(phone) {
  return !phone || /^[\d\s\-().+]{7,20}$/.test(phone);
}

// ── Password management ──────────────────────────────────────────────────────
async function getCurrentPassword() {
  const { rows } = await pool.query(
    `SELECT * FROM intake_passwords WHERE active = TRUE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function generateNewPassword() {
  // Deactivate old
  await pool.query(`UPDATE intake_passwords SET active = FALSE`);

  // Generate: 3 words + 2 digits, easy to read
  const words = ['Maple','River','Stone','Cloud','Ember','Ridge','Frost','Grove',
                 'Harbor','Indigo','Jasper','Kestrel','Linden','Mossy','Nightly'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = String(Math.floor(Math.random() * 90) + 10);
  const plain = `${w1}${w2}${num}`;

  const hash = await bcrypt.hash(plain, 12);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await pool.query(
    `INSERT INTO intake_passwords (password_hash, plain_hint, active, expires_at) VALUES ($1,$2,TRUE,$3)`,
    [hash, plain, expiresAt]
  );

  return plain;
}

// ── Public routes (no auth) ──────────────────────────────────────────────────

// POST /intake/verify — check weekly password
router.post('/verify', verifyLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length > 100) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    const current = await getCurrentPassword();
    if (!current) return res.status(503).json({ error: 'Service temporarily unavailable' });

    // Timing-safe compare
    const valid = await bcrypt.compare(password, current.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Issue a short-lived CSRF token
    const token = crypto.randomBytes(32).toString('hex');
    // Store token in DB with 30-min expiry (keyed to fingerprint)
    const fp = fingerprint(req);
    await pool.query(
      `INSERT INTO activity_log (type, message) VALUES ($1,$2)`,
      ['intake_verified', `csrf:${token}:fp:${fp}`]
    );

    res.json({ ok: true, csrf: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /intake/submit — submit intake form
router.post('/submit', submitLimiter, async (req, res) => {
  // Honeypot check — bots fill hidden fields
  if (req.body.website || req.body.company || req.body._gotcha) {
    // Silent success — don't tell bots they were caught
    return res.json({ ok: true, id: 'honeypot' });
  }

  // CSRF check
  const csrfToken = req.headers['x-csrf-token'];
  if (!csrfToken || csrfToken.length !== 64) {
    return res.status(403).json({ error: 'Invalid request' });
  }

  // Verify CSRF token exists in activity_log (was issued by /verify)
  const fp = fingerprint(req);
  const { rows: csrfRows } = await pool.query(
    `SELECT id FROM activity_log WHERE type = 'intake_verified'
     AND message = $1 AND created_at > NOW() - INTERVAL '30 minutes' LIMIT 1`,
    [`csrf:${csrfToken}:fp:${fp}`]
  );
  if (!csrfRows.length) {
    return res.status(403).json({ error: 'Session expired. Please verify password again.' });
  }

  // Invalidate used CSRF token
  await pool.query(`DELETE FROM activity_log WHERE type = 'intake_verified' AND message = $1`,
    [`csrf:${csrfToken}:fp:${fp}`]);

  // Extract and sanitize
  const {
    customer_name, customer_email, customer_phone,
    address, service_type, preferred_date, preferred_time,
    frequency, notes
  } = req.body;

  const name   = sanitize(customer_name, 150);
  const email  = sanitize(customer_email, 150);
  const phone  = sanitize(customer_phone || '', 30);
  const addr   = sanitize(address, 300);
  const svc    = sanitize(service_type, 100);
  const time   = sanitize(preferred_time || '', 50);
  const note   = sanitize(notes || '', 1000);
  const freq   = ['once','weekly','biweekly','monthly'].includes(frequency) ? frequency : 'once';
  const date   = preferred_date && /^\d{4}-\d{2}-\d{2}$/.test(preferred_date) ? preferred_date : null;

  // Validate required fields
  if (!name || name.length < 2)        return res.status(400).json({ error: 'Valid name required' });
  if (!isValidEmail(email))            return res.status(400).json({ error: 'Valid email required' });
  if (!isValidPhone(phone))            return res.status(400).json({ error: 'Invalid phone number' });
  if (!addr || addr.length < 10)       return res.status(400).json({ error: 'Full address required' });
  if (!svc || svc.length < 2)          return res.status(400).json({ error: 'Service type required' });

  // Duplicate submission check (same email + service within 24h)
  const ipHash = hashIp(req.ip || req.headers['x-forwarded-for'] || 'unknown');
  const { rows: dupe } = await pool.query(
    `SELECT id FROM intake_submissions
     WHERE customer_email = $1 AND service_type = $2 AND submitted_at > NOW() - INTERVAL '24 hours'`,
    [email, svc]
  );
  if (dupe.length) {
    return res.status(429).json({ error: 'A request for this service was already submitted today.' });
  }

  try {
    const fp2 = fingerprint(req);
    const { rows } = await pool.query(
      `INSERT INTO intake_submissions
        (customer_name, customer_email, customer_phone, address, service_type,
         preferred_date, preferred_time, frequency, notes, ip_hash, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [name, email, phone || null, addr, svc, date, time || null, freq, note || null, ipHash, fp2]
    );

    // Log for admin awareness
    await pool.query(
      `INSERT INTO activity_log (type, message) VALUES ($1,$2)`,
      ['intake_submitted', `New intake from ${name} (${email}) — ${svc}`]
    );

    res.json({ ok: true, ref: `INT-${rows[0].id.toString().padStart(5, '0')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin routes (auth required) ─────────────────────────────────────────────

// GET /intake/pending — list pending submissions
router.get('/pending', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { status = 'pending' } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT s.*, u.name as reviewed_by_name
       FROM intake_submissions s
       LEFT JOIN users u ON s.reviewed_by = u.id
       WHERE s.status = $1
       ORDER BY s.submitted_at DESC`,
      [status]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /intake/approve/:id — approve and create job (+ optional recurring template)
router.post('/approve/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { tech_id, tech_name, scheduled_date, scheduled_time } = req.body;

  try {
    const { rows: sub } = await pool.query('SELECT * FROM intake_submissions WHERE id = $1', [req.params.id]);
    if (!sub[0]) return res.status(404).json({ error: 'Submission not found' });
    if (sub[0].status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const s = sub[0];

    // Create or find customer
    let customerId = null;
    const { rows: existing } = await pool.query(
      `SELECT id FROM customers WHERE email = $1 LIMIT 1`, [s.customer_email]
    );
    if (existing.length) {
      customerId = existing[0].id;
    } else {
      const { rows: newCust } = await pool.query(
        `INSERT INTO customers (name, email, phone, address) VALUES ($1,$2,$3,$4) RETURNING id`,
        [s.customer_name, s.customer_email, s.customer_phone, s.address]
      );
      customerId = newCust[0].id;
    }

    // Create the job
    const { rows: job } = await pool.query(
      `INSERT INTO jobs (title, service_type, customer_name, customer_id, tech_id, tech_name,
        address, scheduled_date, scheduled_time, estimated_duration, notes,
        is_recurring, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled') RETURNING *`,
      [
        `${s.service_type} — ${s.customer_name}`,
        s.service_type, s.customer_name, customerId,
        tech_id || null, tech_name || null,
        s.address,
        scheduled_date || s.preferred_date,
        scheduled_time || s.preferred_time,
        90, s.notes,
        s.frequency !== 'once'
      ]
    );

    // If recurring, create the template too
    let recurringId = null;
    if (s.frequency !== 'once' && tech_id) {
      const freqMap = { weekly: 'weekly', biweekly: 'biweekly', monthly: 'monthly' };
      const { rows: tmpl } = await pool.query(
        `INSERT INTO recurring_jobs
          (title, service_type, customer_name, customer_id, tech_id, tech_name, address,
           frequency, day_of_week, day_of_month, scheduled_time, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          `${s.service_type} — ${s.customer_name}`,
          s.service_type, s.customer_name, customerId,
          tech_id, tech_name, s.address,
          freqMap[s.frequency] || 'weekly',
          scheduled_date ? new Date(scheduled_date).getDay() : null,
          scheduled_date ? new Date(scheduled_date).getDate() : null,
          scheduled_time || s.preferred_time,
          s.notes,
          req.user.id
        ]
      );
      recurringId = tmpl[0].id;
      // Link job to template
      await pool.query(`UPDATE jobs SET recurring_job_id = $1 WHERE id = $2`, [recurringId, job[0].id]);
    }

    // Mark submission approved
    await pool.query(
      `UPDATE intake_submissions SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), job_id = $2 WHERE id = $3`,
      [req.user.id, job[0].id, req.params.id]
    );

    await pool.query(
      `INSERT INTO activity_log (type, message, job_id, user_id) VALUES ($1,$2,$3,$4)`,
      ['intake_approved', `Intake from ${s.customer_name} approved — job created`, job[0].id, req.user.id]
    );

    res.json({ job: job[0], recurring_id: recurringId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /intake/reject/:id
router.post('/reject/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE intake_submissions SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /intake/rotate-password — manual rotation (also called by weekly cron)
router.post('/rotate-password', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const plain = await generateNewPassword();
    res.json({ ok: true, new_password: plain });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /intake/current-password — for admin reference
router.get('/current-password', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT plain_hint, created_at, expires_at FROM intake_passwords WHERE active = TRUE AND expires_at > NOW() LIMIT 1`
    );
    if (!rows[0]) return res.status(404).json({ error: 'No active password' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.generateNewPassword = generateNewPassword;
