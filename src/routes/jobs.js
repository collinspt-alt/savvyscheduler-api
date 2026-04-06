const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /jobs — list with filters
router.get('/', requireAuth, async (req, res) => {
  const { status, tech_id, date, search, page = 1, per_page = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(per_page);
  const conditions = [];
  const params = [];

  if (req.user.role === 'tech') {
    params.push(req.user.id);
    conditions.push(`tech_id = $${params.length}`);
  } else {
    if (tech_id) { params.push(tech_id); conditions.push(`tech_id = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (date) { params.push(date); conditions.push(`DATE(scheduled_date) = $${params.length}`); }
    if (req.query.date_start && req.query.date_end) {
      params.push(req.query.date_start); conditions.push(`DATE(scheduled_date) >= $${params.length}`);
      params.push(req.query.date_end);   conditions.push(`DATE(scheduled_date) <= $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(title ILIKE $${params.length} OR customer_name ILIKE $${params.length})`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(`SELECT COUNT(*) FROM jobs ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(parseInt(per_page), offset);
    const jobsRes = await pool.query(
      `SELECT * FROM jobs ${where} ORDER BY scheduled_date ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ jobs: jobsRes.rows, total, page: parseInt(page), per_page: parseInt(per_page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /jobs/today
router.get('/today', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const conditions = [`DATE(scheduled_date) = $1`];
    const params = [today];

    if (req.user.role === 'tech') {
      params.push(req.user.id);
      conditions.push(`tech_id = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT * FROM jobs WHERE ${conditions.join(' AND ')} ORDER BY scheduled_date ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /jobs/route — tech's route for a date
router.get('/route', requireAuth, async (req, res) => {
  const { techId, date } = req.query;
  const id = req.user.role === 'tech' ? req.user.id : techId;
  const d = date || new Date().toISOString().split('T')[0];

  try {
    const { rows } = await pool.query(
      `SELECT j.*, 
        COALESCE(
          json_agg(jc ORDER BY jc.sort_order) FILTER (WHERE jc.id IS NOT NULL), '[]'
        ) AS checklist
       FROM jobs j
       LEFT JOIN job_checklist jc ON jc.job_id = j.id
       WHERE j.tech_id = $1 AND DATE(j.scheduled_date) = $2
       GROUP BY j.id
       ORDER BY j.scheduled_date ASC`,
      [id, d]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /jobs/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!jobRows[0]) return res.status(404).json({ error: 'Job not found' });

    const { rows: checkRows } = await pool.query(
      'SELECT * FROM job_checklist WHERE job_id = $1 ORDER BY sort_order',
      [req.params.id]
    );

    res.json({ ...jobRows[0], checklist: checkRows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /jobs
router.post('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, estimated_duration, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO jobs (title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, estimated_duration, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, estimated_duration || 90, notes]
    );

    await pool.query(
      `INSERT INTO activity_log (type, message, job_id, user_id) VALUES ($1,$2,$3,$4)`,
      ['created', `${title} job created for ${customer_name}`, rows[0].id, req.user.id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /jobs/:id/status
router.patch('/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const valid = ['scheduled', 'in_progress', 'completed', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Job not found' });

    const labels = { completed: 'marked complete', in_progress: 'started', cancelled: 'cancelled', scheduled: 'rescheduled' };
    await pool.query(
      `INSERT INTO activity_log (type, message, job_id, user_id) VALUES ($1,$2,$3,$4)`,
      [status, `${rows[0].title} ${labels[status]}`, rows[0].id, req.user.id]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /jobs/:id/checklist
router.post('/:id/checklist', requireAuth, async (req, res) => {
  const { items } = req.body;
  try {
    await pool.query('DELETE FROM job_checklist WHERE job_id = $1', [req.params.id]);
    if (items?.length) {
      const values = items.map((item, i) =>
        `(${req.params.id}, '${item.label || item.l}', ${item.completed || item.d || false}, ${i})`
      ).join(',');
      await pool.query(`INSERT INTO job_checklist (job_id, label, completed, sort_order) VALUES ${values}`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /jobs/:id/complete
router.post('/:id/complete', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
