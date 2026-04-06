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
  if (!process.env.SMTP_HOST) {
    console.log(`[Email stub] Intake password for week: ${plain} → ${adminEmail}`);
    return;
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noreply@savvyscheduler.app',
      to: adminEmail,
      subject: 'SavvyScheduler — New Weekly Intake Password',
      text: `Your intake form password for this week:\n\n${plain}\n\nThis password expires in 7 days and was automatically rotated.\n\nDo not share this email.`,
      html: `<p>Your intake form password for this week:</p><h2 style="font-family:monospace;letter-spacing:2px;color:#1E293B;">${plain}</h2><p style="color:#64748B;font-size:13px;">This password expires in 7 days and was automatically rotated. Do not share this email.</p>`,
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

start();
