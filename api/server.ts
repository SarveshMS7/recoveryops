import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'recoveryops_app',
  password: process.env.PGPASSWORD || 'change_me_in_env',
  database: process.env.PGDATABASE || 'recoveryops',
});

// 1. GET /api/funnel
// Returns the funnel metrics by grouping events by their latest state in the audit_log
app.get('/api/funnel', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest_states AS (
        SELECT 
          event_id, 
          stage,
          ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY occurred_at DESC) as rn
        FROM audit_log
      )
      SELECT stage as state, COUNT(*) as count
      FROM latest_states
      WHERE rn = 1
      GROUP BY stage
      ORDER BY count DESC;
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. GET /api/incrementality
// Calculates the recovery rate (Succeeded events / Total events) grouped by treatment vs control groups
app.get('/api/incrementality', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest_states AS (
        SELECT 
          event_id, 
          stage,
          ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY occurred_at DESC) as rn
        FROM audit_log
      ),
      event_results AS (
        SELECT 
          r.id,
          r."group" as experiment_group,
          COALESCE(ls.stage, 'Detected') as final_state
        FROM risk_event r
        LEFT JOIN latest_states ls ON ls.event_id = r.id AND ls.rn = 1
      )
      SELECT 
        experiment_group,
        COUNT(*) as total_events,
        SUM(CASE WHEN final_state = 'Succeeded' THEN 1 ELSE 0 END) as recovered_events
      FROM event_results
      GROUP BY experiment_group;
    `);
    
    // Calculate percentages
    const data = result.rows.map(row => {
      const total = parseInt(row.total_events, 10);
      const recovered = parseInt(row.recovered_events, 10);
      const rate = total > 0 ? (recovered / total) * 100 : 0;
      return {
        group: row.experiment_group,
        total,
        recovered,
        recovery_rate_pct: rate.toFixed(2)
      };
    });
    
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. GET /api/events
// Lists recent events
app.get('/api/events', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest_states AS (
        SELECT 
          event_id, 
          stage,
          ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY occurred_at DESC) as rn
        FROM audit_log
      )
      SELECT 
        r.id,
        r.source_type,
        r.amount,
        r.currency,
        r.raw_reason,
        r.detected_at,
        r."group" as experiment_group,
        COALESCE(ls.stage, 'Detected') as state
      FROM risk_event r
      LEFT JOIN latest_states ls ON ls.event_id = r.id AND ls.rn = 1
      ORDER BY r.detected_at DESC
      LIMIT 100;
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. GET /api/events/:id/timeline
// Returns the full audit timeline for a specific event
app.get('/api/events/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT 
        id,
        stage,
        detail,
        occurred_at
      FROM audit_log
      WHERE event_id = $1
      ORDER BY occurred_at ASC;
    `, [id]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`API server running at http://localhost:${port}`);
});
