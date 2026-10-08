'use strict';

// Security & exposure audit: what's listening where, macOS posture, remote
// access tooling, and whether referenced secrets are present (names only).

const os = require('node:os');
const path = require('node:path');

const { run, exists, readJsonSafe, readTextSafe } = require('./exec');

const HOME = os.homedir();

const PORT_LABELS = {
  22: 'SSH (Remote Login)',
  5900: 'Screen Sharing',
  5000: 'AirPlay Receiver',
  7000: 'AirPlay Receiver',
  8788: 'OpenClaw miniapp',
  18789: 'OpenClaw gateway',
  11434: 'Ollama',
  8188: 'ComfyUI',
  8790: 'Vantage',
  445: 'SMB file sharing',
  548: 'AFP file sharing',
  631: 'CUPS printing',
  5353: 'mDNS responder',
};

const SENSITIVE_SERVICES = new Set([
  'OpenClaw miniapp',
  'OpenClaw gateway',
  'Ollama',
  'ComfyUI',
  'Vantage',
  'SSH (Remote Login)',
  'Screen Sharing',
  'SMB file sharing',
  'AFP file sharing',
]);

const firstLine = (text) => (text || '').trim().split('\n')[0].trim();

async function bindings() {
  const result = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 20_000 });
  const map = new Map();
  for (const line of result.stdout.split('\n').slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+(\S+).*?\sTCP\s+(.+):(\d+)\s+\(LISTEN\)$/);
    if (!match) continue;
    const [, command, pid, , host, portStr] = match;
    const port = Number(portStr);
    if (!map.has(port)) {
      map.set(port, { port, command, pid: Number(pid), hosts: new Set(), label: PORT_LABELS[port] || null });
    }
    map.get(port).hosts.add(host);
  }
  return [...map.values()]
    .map((entry) => {
      const hosts = [...entry.hosts];
      let exposure = 'loopback';
      if (hosts.some((h) => h === '*' || h === '0.0.0.0' || h === '::')) exposure = 'all';
      else if (hosts.some((h) => h !== '127.0.0.1' && h !== '[::1]' && h !== 'localhost')) exposure = 'lan';
      return { ...entry, hosts, exposure };
    })
    .sort((a, b) => a.port - b.port);
}

async function posture() {
  const [firevault, firewall, gatekeeper, sip, autoupdate] = await Promise.all([
    run('/usr/bin/fdesetup', ['status'], { timeout: 8000 }),
    run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { timeout: 8000 }),
    run('/usr/sbin/spctl', ['--status'], { timeout: 8000 }),
    run('/usr/bin/csrutil', ['status'], { timeout: 8000 }),
    run('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.SoftwareUpdate', 'AutomaticallyInstallMacOSUpdates'], { timeout: 8000 }),
  ]);

  const autoupdateValue = autoupdate.stdout.trim();
  return [
    { id: 'filevault', label: 'FileVault disk encryption', ok: /is On/i.test(firevault.stdout), detail: firstLine(firevault.stdout) || 'unknown' },
    { id: 'firewall', label: 'Application firewall', ok: /enabled/i.test(firewall.stdout), detail: firstLine(firewall.stdout) || 'unknown' },
    { id: 'gatekeeper', label: 'Gatekeeper', ok: /enabled/i.test(gatekeeper.stdout), detail: firstLine(gatekeeper.stdout) || 'unknown' },
    { id: 'sip', label: 'System Integrity Protection', ok: /enabled/i.test(sip.stdout), detail: firstLine(sip.stdout) || 'unknown' },
    { id: 'autoupdate', label: 'Automatic macOS updates', ok: autoupdateValue === '1', detail: autoupdateValue === '1' ? 'enabled' : autoupdateValue || 'unknown' },
  ];
}

