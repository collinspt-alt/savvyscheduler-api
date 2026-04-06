const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /dashboard/metrics?start=2026-04-01&end=2026-04-07
router.get('/metrics', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const start = req.query.start || today;
  const end   = req.query.end   || today;
  const isToday = start === today && end === today;

  // Previous period for delta (same length, shifted back)
  const startDate = new Date(start);
  const endDate   = new Date(end);
  const days = Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
  const prevEnd   = new Date(startDate); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);   prevStart.setDate(prevStart.getDate() - days + 1);
  const prevStartStr = prevStart.toISOString().split('T')[0];
  const prevEndStr   = prevEnd.toISOString().split('T')[0];

  try {
    const [totalJobs, completed, cancelled, inProgress, prevCompleted, byTech, byService, needsScheduling] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) BETWEEN $1 AND $2`, [start, end]),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) BETWEEN $1 AND $2 AND status='completed'`, [start, end]),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) BETWEEN $1 AND $2 AND status='cancelled'`, [start, end]),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE status='in_progress'`),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) BETWEEN $1 AND $2 AND status='completed'`, [prevStartStr, prevEndStr]),
      pool.query(`SELECT tech_name, COUNT(*) as count, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
                  FROM jobs WHERE DATE(scheduled_date) BETWEEN $1 AND $2 AND tech_name IS NOT NULL
                  GROUP BY tech_name ORDER BY count DESC`, [start, end]),
      pool.query(`SELECT service_type, COUNT(*) as count
                  FROM jobs WHERE DATE(scheduled_date) BETWEEN $1 AND $2 AND service_type IS NOT NULL
                  GROUP BY service_type ORDER BY count DESC LIMIT 6`, [start, end]),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE needs_scheduling = TRUE AND status = 'scheduled'`),
    ]);

    const completedNow  = parseInt(completed.rows[0].count);
    const completedPrev = parseInt(prevCompleted.rows[0].count);
    const completedDelta = completedPrev > 0
      ? Math.round(((completedNow - completedPrev) / completedPrev) * 100)
      : null;

    const totalCount = parseInt(totalJobs.rows[0].count);
    const completionRate = totalCount > 0 ? Math.round((completedNow / totalCount) * 100) : 0;

    res.json({
      period: { start, end, days, isToday },
      jobs_total:       totalCount,
      jobs_today:       totalCount,
      completed_today:  completedNow,
      in_progress:      parseInt(inProgress.rows[0].count),
      cancelled:        parseInt(cancelled.rows[0].count),
      completion_rate:  completionRate,
      revenue:          completedNow * 237,
      revenue_today:    completedNow * 237,
      by_tech:          byTech.rows,
      by_service:       byService.rows,
      needs_scheduling: parseInt(needsScheduling.rows[0].count),
      deltas: {
        completed_today: completedDelta,
        revenue: completedDelta,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /dashboard/report?start=&end= — full job list for export
router.get('/report', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  try {
    const { rows } = await pool.query(
      `SELECT j.id, j.title, j.service_type, j.customer_name, j.tech_name,
              j.address, j.scheduled_date, j.scheduled_time, j.status,
              j.estimated_duration, j.notes,
              COALESCE(json_agg(jc ORDER BY jc.sort_order) FILTER (WHERE jc.id IS NOT NULL), '[]') as checklist
       FROM jobs j
       LEFT JOIN job_checklist jc ON jc.job_id = j.id
       WHERE DATE(j.scheduled_date) BETWEEN $1 AND $2
       GROUP BY j.id
       ORDER BY j.scheduled_date ASC, j.scheduled_time ASC`,
      [start, end]
    );
    res.json({ start, end, jobs: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
