'use strict';

// Background system sampler + time-series store.
//
// Samples CPU, unified memory, swap, disk, Ollama's in-memory footprint and
// the top processes, and persists them to SQLite (via Node's built-in
// node:sqlite, no external dependency). The server runs this on an interval;
// the data powers the Monitor view, trends, capacity planning and alerts.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { run, fetchJson } = require('./exec');
const network = require('./network');

const DEFAULT_INTERVAL_MS = 15_000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

let db = null;
let latest = null;
let lastCpu = null;
let lastNet = null;
let timer = null;

// --- store -----------------------------------------------------------------

function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      ts INTEGER PRIMARY KEY,
      cpu REAL,
      load1 REAL,
      mem_total INTEGER,
      mem_used INTEGER,
      mem_available INTEGER,
      mem_wired INTEGER,
      mem_active INTEGER,
      mem_compressed INTEGER,
      swap_used INTEGER,
      swap_total INTEGER,
      pressure REAL,
      disk_used INTEGER,
      disk_free INTEGER,
      ollama_bytes INTEGER,
      ollama_models INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
    CREATE TABLE IF NOT EXISTS model_usage (
      name TEXT PRIMARY KEY,
      last_loaded INTEGER,
      first_seen INTEGER,
      loads INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS benchmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT,
      ts INTEGER,
      tok_per_sec REAL,
      load_ms REAL,
      prompt_tok_per_sec REAL,
      eval_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      action TEXT,
      params TEXT,
      status TEXT,
      message TEXT,
      undoable INTEGER DEFAULT 0,
      undone INTEGER DEFAULT 0,
      undo_moves TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  for (const column of ['net_rx INTEGER', 'net_tx INTEGER', 'net_rx_pkts INTEGER', 'net_tx_pkts INTEGER']) {
    try {
      db.exec(`ALTER TABLE samples ADD COLUMN ${column};`);
    } catch {
      /* column already exists */
    }
  }
  db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');");
  return db;
}

