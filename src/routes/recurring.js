const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /recurring — list all templates
router.get('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name as tech_full_name
       FROM recurring_jobs r
       LEFT JOIN users u ON r.tech_id = u.id
       ORDER BY r.active DESC, r.customer_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /recurring — create template
router.post('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const {
    title, service_type, customer_name, customer_id,
    tech_id, tech_name, address,
    frequency, day_of_week, day_of_month, interval_days,
    scheduled_time, estimated_duration, notes
  } = req.body;

  if (!title || !customer_name || !frequency) {
    return res.status(400).json({ error: 'title, customer_name, and frequency required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO recurring_jobs
        (title, service_type, customer_name, customer_id, tech_id, tech_name, address,
         frequency, day_of_week, day_of_month, interval_days,
         scheduled_time, estimated_duration, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [title, service_type, customer_name, customer_id || null,
       tech_id || null, tech_name || null, address,
       frequency, day_of_week ?? null, day_of_month ?? null, interval_days ?? null,
       scheduled_time, estimated_duration || 90, notes, req.user.id]
    );

    await pool.query(
      `INSERT INTO activity_log (type, message, user_id) VALUES ($1,$2,$3)`,
      ['recurring_created', `Recurring job "${title}" created for ${customer_name} (${frequency})`, req.user.id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /recurring/:id — update template
router.patch('/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const fields = ['title','service_type','customer_name','tech_id','tech_name','address',
                  'frequency','day_of_week','day_of_month','interval_days',
                  'scheduled_time','estimated_duration','notes','active'];
  const updates = [];
  const params = [];

  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f} = $${params.length}`);
    }
  });

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE recurring_jobs SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /recurring/:id
router.delete('/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    await pool.query('UPDATE recurring_jobs SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /recurring/generate — manual trigger (also called by cron)
router.post('/generate', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const count = await generateRecurringJobs();
    res.json({ generated: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Core generation logic — exported for cron use
async function generateRecurringJobs() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Generate jobs for next 7 days window
  const windowEnd = new Date(today);
  windowEnd.setDate(windowEnd.getDate() + 7);

  const { rows: templates } = await pool.query(
    `SELECT * FROM recurring_jobs WHERE active = TRUE`
  );

  let generated = 0;

  for (const tmpl of templates) {
    const dates = getDatesInWindow(tmpl, today, windowEnd);

    for (const date of dates) {
      const dateStr = date.toISOString().split('T')[0];

      // Check if job already exists for this template + date
      const { rows: existing } = await pool.query(
        `SELECT id FROM jobs WHERE recurring_job_id = $1 AND DATE(scheduled_date) = $2`,
        [tmpl.id, dateStr]
      );
      if (existing.length) continue;

      // Check tech capacity for this date before inserting
      let needsScheduling = false;
      if (tmpl.tech_id) {
        const { rows: dayJobs } = await pool.query(
          `SELECT estimated_duration, travel_time FROM jobs
           WHERE tech_id = $1 AND DATE(scheduled_date) = $2 AND status != 'cancelled'`,
          [tmpl.tech_id, dateStr]
        );
        const DAILY_CAP = 480;
        const alreadyBlocked = dayJobs.reduce((sum, j) => {
          return sum + (j.estimated_duration || 90) + 2 * (j.travel_time ?? 15);
        }, 0);
        const thisJobBlock = (tmpl.estimated_duration || 90) + 2 * 15;
        if (alreadyBlocked + thisJobBlock > DAILY_CAP) {
          needsScheduling = true;
        }
      }

      // Create the job
      await pool.query(
        `INSERT INTO jobs
          (title, service_type, customer_name, tech_id, tech_name, address,
           scheduled_date, scheduled_time, estimated_duration, travel_time, notes,
           recurring_job_id, is_recurring, status, needs_scheduling)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,'scheduled',$13)`,
        [tmpl.title, tmpl.service_type, tmpl.customer_name, tmpl.tech_id, tmpl.tech_name,
         tmpl.address, `${dateStr}T00:00:00`, tmpl.scheduled_time,
         tmpl.estimated_duration, 15, tmpl.notes, tmpl.id, needsScheduling]
      );

      if (needsScheduling) {
        await pool.query(
          `INSERT INTO activity_log (type, message) VALUES ($1,$2)`,
          ['needs_scheduling', `Recurring job "${tmpl.title}" for ${tmpl.customer_name} on ${dateStr} flagged — tech at capacity`]
        );
      }

      generated++;
    }

    // Update last_generated
    if (dates.length) {
      await pool.query(
        `UPDATE recurring_jobs SET last_generated = $1 WHERE id = $2`,
        [windowEnd.toISOString().split('T')[0], tmpl.id]
      );
    }
  }

  return generated;
}

function getDatesInWindow(tmpl, start, end) {
  const dates = [];
  const cursor = new Date(start);

  while (cursor < end) {
    let matches = false;

    switch (tmpl.frequency) {
      case 'weekly':
        matches = cursor.getDay() === tmpl.day_of_week;
        break;
      case 'biweekly':
        if (cursor.getDay() === tmpl.day_of_week) {
          // Check if this is the right biweekly occurrence
          // Use created_at as anchor for biweekly calculation
          const anchor = new Date(tmpl.created_at);
          const anchorDay = new Date(anchor);
          // Find first occurrence of day_of_week on or after anchor
          while (anchorDay.getDay() !== tmpl.day_of_week) {
            anchorDay.setDate(anchorDay.getDate() + 1);
          }
          const weeksDiff = Math.round((cursor - anchorDay) / (7 * 86400000));
          matches = weeksDiff % 2 === 0;
        }
        break;
      case 'monthly':
        matches = cursor.getDate() === tmpl.day_of_month;
        break;
      case 'custom':
        if (tmpl.last_generated) {
          const last = new Date(tmpl.last_generated);
          const daysSince = Math.round((cursor - last) / 86400000);
          matches = daysSince >= tmpl.interval_days && daysSince % tmpl.interval_days === 0;
        } else {
          matches = cursor.getTime() === start.getTime();
        }
        break;
    }

    if (matches) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

module.exports = router;
module.exports.generateRecurringJobs = generateRecurringJobs;
