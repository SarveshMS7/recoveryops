import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { PgEventRepository } from './adapters/postgres/pg_event_repository.js';
import { ingestEvent } from './application/ingest_event.js';
import { runScoringPass, DEFAULT_COEFFICIENTS } from './application/run_scoring_pass.js';
import { runAllocationPass } from './application/run_allocation_pass.js';
import { executeDecision } from './application/execute_decision.js';
import { MockPaymentGateway } from './adapters/mock/mock_payment_gateway.js';
import { MockLlmClient } from './adapters/mock/mock_llm_client.js';
import { RecoveryEvent } from './ports/types.js';

const { Pool } = pg;

async function seed() {
  const adminPool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'recoveryops_admin',
    password: 'local_dev_only',
    database: 'recoveryops',
  });

  const appPool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'recoveryops_app',
    password: 'change_me_in_env',
    database: 'recoveryops',
  });

  console.log('Truncating tables...');
  await adminPool.query('TRUNCATE TABLE audit_log CASCADE');
  await adminPool.query('TRUNCATE TABLE risk_event CASCADE');
  await adminPool.end();

  const repo = new PgEventRepository(appPool);
  
  console.log('Reading synthetic events...');
  const json = readFileSync(resolve('ml', 'synthetic_events.json'), 'utf-8');
  const allEvents = JSON.parse(json);
  
  // Pick a batch of 300 events
  const batch = allEvents.slice(0, 300);
  console.log(`Ingesting ${batch.length} events...`);
  
  for (const event of batch) {
    const payload: RecoveryEvent = {
      id: event.id,
      source: 'synthetic',
      external_ref: event.id,
      merchant_id: event.merchant_id,
      customer_id: event.customer_id,
      source_type: event.source_type,
      amount: event.amount,
      currency: 'INR',
      raw_reason: event.raw_reason,
      detected_at: new Date(event.detected_at),
      features: event.features,
      experiment_group: 'unassigned',
      state: 'Detected'
    };
    try {
      const result = await ingestEvent(repo, payload as any);
      if (!result) console.log(`Ingest returned null for ${event.id}, payload:`, payload);
    } catch (e) {
      console.error(`Failed to ingest ${event.id}:`, e);
    }
  }

  console.log('Running scoring pass...');
  const scoredCount = await runScoringPass(repo);
  console.log(`Scored ${scoredCount.scored} events (control: ${scoredCount.control}, treatment: ${scoredCount.treatment}).`);

  console.log('Running allocation pass...');
  const allocatedCount = await runAllocationPass(repo, 500000);
  console.log(`Allocated ${allocatedCount.allocated} events (skipped: ${allocatedCount.skipped}, parked: ${allocatedCount.parked_control}, total cost: ${allocatedCount.total_cost}).`);

  console.log('Executing decisions...');
  const allocatedEvents = await appPool.query(`
    SELECT event_id AS id 
    FROM (
      SELECT event_id, stage, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY occurred_at DESC, id DESC) as rn 
      FROM audit_log
    ) sub 
    WHERE rn = 1 AND stage = 'Allocated'
  `);
  console.log(`Found ${allocatedEvents.rows.length} allocated events to execute.`);
  
  let executedCount = 0;
  for (const row of allocatedEvents.rows) {
    const paymentGateway = new MockPaymentGateway();
    const llmClient = new MockLlmClient();
    
    // Distribute mock results to get a realistic funnel
    const rand = Math.random();
    if (rand < 0.6) {
      llmClient.setResponseFor(row.id, {
        root_cause_summary: 'Temporary gateway glitch',
        selected_action: 'retry_now',
        rationale: 'Immediate retry recommended for transient errors'
      });
      // Success by default in mock
    } else if (rand < 0.8) {
      llmClient.setResponseFor(row.id, {
        root_cause_summary: 'Insufficient funds / network issue',
        selected_action: 'retry_now',
        rationale: 'Retry attempted'
      });
      paymentGateway.forceFailureFor(row.id, 1); // Failed
    } else {
      llmClient.setResponseFor(row.id, {
        root_cause_summary: 'High risk or recurrent failure',
        selected_action: 'escalate',
        rationale: 'Action escalated to manual review'
      });
    }
    
    try {
      const event = await repo.findEventById(row.id);
      if (!event) continue;
      
      await executeDecision(repo, llmClient, paymentGateway, {
        retry_limit: { max_attempts: 3 },
        cooldown: { min_interval_seconds: 0 },
        spend_cap: { daily_limit_inr: 10000000 },
        compliance_window: { start_hour: 0, end_hour: 24 },
      }, event, 1);
      executedCount++;
    } catch (e) {
      console.error(`Failed to execute ${row.id}:`, e);
    }
  }
  console.log(`Executed ${executedCount} events.`);
  
  await appPool.end();
  console.log('Seed complete.');
}

seed().catch(console.error);
