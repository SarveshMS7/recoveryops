import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'recoveryops_admin',
  password: 'local_dev_only',
  database: 'recoveryops',
});

async function seed() {
  await pool.query('TRUNCATE TABLE audit_log, risk_event CASCADE;');

  // Insert some risk events
  await pool.query(`
    INSERT INTO risk_event (id, dedupe_key, merchant_id, customer_id, source_type, amount, currency, raw_reason, "group") VALUES 
    ('11111111-1111-1111-1111-111111111111', 'd1', '00000000-0000-0000-0000-000000000000', 'c1', 'payment_failure', 1000, 'INR', 'reason', 'treatment'),
    ('22222222-2222-2222-2222-222222222222', 'd2', '00000000-0000-0000-0000-000000000000', 'c2', 'payment_failure', 2000, 'INR', 'reason', 'treatment'),
    ('33333333-3333-3333-3333-333333333333', 'd3', '00000000-0000-0000-0000-000000000000', 'c3', 'payment_failure', 3000, 'INR', 'reason', 'control'),
    ('44444444-4444-4444-4444-444444444444', 'd4', '00000000-0000-0000-0000-000000000000', 'c4', 'payment_failure', 4000, 'INR', 'reason', 'treatment');
  `);

  // Insert audit logs with sequential timestamps
  await pool.query(`
    INSERT INTO audit_log (id, event_id, stage, detail, occurred_at) VALUES 
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Detected', '{}', clock_timestamp()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Scored', '{}', clock_timestamp()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Allocated', '{}', clock_timestamp()),
    (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'Succeeded', '{}', clock_timestamp()),

    (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'Detected', '{}', clock_timestamp()),
    (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'Scored', '{}', clock_timestamp()),
    (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'Allocated', '{}', clock_timestamp()),
    (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'Executing', '{}', clock_timestamp()),

    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'Detected', '{}', clock_timestamp()),
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'Scored', '{}', clock_timestamp()),
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'Parked_Control', '{}', clock_timestamp()),

    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'Detected', '{}', clock_timestamp()),
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'Scored', '{}', clock_timestamp()),
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'Skipped', '{}', clock_timestamp());
  `);

  console.log('Seeded successfully!');
  await pool.end();
}

seed().catch(console.error);
