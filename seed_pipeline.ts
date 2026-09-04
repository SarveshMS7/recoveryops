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
  
  // Pick a batch of 350 events
  const batch = allEvents.slice(0, 350);
  console.log(`Ingesting first 325 events...`);
  
  // Ingest 325 events first
  for (const event of batch.slice(0, 325)) {
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
      await ingestEvent(repo, payload as any);
    } catch (e) {
      console.error(`Failed to ingest ${event.id}:`, e);
    }
  }

  console.log('Running scoring pass...');
  const scoredCount = await runScoringPass(repo);
  console.log(`Scored ${scoredCount.scored} events (control: ${scoredCount.control}, treatment: ${scoredCount.treatment}).`);

  // Ingest remaining 25 events so they stay in 'Detected' state in the funnel
  console.log('Ingesting 25 fresh events (remaining in Detected)...');
  for (const event of batch.slice(325, 350)) {
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
      await ingestEvent(repo, payload as any);
    } catch (e) {
      console.error(`Failed to ingest ${event.id}:`, e);
    }
  }

  console.log('Running allocation pass with budget 60,000 INR...');
  // A 60k budget will allocate top expected-value treatment events and skip the rest
  const allocatedCount = await runAllocationPass(repo, 60000);
  console.log(`Allocated ${allocatedCount.allocated} events (skipped: ${allocatedCount.skipped}, parked: ${allocatedCount.parked_control}, total cost: ${allocatedCount.total_cost}).`);

  console.log('Executing decisions...');
  const allocatedEventsRes = await appPool.query(`
    SELECT event_id AS id 
    FROM (
      SELECT event_id, stage, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY occurred_at DESC, id DESC) as rn 
      FROM audit_log
    ) sub 
    WHERE rn = 1 AND stage = 'Allocated'
  `);
  const allocatedRows = allocatedEventsRes.rows;
  console.log(`Found ${allocatedRows.length} allocated events.`);

  // Leave 15 events in 'Allocated' state (active pipeline queue)
  const eventsToExecute = allocatedRows.slice(15);
  console.log(`Executing decisions for ${eventsToExecute.length} events (leaving 15 in Allocated)...`);
  
  let executedCount = 0;
  for (let i = 0; i < eventsToExecute.length; i++) {
    const row = eventsToExecute[i];
    const paymentGateway = new MockPaymentGateway();
    const llmClient = new MockLlmClient();
    
    try {
      const event = await repo.findEventById(row.id);
      if (!event) continue;

      const normIndex = i / eventsToExecute.length;

      if (normIndex < 0.65) {
        // ~65% Succeeded on attempt 1
        llmClient.setResponseFor(row.id, {
          root_cause_summary: 'Temporary gateway outage',
          selected_action: 'retry_now',
          rationale: 'Immediate retry advised'
        });
        await executeDecision(repo, llmClient, paymentGateway, {
          retry_limit: { max_attempts: 3 },
          cooldown: { min_interval_seconds: 0 },
          spend_cap: { daily_limit_inr: 10000000 },
          compliance_window: { start_hour: 0, end_hour: 24 },
        }, event, 1);
      } else if (normIndex < 0.78) {
        // ~13% Failed (attempt 1 failed, stays in Failed waiting for retry 2)
        llmClient.setResponseFor(row.id, {
          root_cause_summary: 'Insufficient funds / network timeout',
          selected_action: 'retry_now',
          rationale: 'First retry attempt failed'
        });
        paymentGateway.forceFailureFor(row.id, 1);
        await executeDecision(repo, llmClient, paymentGateway, {
          retry_limit: { max_attempts: 3 },
          cooldown: { min_interval_seconds: 0 },
          spend_cap: { daily_limit_inr: 10000000 },
          compliance_window: { start_hour: 0, end_hour: 24 },
        }, event, 1);
      } else if (normIndex < 0.90) {
        // ~12% Stopped (attempts 1, 2, 3 all fail -> terminal Stopped)
        llmClient.setResponseFor(row.id, {
          root_cause_summary: 'Card blocked / repeated decline',
          selected_action: 'retry_now',
          rationale: 'Retrying up to maximum attempt limit'
        });
        paymentGateway.forceFailureFor(row.id, 3);
        // Run attempt 1
        await executeDecision(repo, llmClient, paymentGateway, {
          retry_limit: { max_attempts: 3 },
          cooldown: { min_interval_seconds: 0 },
          spend_cap: { daily_limit_inr: 10000000 },
          compliance_window: { start_hour: 0, end_hour: 24 },
        }, event, 1);
        // Run attempt 2
        await executeDecision(repo, llmClient, paymentGateway, {
          retry_limit: { max_attempts: 3 },
          cooldown: { min_interval_seconds: 0 },
          spend_cap: { daily_limit_inr: 10000000 },
          compliance_window: { start_hour: 0, end_hour: 24 },
        }, event, 2);
        // Run attempt 3 -> transitions to Stopped
        await executeDecision(repo, llmClient, paymentGateway, {
          retry_limit: { max_attempts: 3 },
          cooldown: { min_interval_seconds: 0 },
          spend_cap: { daily_limit_inr: 10000000 },
          compliance_window: { start_hour: 0, end_hour: 24 },
        }, event, 3);
      } else {
        // ~10% Escalated (policy rejection, e.g. compliance window or spend cap)
        llmClient.setResponseFor(row.id, {
          root_cause_summary: 'Potential compliance or cap violation',
          selected_action: 'retry_now',
          rationale: 'Evaluation triggered policy rejection'
        });
        // spend_cap = 0 triggers PolicyRejected -> Escalated
        await executeDecision(repo, llmClient, paymentGateway, {
          retry_limit: { max_attempts: 3 },
          cooldown: { min_interval_seconds: 0 },
          spend_cap: { daily_limit_inr: 0 },
          compliance_window: { start_hour: 0, end_hour: 24 },
        }, event, 1);
      }
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