async function remoteAccess() {
  const [tailscaleInstalled, cloudflaredInstalled, ps] = await Promise.all([
    exists('/opt/homebrew/bin/tailscale').then(async (ok) => ok || exists('/Applications/Tailscale.app')),
    exists('/opt/homebrew/bin/cloudflared'),
    run('/bin/ps', ['-axo', 'pid=,command='], { timeout: 8000 }),
  ]);

  const lines = ps.stdout.split('\n');
  const cloudflaredProcs = lines.filter((l) => /cloudflared/.test(l)).map((l) => l.trim());
  const configDirs = [];
  for (const dir of [path.join(HOME, '.cloudflared'), '/etc/cloudflared']) {
    if (await exists(dir)) configDirs.push(dir);
  }

  return {
    tailscale: { installed: tailscaleInstalled },
    cloudflared: { installed: cloudflaredInstalled, running: cloudflaredProcs.length > 0, processes: cloudflaredProcs.slice(0, 4), configDirs },
  };
}

function walkEnvRefs(node, set, depth = 0) {
  if (depth > 20 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkEnvRefs(item, set, depth + 1));
    return;
  }
  if (node.source === 'env' && typeof node.id === 'string') set.add(node.id);
  for (const value of Object.values(node)) walkEnvRefs(value, set, depth + 1);
}

async function secrets() {
  const files = [
    path.join(HOME, '.openclaw', '.env'),
    path.join(HOME, '.openclaw', 'service-env', 'ai.openclaw.gateway.env'),
  ];
  const present = new Map();
  for (const file of files) {
    const text = await readTextSafe(file);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) present.set(match[1], { source: path.basename(file), empty: match[2].length === 0 });
    }
  }
  const config = await readJsonSafe(path.join(HOME, '.openclaw', 'openclaw.json'));
  const referenced = new Set();
  walkEnvRefs(config, referenced);

  return {
    present: [...present.entries()].map(([name, meta]) => ({ name, source: meta.source, empty: meta.empty })),
    referenced: [...referenced],
    missing: [...referenced].filter((name) => !present.has(name)),
  };
}

function buildIssues(bindingList, postureList, remote, secretInfo) {
  const fixes = {
    filevault: 'System Settings → Privacy & Security → FileVault → Turn On',
    firewall: 'System Settings → Network → Firewall → Turn On',
    gatekeeper: 'Re-enable with: sudo spctl --master-enable',
    sip: 'Boot to Recovery and run: csrutil enable',
    autoupdate: 'System Settings → General → Software Update → Automatic Updates',
  };
  const issues = [];
  for (const binding of bindingList) {
    if (binding.exposure === 'loopback') continue;
    const sensitive = binding.label && SENSITIVE_SERVICES.has(binding.label);
    issues.push({
      severity: sensitive ? 'warn' : 'info',
      title: `${binding.label || binding.command} is listening on ${binding.exposure === 'all' ? 'all interfaces' : 'a LAN address'} (port ${binding.port})`,
      detail: sensitive ? 'Reachable from your local network.' : 'Standard macOS service.',
      fix: sensitive ? 'Bind it to 127.0.0.1 in its config, or restrict it with the firewall.' : null,
    });
  }
  for (const check of postureList) {
    if (!check.ok) issues.push({ severity: 'warn', title: `${check.label} is not enabled`, detail: check.detail, fix: fixes[check.id] || null });
  }
  if (secretInfo.missing.length) {
    issues.push({
      severity: 'warn',
      title: `${secretInfo.missing.length} referenced secret(s) are not set`,
      detail: secretInfo.missing.join(', '),
      fix: 'Add them to ~/.openclaw/.env and restart the gateway.',
    });
  }
  return issues;
}

async function report() {
  const [bindingList, postureList, remote, secretInfo] = await Promise.all([bindings(), posture(), remoteAccess(), secrets()]);
  return {
    bindings: bindingList,
    posture: postureList,
    remote,
    secrets: secretInfo,
    issues: buildIssues(bindingList, postureList, remote, secretInfo),
  };
}

module.exports = { report };
