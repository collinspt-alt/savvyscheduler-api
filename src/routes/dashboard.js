const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /dashboard/metrics
router.get('/metrics', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const [todayJobs, completedToday, inProgress, lastWeekCompleted] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) = $1`, [today]),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) = $1 AND status = 'completed'`, [today]),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE status = 'in_progress'`),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE DATE(scheduled_date) = $1 AND status = 'completed'`, [lastWeek]),
    ]);

    const completedNow = parseInt(completedToday.rows[0].count);
    const completedPrev = parseInt(lastWeekCompleted.rows[0].count);
    const completedDelta = completedPrev > 0
      ? Math.round(((completedNow - completedPrev) / completedPrev) * 100)
      : 0;

    res.json({
      jobs_today: parseInt(todayJobs.rows[0].count),
      completed_today: completedNow,
      in_progress: parseInt(inProgress.rows[0].count),
      revenue_today: completedNow * 237,
      deltas: { completed_today: completedDelta },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
