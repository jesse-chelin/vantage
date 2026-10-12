'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-spend-'));
process.env.VANTAGE_DATA_DIR = TMP;

const spend = require('../lib/spend');

function balanceResponse(total, currency = 'USD', status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ is_available: true, balance_infos: [{ currency, total_balance: String(total) }] }),
  };
}

test('deriveSpend totals balance drops and ignores top-ups', () => {
  const base = Date.now();
  const samples = [
    { ts: base - 3 * 86_400_000, total: 100, currency: 'USD' },
    { ts: base - 2 * 86_400_000, total: 92, currency: 'USD' }, // 8 spent
    { ts: base - 86_400_000, total: 142, currency: 'USD' }, // 50 top-up
    { ts: base, total: 130, currency: 'USD' }, // 12 spent
  ];
  const result = spend.deriveSpend(samples);
  assert.equal(result.total, 20);
  assert.equal(result.topups, 50);
  assert.equal(result.week, 20);
});

test('report starts disconnected with an empty ledger', async () => {
  const report = await spend.report();
  assert.equal(report.provider, 'deepseek');
  assert.equal(report.connected, false);
  assert.equal(report.balance, null);
  assert.equal(report.spend.source, 'ledger');
  assert.equal(report.spend.total, 0);
  assert.equal(report.ledger.entries.length, 0);
});

test('ledger entries drive spend when there is no live key', async () => {
  await spend.addEntry({ amount: 12.5, kind: 'usage', note: 'chat calls' });
  await spend.addEntry({ amount: 40, kind: 'topup', note: 'credit' });
  const report = await spend.report();
  assert.equal(report.spend.source, 'ledger');
  assert.equal(report.spend.total, 12.5);
  assert.equal(report.spend.topups, 40);
  assert.equal(report.ledger.count, 2);
  const tracked = report.ledger.entries.find((entry) => entry.note === 'chat calls');
  const after = await spend.removeEntry(tracked.id);
  assert.equal(after.ledger.count, 1);
});

test('setKey stores the key but only exposes a masked hint', async () => {
  const config = await spend.setKey('sk-abcdef1234567890');
  assert.equal(config.connected, true);
  assert.equal(config.keyHint, '••••7890');
  const report = await spend.report();
  assert.equal(report.connected, true);
  assert.equal(report.keyHint, '••••7890');
  assert.ok(!JSON.stringify(report).includes('abcdef1234567890'), 'raw key must never be returned');
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'spend.json'), 'utf8'));
  assert.equal(onDisk.apiKey, 'sk-abcdef1234567890');
});

test('refresh samples the balance and derives spend between pulls', async () => {
  globalThis.fetch = async () => balanceResponse('100.00');
  const first = await spend.refresh();
  assert.equal(first.balance, 100);
  assert.equal(first.sampleCount, 1);

  globalThis.fetch = async () => balanceResponse('88.25');
  const second = await spend.refresh();
  assert.equal(second.balance, 88.25);
  assert.equal(second.hasSamples, true);
  assert.equal(second.spend.source, 'api');
  assert.equal(second.spend.total, 11.75);
});

test('refresh surfaces an auth failure and records the last error', async () => {
  globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({}) });
  await assert.rejects(spend.refresh(), /rejected the API key/);
  const report = await spend.report();
  assert.match(report.lastError, /rejected the API key/);
  delete globalThis.fetch;
});

test('clearKey disconnects but leaves the local ledger intact', async () => {
  const config = await spend.clearKey();
  assert.equal(config.connected, false);
  const report = await spend.report();
  assert.equal(report.connected, false);
  assert.equal(report.keyHint, null);
  assert.ok(report.ledger.count >= 1);
});

test('normalizeConfig clamps values and defaults alert toggles', () => {
  const config = spend.normalizeConfig({ budget: -5, budgetWarnPct: 250, lowBalance: '12', alerts: { spike: false } });
  assert.equal(config.budget, 0);
  assert.equal(config.budgetWarnPct, 100);
  assert.equal(config.lowBalance, 12);
  assert.equal(config.alerts.spike, false);
  assert.equal(config.alerts.budget, true);
});

test('deriveBurn projects the month from the recent window', () => {
  const now = Date.now();
  const samples = [
    { ts: now - 4 * 86_400_000, total: 100 },
    { ts: now - 2 * 86_400_000, total: 70 },
    { ts: now, total: 50 },
  ];
  const burn = spend.deriveBurn(samples, { week: 50, month: 50, total: 50, source: 'api' }, 'api');
  assert.equal(burn.reliable, true);
  assert.equal(burn.basis, '4.0 days');
  assert.equal(burn.perDay, 12.5);
  assert.ok(burn.projectedMonth >= 50);
});

test('deriveBurn refuses to extrapolate from a tiny history window', () => {
  const now = Date.now();
  const samples = [
    { ts: now - 10 * 60_000, total: 74.7 },
    { ts: now - 5 * 60_000, total: 74.0 },
    { ts: now, total: 73.14 },
  ];
  const spendBuckets = spend.deriveSpend(samples);
  const burn = spend.deriveBurn(samples, spendBuckets, 'api');
  assert.equal(burn.reliable, false);
  assert.equal(burn.perDay, null);
  assert.equal(burn.projectedMonth, null);
  assert.equal(burn.basis, null);
});

test('balance samples older than the retention window are pruned', async () => {
  const old = Date.now() - (spend.RETENTION_MS + 5 * 86_400_000);
  const recent = Date.now();
  fs.writeFileSync(
    path.join(TMP, 'spend.json'),
    JSON.stringify({
      provider: 'deepseek',
      apiKey: null,
      config: {},
      sampledAt: recent,
      samples: [
        { ts: old, total: 100, currency: 'USD' },
        { ts: recent, total: 90, currency: 'USD' },
      ],
      entries: [],
    }),
  );
  const report = await spend.report();
  assert.equal(report.sampleCount, 1);
});

test('budget and low-balance alerts fire through the injected notifier', async () => {
  const sent = [];
  spend.setNotifier((key, title, body) => { sent.push({ key, title, body }); });
  try {
    const report = await spend.setConfig({ budget: 10, budgetWarnPct: 80, lowBalance: 20, alerts: { budget: true, lowBalance: true, topup: true, spike: false, error: true } });
    const state = { config: report.config, samples: [] };

    await spend.evaluateAlerts(state, { currency: 'USD', balance: 100, spend: { source: 'api', month: 9 } }, null);
    assert.equal(sent.length, 1);
    assert.match(sent[0].key, /budgetwarn:/);

    await spend.evaluateAlerts(state, { currency: 'USD', balance: 100, spend: { source: 'api', month: 12 } }, null);
    assert.equal(sent.length, 2);
    assert.match(sent[1].key, /:budget:/);

    await spend.evaluateAlerts(state, { currency: 'USD', balance: 10, spend: { source: 'api', month: 0 } }, { total: 2 });
    assert.ok(sent.some((entry) => entry.key.startsWith('spend:lowbalance:')));
    assert.ok(sent.some((entry) => entry.key.startsWith('spend:topup:')));
  } finally {
    spend.setNotifier(null);
  }
});

test('sampling is de-duplicated within the minimum gap unless forced', async () => {
  await spend.setKey('sk-dup-0000');
  globalThis.fetch = async () => balanceResponse('55.00');
  const first = await spend.refresh();
  const second = await spend.refresh();
  assert.equal(second.sampleCount, first.sampleCount);
  const forced = await spend.refresh({ force: true });
  assert.equal(forced.sampleCount, second.sampleCount + 1);
  delete globalThis.fetch;
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
