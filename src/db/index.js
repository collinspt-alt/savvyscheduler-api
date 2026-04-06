const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'tech' CHECK (role IN ('owner','admin','tech')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150),
      phone VARCHAR(30),
      address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      service_type VARCHAR(100),
      customer_id INTEGER REFERENCES customers(id),
      customer_name VARCHAR(150),
      tech_id INTEGER REFERENCES users(id),
      tech_name VARCHAR(100),
      address TEXT,
      scheduled_date TIMESTAMPTZ,
      scheduled_time VARCHAR(20),
      estimated_duration INTEGER DEFAULT 90,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
      notes TEXT,
      photo_before TEXT,
      photo_after TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS job_checklist (
      id SERIAL PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      label VARCHAR(200) NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50),
      message TEXT,
      job_id INTEGER REFERENCES jobs(id),
      user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id),
      customer_name VARCHAR(150),
      customer_email VARCHAR(150),
      amount DECIMAL(10,2) NOT NULL,
      line_items JSONB DEFAULT '[]',
      notes TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','paid','void')),
      sent_by INTEGER REFERENCES users(id),
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // New tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_jobs (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      service_type VARCHAR(100),
      customer_id INTEGER REFERENCES customers(id),
      customer_name VARCHAR(150) NOT NULL,
      tech_id INTEGER REFERENCES users(id),
      tech_name VARCHAR(100),
      address TEXT,
      frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','custom')),
      day_of_week INTEGER,
      day_of_month INTEGER,
      interval_days INTEGER,
      scheduled_time VARCHAR(20),
      estimated_duration INTEGER DEFAULT 90,
      notes TEXT,
      active BOOLEAN DEFAULT TRUE,
      last_generated DATE,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS intake_submissions (
      id SERIAL PRIMARY KEY,
      customer_name VARCHAR(150) NOT NULL,
      customer_email VARCHAR(150) NOT NULL,
      customer_phone VARCHAR(30),
      address TEXT NOT NULL,
      service_type VARCHAR(100) NOT NULL,
      preferred_date DATE,
      preferred_time VARCHAR(50),
      frequency VARCHAR(20) DEFAULT 'once' CHECK (frequency IN ('once','weekly','biweekly','monthly')),
      notes TEXT,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      job_id INTEGER REFERENCES jobs(id),
      ip_hash VARCHAR(64),
      fingerprint VARCHAR(64),
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS intake_passwords (
      id SERIAL PRIMARY KEY,
      password_hash VARCHAR(255) NOT NULL,
      plain_hint VARCHAR(20) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Schema migrations — run idempotently
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_status VARCHAR(30) DEFAULT NULL
      CHECK (invoice_status IN ('pending_review','sent','paid','void') OR invoice_status IS NULL);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_amount DECIMAL(10,2);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_email VARCHAR(150);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_sent_at TIMESTAMPTZ;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_id INTEGER REFERENCES invoices(id);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recurring_job_id INTEGER;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS travel_time INTEGER DEFAULT 15;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS needs_scheduling BOOLEAN DEFAULT FALSE;
  `);

  // Seed owner if no users exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
      ['PT Collins', 'ptcollins@collinstechflorida.com', hash, 'owner']
    );

    // Seed sample techs
    const techHash = await bcrypt.hash('tech123', 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES
       ('Marcus T.', 'marcus@savvyscheduler.app', $1, 'tech'),
       ('Dana K.', 'dana@savvyscheduler.app', $1, 'tech'),
       ('Carlos M.', 'carlos@savvyscheduler.app', $1, 'tech'),
       ('Angela R.', 'angela@savvyscheduler.app', $1, 'tech')`,
      [techHash]
    );

    // Seed sample customers
    await pool.query(`
      INSERT INTO customers (name, address) VALUES
      ('Roberts Property', '2211 1st Ave N, St. Petersburg FL'),
      ('Sunrise Realty', '430 Beach Dr NE, St. Petersburg FL'),
      ('Gulf Coast LLC', '900 4th St S, St. Petersburg FL'),
      ('Bay View Condos', '3200 Central Ave, St. Petersburg FL'),
      ('Park Ave Partners', '600 5th Ave N, St. Petersburg FL')
    `);

    // Seed sample jobs
    const today = new Date().toISOString().split('T')[0];
    await pool.query(`
      INSERT INTO jobs (title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, status, notes)
      SELECT 'HVAC Maintenance', 'HVAC', 'Roberts Property', u.id, u.name, '2211 1st Ave N', $1::timestamptz, '8:00 AM', 'completed', ''
      FROM users u WHERE u.email = 'marcus@savvyscheduler.app';

      INSERT INTO jobs (title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, status, notes)
      SELECT 'Drain Inspection', 'Plumbing', 'Sunrise Realty', u.id, u.name, '430 Beach Dr NE', $1::timestamptz, '9:30 AM', 'completed', ''
      FROM users u WHERE u.email = 'dana@savvyscheduler.app';

      INSERT INTO jobs (title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, status, notes)
      SELECT 'Pipe Repair', 'Plumbing', 'Gulf Coast LLC', u.id, u.name, '900 4th St S', $1::timestamptz, '11:00 AM', 'in_progress', 'Gate code 4418.'
      FROM users u WHERE u.email = 'carlos@savvyscheduler.app';

      INSERT INTO jobs (title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, status, notes)
      SELECT 'Water Heater Install', 'Plumbing', 'Bay View Condos', u.id, u.name, '3200 Central Ave', $1::timestamptz, '1:00 PM', 'scheduled', ''
      FROM users u WHERE u.email = 'angela@savvyscheduler.app';

      INSERT INTO jobs (title, service_type, customer_name, tech_id, tech_name, address, scheduled_date, scheduled_time, status, notes)
      SELECT 'Annual Inspection', 'Inspection', 'Park Ave Partners', u.id, u.name, '600 5th Ave N', $1::timestamptz, '2:30 PM', 'scheduled', ''
      FROM users u WHERE u.email = 'marcus@savvyscheduler.app';
    `, [today]);

    console.log('✓ Database seeded with sample data');
  }
}

module.exports = { pool, initSchema };
