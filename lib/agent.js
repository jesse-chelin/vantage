'use strict';

// Read-only OpenClaw analytics, straight from the gateway's SQLite database.
// We never write to it.

const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'state', 'openclaw.sqlite');
const DAY = 24 * 60 * 60 * 1000;

let db = null;
let opened = false;

function open() {
  if (opened) return db;
  opened = true;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    db = null;
  }
  return db;
}

function safe(fn, fallback) {
  const handle = open();
  if (!handle) return fallback;
  try {
    return fn(handle);
  } catch {
    return fallback;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stats() {
  const since = Date.now() - DAY;
  return safe((handle) => {
    const one = (sql, ...args) => handle.prepare(sql).get(...args);
    const runs = one("SELECT COUNT(*) AS c FROM audit_events WHERE kind='agent_run' AND action='agent.run.started' AND occurred_at >= ?", since).c;
    const tools = one("SELECT COUNT(*) AS c FROM audit_events WHERE kind='tool_action' AND action='tool.action.finished' AND occurred_at >= ?", since).c;
    const errors = one("SELECT COUNT(*) AS c FROM audit_events WHERE status='error' AND occurred_at >= ?", since).c;
    const avg = one('SELECT AVG(duration_ms) AS a FROM audit_events WHERE duration_ms IS NOT NULL AND occurred_at >= ?', since).a;
    const total = one('SELECT COUNT(*) AS c FROM audit_events').c;
    const sessions = one('SELECT COUNT(*) AS c FROM session_state_heads').c;
    const totalRuns = one("SELECT COUNT(*) AS c FROM audit_events WHERE kind='agent_run' AND action='agent.run.started'").c;
    return {
      runs24h: runs,
      tools24h: tools,
      errors24h: errors,
      errorRate: tools ? (errors / tools) * 100 : 0,
      avgToolMs: avg,
      totalEvents: total,
      totalRuns,
      sessions,
    };
  }, null);
}

function activity(limit = 80) {
  return safe(
    (handle) =>
      handle
        .prepare('SELECT occurred_at, agent_id, kind, action, tool_name, status, error_code, tool_call_id, session_key, run_id, duration_ms FROM audit_events ORDER BY sequence DESC LIMIT ?')
        .all(limit)
        .map((row) => ({
          at: row.occurred_at,
          agent: row.agent_id,
          kind: row.kind,
          action: row.action,
          tool: row.tool_name,
          status: row.status,
          errorCode: row.error_code,
          toolCallId: row.tool_call_id,
          session: row.session_key,
          run: row.run_id,
          durationMs: row.duration_ms,
        })),
    [],
  );
}

function topTools(limit = 10) {
  return safe(
    (handle) =>
      handle
        .prepare('SELECT tool_name, COUNT(*) AS c FROM audit_events WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC LIMIT ?')
        .all(limit)
        .map((row) => ({ tool: row.tool_name, count: row.c })),
    [],
  );
}

function automations() {
  return safe((handle) => {
    const jobs = handle.prepare('SELECT job_id, name, description, enabled, owner_agent_id, state_json FROM cron_jobs ORDER BY sort_order').all();
    const lastRun = new Map();
    for (const receipt of handle.prepare('SELECT job_id, MAX(started_at_ms) AS ts FROM cron_run_receipts GROUP BY job_id').all()) {
      lastRun.set(receipt.job_id, receipt.ts);
    }
    const lastStatus = new Map();
    for (const receipt of handle.prepare('SELECT job_id, status, error_text, started_at_ms FROM cron_run_receipts ORDER BY started_at_ms ASC').all()) {
      lastStatus.set(receipt.job_id, { status: receipt.status, error: receipt.error_text, at: receipt.started_at_ms });
    }
    return jobs.map((job) => {
      const state = parseJson(job.state_json) || {};
      const last = lastStatus.get(job.job_id) || null;
      return {
        id: job.job_id,
        name: job.name,
        description: job.description,
        enabled: Boolean(job.enabled),
        nextRunAt: state.nextRunAtMs || null,
        lastRunAt: lastRun.get(job.job_id) || state.lastRunAtMs || null,
        lastStatus: last ? last.status : null,
        lastError: last ? last.error : null,
      };
    });
  }, []);
}

function skills() {
  return safe(
    (handle) =>
      handle
        .prepare('SELECT skill_name, skill_source, use_count, last_used_at_ms, last_agent_id FROM skill_usage ORDER BY use_count DESC LIMIT 20')
        .all()
        .map((row) => ({ name: row.skill_name, source: row.skill_source, uses: row.use_count, lastUsedAt: row.last_used_at_ms, agent: row.last_agent_id })),
    [],
  );
}

function backups() {
  return safe(
    (handle) =>
      handle
        .prepare('SELECT created_at, archive_path, status FROM backup_runs ORDER BY created_at DESC LIMIT 10')
        .all()
        .map((row) => ({ createdAt: row.created_at, path: row.archive_path, status: row.status })),
    [],
  );
}

function sessions() {
  return safe(
    (handle) =>
      handle
        .prepare('SELECT session_key, agent_id, last_sequence, updated_at FROM session_state_heads ORDER BY updated_at DESC LIMIT 20')
        .all()
        .map((row) => ({ sessionKey: row.session_key, agent: row.agent_id, lastSequence: row.last_sequence, updatedAt: row.updated_at })),
    [],
  );
}

async function report() {
  const all = safe(() => true, false);
  if (!all) return { available: false };
  return {
    available: true,
    dbPath: DB_PATH,
    stats: stats(),
    activity: activity(),
    topTools: topTools(),
    automations: automations(),
    skills: skills(),
    backups: backups(),
    sessions: sessions(),
  };
}

module.exports = { report };
