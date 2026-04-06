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
    app.listen(PORT, () => console.log(`✓ SavvyScheduler API running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