function insertSample(sample) {
  if (!db) return;
  db.prepare(`
    INSERT OR REPLACE INTO samples
      (ts, cpu, load1, mem_total, mem_used, mem_available, mem_wired, mem_active, mem_compressed,
       swap_used, swap_total, pressure, disk_used, disk_free, ollama_bytes, ollama_models,
       net_rx, net_tx, net_rx_pkts, net_tx_pkts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sample.ts,
    sample.cpu,
    sample.load1,
    sample.mem.total,
    sample.mem.used,
    sample.mem.available,
    sample.mem.wired,
    sample.mem.active,
    sample.mem.compressed,
    sample.swap.used,
    sample.swap.total,
    sample.pressure,
    sample.disk.used,
    sample.disk.free,
    sample.ollama.bytes,
    sample.ollama.models,
    sample.net ? sample.net.rx : null,
    sample.net ? sample.net.tx : null,
    sample.net ? sample.net.rxPkts : null,
    sample.net ? sample.net.txPkts : null,
  );
}

function pruneStore(retentionMs = RETENTION_MS) {
  if (!db) return 0;
  const result = db.prepare('DELETE FROM samples WHERE ts < ?').run(Date.now() - retentionMs);
  return result.changes;
}

function querySeries(sinceMs, targetPoints = 220) {
  if (!db) return [];
  const bounds = db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS c FROM samples WHERE ts >= ?').get(sinceMs);
  if (!bounds || !bounds.c) return [];
  const span = Math.max(1, bounds.mx - bounds.mn);
  const bucket = Math.max(1, Math.floor(span / targetPoints));
  const rows = db
    .prepare(
      `SELECT
         CAST(ts / ? AS INTEGER) * ? AS bucket,
         MAX(ts) AS ts,
         AVG(cpu) AS cpu,
         AVG(mem_used) AS memUsed,
         AVG(mem_available) AS memAvailable,
         AVG(mem_wired) AS memWired,
         AVG(swap_used) AS swapUsed,
         AVG(disk_used) AS diskUsed,
         AVG(disk_free) AS diskFree,
         AVG(ollama_bytes) AS ollamaBytes,
         AVG(net_rx) AS netRx,
         AVG(net_tx) AS netTx
       FROM samples WHERE ts >= ?
       GROUP BY bucket ORDER BY bucket`,
    )
    .all(bucket, bucket, sinceMs);
  return rows.map((row) => ({
    ts: row.ts,
    cpu: row.cpu,
    memUsed: row.memUsed,
    memAvailable: row.memAvailable,
    memWired: row.memWired,
    swapUsed: row.swapUsed,
    diskUsed: row.diskUsed,
    diskFree: row.diskFree,
    ollamaBytes: row.ollamaBytes,
    netRx: row.netRx,
    netTx: row.netTx,
  }));
}

function countSamples() {
  if (!db) return 0;
  return db.prepare('SELECT COUNT(*) AS c FROM samples').get().c;
}

// --- model usage + benchmarks ---------------------------------------------

let previousModelNames = new Set();

function recordModelUsage(names = []) {
  if (!db) return;
  const now = Date.now();
  for (const name of names) {
    if (previousModelNames.has(name)) continue;
    const existing = db.prepare('SELECT loads FROM model_usage WHERE name = ?').get(name);
    if (existing) db.prepare('UPDATE model_usage SET last_loaded = ?, loads = loads + 1 WHERE name = ?').run(now, name);
    else db.prepare('INSERT INTO model_usage (name, last_loaded, first_seen, loads) VALUES (?, ?, ?, 1)').run(name, now, now);
  }
  previousModelNames = new Set(names);
}

function getModelUsage() {
  if (!db) return {};
  const out = {};
  for (const row of db.prepare('SELECT name, last_loaded, first_seen, loads FROM model_usage').all()) {
    out[row.name] = { lastLoaded: row.last_loaded, firstSeen: row.first_seen, loads: row.loads };
  }
  return out;
}

function recordBenchmark(model, result) {
  if (!db) return;
  db.prepare('INSERT INTO benchmarks (model, ts, tok_per_sec, load_ms, prompt_tok_per_sec, eval_count) VALUES (?, ?, ?, ?, ?, ?)').run(
    model,
    Date.now(),
    result.tokPerSec,
    result.loadMs,
    result.promptTokPerSec,
    result.evalCount,
  );
}

function getBenchmarks() {
  if (!db) return [];
  return db
    .prepare('SELECT model, MAX(ts) AS ts, tok_per_sec, load_ms, prompt_tok_per_sec, eval_count FROM benchmarks GROUP BY model ORDER BY tok_per_sec DESC')
    .all()
    .map((row) => ({
      model: row.model,
      ts: row.ts,
      tokPerSec: row.tok_per_sec,
      loadMs: row.load_ms,
      promptTokPerSec: row.prompt_tok_per_sec,
      evalCount: row.eval_count,
    }));
}

// --- action history --------------------------------------------------------

function recordAction(entry) {
  if (!db) return null;
  const result = db
    .prepare('INSERT INTO actions (ts, action, params, status, message, undoable, undo_moves) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      Date.now(),
      entry.action,
      JSON.stringify(entry.params || {}),
      entry.status || 'done',
      entry.message || null,
      entry.undoable ? 1 : 0,
      entry.undoMoves ? JSON.stringify(entry.undoMoves) : null,
    );
  return Number(result.lastInsertRowid);
}

function updateActionStatus(id, status, message) {
  if (!db || !id) return;
  db.prepare('UPDATE actions SET status = ?, message = ? WHERE id = ?').run(status, message || null, id);
}

function queryActions(limit = 100) {
  if (!db) return [];
  return db
    .prepare('SELECT id, ts, action, params, status, message, undoable, undone FROM actions ORDER BY id DESC LIMIT ?')
    .all(Math.min(500, Math.max(1, limit)))
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      action: row.action,
      params: JSON.parse(row.params || '{}'),
      status: row.status,
      message: row.message,
      undoable: Boolean(row.undoable),
      undone: Boolean(row.undone),
    }));
}

function getAction(id) {
  if (!db) return null;
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    params: JSON.parse(row.params || '{}'),
    undoMoves: row.undo_moves ? JSON.parse(row.undo_moves) : [],
    undoable: Boolean(row.undoable),
    undone: Boolean(row.undone),
  };
}

function markUndone(id) {
  if (!db) return;
  db.prepare('UPDATE actions SET undone = 1 WHERE id = ?').run(id);
}

function pruneHistory(days = 30) {
  if (!db) return 0;
  return db.prepare('DELETE FROM actions WHERE ts < ?').run(Date.now() - days * 86400_000).changes;
}

// --- collection ------------------------------------------------------------

function cpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.idle + t.user + t.sys + t.nice + t.irq;
  }
  let percent = null;
  if (lastCpu) {
    const dIdle = idle - lastCpu.idle;
    const dTotal = total - lastCpu.total;
    if (dTotal > 0) percent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  lastCpu = { idle, total };
  return percent;
}

function num(map, key) {
  const v = map[key];
  return Number.isFinite(v) ? v : 0;
}

async function memorySample() {
  const [vm, swap, pressure] = await Promise.all([
    run('/usr/bin/vm_stat', [], { timeout: 8000 }),
    run('/usr/sbin/sysctl', ['vm.swapusage'], { timeout: 5000 }),
    run('/usr/bin/memory_pressure', ['-Q'], { timeout: 8000 }),
  ]);

  const pages = {};
  let pageSize = 16384;
  const sizeMatch = vm.stdout.match(/page size of (\d+) bytes/);
  if (sizeMatch) pageSize = Number(sizeMatch[1]);
  for (const line of vm.stdout.split('\n')) {
    const m = line.match(/^(?:"?)(Pages [\w -]+?|File-backed pages|Anonymous pages)(?:"?):\s+(\d+)\./);
    if (m) pages[m[1].toLowerCase()] = Number(m[2]);
  }

  const px = (key) => (pages[key] || 0) * pageSize;
  const free = px('pages free');
  const inactive = px('pages inactive');
  const speculative = px('pages speculative');
  const active = px('pages active');
  const wired = px('pages wired down');
  const compressed = px('pages occupied by compressor');
  const total = os.totalmem();
  const used = active + wired + compressed;
  const available = free + inactive + speculative;

  let swapUsed = 0;
  let swapTotal = 0;
  const swapMatch = swap.stdout.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
  if (swapMatch) {
    swapTotal = Math.round(Number(swapMatch[1]) * 1024 * 1024);
    swapUsed = Math.round(Number(swapMatch[2]) * 1024 * 1024);
  }

  let pressurePct = null;
  const pressureMatch = pressure.stdout.match(/([\d.]+)%/);
  if (pressureMatch) pressurePct = Number(pressureMatch[1]);

  return {
    total,
    used,
    available,
    wired,
    active,
    compressed,
    free,
    inactive,
    speculative,
    swapUsed,
    swapTotal,
    pressurePct,
  };
}

async function diskSample() {
  const result = await run('/bin/df', ['-kP', '/System/Volumes/Data'], { timeout: 8000 });
  const lines = result.stdout.trim().split('\n');
  const parts = (lines[lines.length - 1] || '').split(/\s+/);
  if (parts.length < 5) return { used: 0, free: 0, total: 0 };
  return { total: Number(parts[1]) * 1024, used: Number(parts[2]) * 1024, free: Number(parts[3]) * 1024 };
}

async function ollamaSample() {
  const ps = await fetchJson(`${OLLAMA_HOST}/api/ps`, 3000);
  if (!ps || !Array.isArray(ps.models)) return { bytes: 0, models: 0, names: [] };
  let bytes = 0;
  const names = [];
  for (const model of ps.models) {
    bytes += model.size_vram || model.size || 0;
    names.push(model.name);
  }
  return { bytes, models: ps.models.length, names };
}

async function processSample() {
  const result = await run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,command='], { timeout: 8000 });
  const procs = [];
  for (const line of result.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const rss = Number(m[3]) * 1024;
    const cpu = Number(m[4]);
    if (rss < 100 * 1024 * 1024 && cpu < 20) continue; // keep heavy or busy processes
    const command = m[5].trim();
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rss, cpu, command, name: command.split(' ')[0] });
  }
  procs.sort((a, b) => b.rss - a.rss);
  return procs.slice(0, 12);
}

async function collectSample() {
  const [mem, disk, ollama, procs, netCounters] = await Promise.all([
    memorySample(),
    diskSample(),
    ollamaSample(),
    processSample(),
    network.counters().catch(() => ({ rx: 0, tx: 0, rxPkts: 0, txPkts: 0 })),
  ]);

  const now = Date.now();
  let rxRate = null;
  let txRate = null;
  if (lastNet && now > lastNet.ts) {
    const seconds = (now - lastNet.ts) / 1000;
    if (seconds > 0) {
      rxRate = Math.max(0, (netCounters.rx - lastNet.rx) / seconds);
      txRate = Math.max(0, (netCounters.tx - lastNet.tx) / seconds);
    }
  }
  lastNet = { rx: netCounters.rx, tx: netCounters.tx, ts: now };

  const sample = {
    ts: now,
    cpu: cpuSample(),
    load1: os.loadavg()[0],
    mem: {
      total: mem.total,
      used: mem.used,
      available: mem.available,
      wired: mem.wired,
      active: mem.active,
      compressed: mem.compressed,
      free: mem.free,
      inactive: mem.inactive,
      speculative: mem.speculative,
    },
    swap: { used: mem.swapUsed, total: mem.swapTotal },
    pressure: mem.pressurePct,
    disk,
    ollama: { bytes: ollama.bytes, models: ollama.models, names: ollama.names },
    net: {
      rx: netCounters.rx,
      tx: netCounters.tx,
      rxPkts: netCounters.rxPkts,
      txPkts: netCounters.txPkts,
      rxRate,
      txRate,
    },
    procs,
    uptimeSeconds: Math.round(os.uptime()),
  };
  return sample;
}

function startSampler(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return;
  const tick = async () => {
    try {
      const sample = await collectSample();
      latest = sample;
      insertSample(sample);
      recordModelUsage(sample.ollama.names);
    } catch (error) {
      console.error('[metrics] sample failed:', error.message);
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

function stopSampler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

const getLatest = () => latest;
const sampleIntervalMs = () => DEFAULT_INTERVAL_MS;

module.exports = {
  openStore,
  startSampler,
  stopSampler,
  getLatest,
  querySeries,
  pruneStore,
  countSamples,
  getModelUsage,
  recordBenchmark,
  getBenchmarks,
  recordAction,
  updateActionStatus,
  queryActions,
  getAction,
  markUndone,
  pruneHistory,
  collectSample,
  insertSample,
  intervalMs: DEFAULT_INTERVAL_MS,
};
