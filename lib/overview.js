'use strict';

// Aggregated, cached overview: recommendations + what's trending in local AI.

const { run } = require('./exec');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const disk = require('./disk');
const security = require('./security');
const models = require('./models');
const hf = require('./hf');

const BREW = '/opt/homebrew/bin/brew';
const HOME = os.homedir();

// Best-effort probe: can we read TCC-protected folders? `true` = granted,
// `false` = protected but denied, `null` = can't tell (nothing to check).
async function fullDiskAccess() {
  let sawProtected = false;
  for (const rel of ['Library/Mail', 'Library/Messages', 'Library/Safari']) {
    try {
      await fs.readdir(path.join(HOME, rel));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        sawProtected = true;
        continue;
      }
    }
  }
  return sawProtected ? false : null;
}

function fmtBytes(bytes) {
  if (bytes == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

let cache = { key: null, data: null, ts: 0 };

function clearCache() {
  cache = { key: null, data: null, ts: 0 };
}

async function report(inventory, usage, settings) {
  const key = inventory && inventory.generatedAt ? inventory.generatedAt : 'none';
  if (cache.data && cache.key === key && Date.now() - cache.ts < 5 * 60_000) return cache.data;

  const [reclaim, securityReport, outdated, trending, fda] = await Promise.all([
    disk.reclaimReport().catch(() => ({ totalBytes: 0 })),
    security.report().catch(() => ({ issues: [] })),
    run(BREW, ['outdated', '--quiet'], { timeout: 90_000 })
      .then((result) => result.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
      .catch(() => []),
    hf.trending(8).catch(() => []),
    fullDiskAccess().catch(() => null),
  ]);

  const insights = models.insights(inventory, usage);
  const warnings = (securityReport.issues || []).filter((issue) => issue.severity === 'warn');
  const posture = securityReport.posture || [];
  const firewallOk = (posture.find((check) => check.id === 'firewall') || {}).ok !== false;
  const notificationsOn = Boolean(settings && (settings.macos || settings.telegram));

  const checks = [];
  if (fda === false) {
    checks.push({
      id: 'fda',
      label: 'Grant Full Disk Access',
      detail: 'Lets the dashboard size protected folders like ~/Library accurately.',
      fix: 'System Settings → Privacy & Security → Full Disk Access → enable your terminal.',
    });
  }
  if (!notificationsOn) {
    checks.push({ id: 'notify', label: 'Turn on notifications', detail: 'Get alerted about disk, memory and service issues.', view: 'notify' });
  }
  if (!firewallOk) {
    checks.push({ id: 'firewall', label: 'Enable the firewall', detail: 'Blocks unsolicited incoming connections.', view: 'security' });
  }

  let score = 100;
  score -= Math.min(30, warnings.length * 10);
  score -= Math.min(15, Math.round((insights.totalReclaimableBytes || 0) / 50e9) * 5);
  score -= Math.min(12, Math.round((reclaim.totalBytes || 0) / 100e9) * 6);
  score -= Math.min(9, outdated.length * 1.5);
  if (!firewallOk) score -= 6;
  if (fda === false) score -= 4;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score >= 85 ? 'good' : score >= 65 ? 'fair' : 'poor';

  const recommendations = [];
  if (insights.totalReclaimableBytes > 0) {
    recommendations.push({
      severity: 'warn',
      title: `Prune ${insights.recommended.length} unused model${insights.recommended.length === 1 ? '' : 's'}`,
      detail: `Frees ${fmtBytes(insights.totalReclaimableBytes)} · not used by your agent in 7+ days`,
      view: 'ollama',
    });
  }
  if (reclaim.totalBytes > 0) {
    recommendations.push({ severity: 'info', title: `Reclaim ${fmtBytes(reclaim.totalBytes)} of disk`, detail: 'Caches, Trash, downloads and stale outputs', view: 'storage' });
  }
  if (outdated.length) {
    recommendations.push({ severity: 'info', title: `${outdated.length} Homebrew package${outdated.length === 1 ? '' : 's'} outdated`, detail: 'Upgrade to stay current', view: 'brew' });
  }
  if (warnings.length) {
    recommendations.push({ severity: 'warn', title: `${warnings.length} security warning${warnings.length === 1 ? '' : 's'}`, detail: warnings[0].title, view: 'security' });
  }

  const data = {
    reclaimableBytes: reclaim.totalBytes || 0,
    coldModels: insights.recommended.length,
    coldBytes: insights.totalReclaimableBytes,
    outdatedCount: outdated.length,
    securityWarnings: warnings.length,
    health: { score, band, checks },
    recommendations,
    trending,
    generatedAt: Date.now(),
  };
  cache = { key, data, ts: Date.now() };
  return data;
}

module.exports = { report, clearCache };
