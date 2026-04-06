require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/jobs', require('./routes/jobs'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/users', require('./routes/users'));
app.use('/activity', require('./routes/activity'));
app.use('/recurring', require('./routes/recurring'));

// Intake — stricter CORS for public-facing routes
const intakeRouter = require('./routes/intake');
app.use('/intake', intakeRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await initSchema();
    console.log('✓ Database schema ready');

    // ── Cron jobs ──────────────────────────────────────────────────────────
    const cron = require('node-cron');
    const { generateRecurringJobs } = require('./routes/recurring');
    const { generateNewPassword } = require('./routes/intake');

    // Daily at 2am ET: generate recurring jobs for next 7 days
    cron.schedule('0 7 * * *', async () => {
      try {
        const n = await generateRecurringJobs();
        console.log(`✓ Cron: generated ${n} recurring jobs`);
      } catch (err) {
        console.error('Cron recurring error:', err);
      }
    });

    // Every Monday at 6am ET: rotate intake password and email admin
    cron.schedule('0 11 * * 1', async () => {
      try {
        const plain = await generateNewPassword();
        await emailAdminNewPassword(plain);
        console.log('✓ Cron: intake password rotated');
      } catch (err) {
        console.error('Cron password rotation error:', err);
      }
    });

    // Bootstrap: ensure an intake password exists
    const { pool } = require('./db');
    const { rows } = await pool.query(
      `SELECT id FROM intake_passwords WHERE active = TRUE AND expires_at > NOW() LIMIT 1`
    );
    if (!rows.length) {
      const plain = await generateNewPassword();
      console.log(`✓ Intake password initialized: ${plain}`);
      // Also run initial recurring job generation
      await generateRecurringJobs();
    }

    app.listen(PORT, () => console.log(`✓ SavvyScheduler API running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

async function emailAdminNewPassword(plain) {
  const adminEmail = process.env.ADMIN_EMAIL || 'ptcollins@collinstechflorida.com';
  if (!process.env.RESEND_API_KEY) {
    console.log(`[Email stub] Intake password for week: ${plain} → ${adminEmail}`);
    return;
  }
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const FROM = process.env.EMAIL_FROM || 'SavvyScheduler <onboarding@resend.dev>';
    await resend.emails.send({
      from: FROM,
      to: adminEmail,
      subject: 'SavvyScheduler — New Weekly Intake Password',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border:1px solid #E2E8F0;border-radius:12px">
        <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:16px">Weekly Intake Password</div>
        <p style="color:#64748B;font-size:14px;margin-bottom:20px">Your intake form password has been automatically rotated. Share this with customers who need access this week.</p>
        <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:20px;text-align:center;margin-bottom:20px">
          <div style="font-family:monospace;font-size:24px;font-weight:700;color:#1E40AF;letter-spacing:2px">${plain}</div>
        </div>
        <p style="color:#94A3B8;font-size:12px;margin:0">Expires in 7 days. Do not forward this email.</p>
      </div>`,
    });
    console.log(`✓ Weekly password emailed to ${adminEmail}`);
  } catch (err) {
    console.error('Password email failed:', err.message);
  }
}

start();
