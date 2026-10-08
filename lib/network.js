'use strict';

// Network metrics, topology and diagnostics.

const net = require('node:net');

const { run } = require('./exec');

const EXCLUDE = /^(lo0|gif0|stf0|awdl0|llw0|anpi\d|ap\d|vmenet)/;
const INCLUDE = /^(en|bridge|utun|ipsec)\d/;

async function counters() {
  const result = await run('/usr/sbin/netstat', ['-ibn'], { timeout: 8000 });
  let rx = 0;
  let tx = 0;
  let rxPkts = 0;
  let txPkts = 0;
  const per = {};
  for (const line of result.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 11) continue;
    const name = fields[0];
    if (!/^<Link#/.test(fields[2])) continue; // the counters row for this interface
    const ipk = Number(fields[4]) || 0;
    const ib = Number(fields[6]) || 0;
    const opk = Number(fields[7]) || 0;
    const ob = Number(fields[9]) || 0;
    per[name] = { rx: ib, tx: ob };
    if (EXCLUDE.test(name) || !INCLUDE.test(name)) continue;
    rx += ib;
    tx += ob;
    rxPkts += ipk;
    txPkts += opk;
  }
  return { rx, tx, rxPkts, txPkts, per };
}

async function interfaces() {
  const ports = await run('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 8000 });
  const entries = [];
  let current = null;
  for (const line of ports.stdout.split('\n')) {
    const port = line.match(/^Hardware Port: (.+)/);
    if (port) {
      current = { port: port[1] };
      continue;
    }
    const device = line.match(/^Device: (.+)/);
    if (device && current) {
      current.device = device[1].trim();
      entries.push(current);
      current = null;
    }
  }

  const out = [];
  for (const entry of entries) {
    const config = await run('/sbin/ifconfig', [entry.device], { timeout: 5000 });
    if (!config.ok) continue;
    const text = config.stdout;
    out.push({
      name: entry.device,
      port: entry.port,
      ipv4: (text.match(/inet (\d+\.\d+\.\d+\.\d+)/) || [])[1] || null,
      ipv6: (text.match(/inet6 ([0-9a-f:]+%?\w*)/i) || [])[1] || null,
      mac: (text.match(/ether ([0-9a-f:]+)/i) || [])[1] || null,
      status: (text.match(/status: (\w+)/) || [])[1] || null,
      media: (text.match(/media: (.+)/) || [])[1] || null,
    });
  }

  // Keep only interfaces that are up or have an address, to avoid listing
  // idle Thunderbolt/USB adapters.
  return out.filter((iface) => iface.status === 'active' || iface.ipv4 || iface.ipv6);
}

async function routing() {
  const [gateway, dns, nwi] = await Promise.all([
    run('/sbin/route', ['-n', 'get', 'default'], { timeout: 5000 }),
    run('/usr/sbin/scutil', ['--dns'], { timeout: 5000 }),
    run('/usr/sbin/scutil', ['--nwi'], { timeout: 5000 }),
  ]);
  const dnsServers = [...new Set([...dns.stdout.matchAll(/nameserver\[\d+\] : (\S+)/g)].map((m) => m[1]))];
  const searchDomains = [...new Set([...dns.stdout.matchAll(/search domain\[\d+\] : (\S+)/g)].map((m) => m[1]))];
  const reachable = /REACH\s*:.*Reachable/i.test(nwi.stdout) || /\(Reachable\)/.test(nwi.stdout);
  return {
    gateway: (gateway.stdout.match(/gateway: (\S+)/) || [])[1] || null,
    defaultInterface: (gateway.stdout.match(/interface: (\S+)/) || [])[1] || null,
    dnsServers,
    searchDomains,
    reachable,
  };
}

async function connections() {
  const result = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED'], { timeout: 20_000 });
  const rows = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+.*?\sTCP\s+(\S+)->(\S+)\s+\(ESTABLISHED\)/);
    if (!match) continue;
    rows.push({ command: match[1], pid: Number(match[2]), local: match[3], remote: match[4] });
  }
  const byProcess = new Map();
  for (const row of rows) {
    const key = `${row.command}#${row.pid}`;
    if (!byProcess.has(key)) byProcess.set(key, { command: row.command, pid: row.pid, count: 0, remotes: [] });
    const entry = byProcess.get(key);
    entry.count += 1;
    if (entry.remotes.length < 4) entry.remotes.push(row.remote);
  }
  return { total: rows.length, processes: [...byProcess.values()].sort((a, b) => b.count - a.count).slice(0, 20) };
}

async function ping(host, count = 3) {
  const safe = String(host || '').trim();
  if (!/^[A-Za-z0-9.:-]+$/.test(safe)) {
    const error = new Error('Invalid host');
    error.status = 400;
    throw error;
  }
  const attempts = Math.min(10, Math.max(1, Number(count) || 3));
  const result = await run('/sbin/ping', ['-c', String(attempts), '-t', '5', safe], { timeout: attempts * 6000 + 5000 });
  const loss = (result.stdout.match(/([\d.]+)% packet loss/) || [])[1];
  const stats = result.stdout.match(/min\/avg\/max\/stddev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);
  return {
    host: safe,
    ok: result.ok,
    lossPct: loss != null ? Number(loss) : null,
    minMs: stats ? Number(stats[1]) : null,
    avgMs: stats ? Number(stats[2]) : null,
    maxMs: stats ? Number(stats[3]) : null,
  };
}

function portCheck(host, port) {
  const safeHost = String(host || '').trim();
  const safePort = Number(port);
  if (!/^[A-Za-z0-9.:-]+$/.test(safeHost) || !Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    return Promise.reject(Object.assign(new Error('Invalid host or port'), { status: 400 }));
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: safeHost, port: safePort });
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ host: safeHost, port: safePort, ...payload });
    };
    socket.setTimeout(4000);
    socket.on('connect', () => finish({ open: true, ms: Date.now() - started }));
    socket.on('timeout', () => finish({ open: false, ms: null, error: 'timed out' }));
    socket.on('error', (error) => finish({ open: false, ms: null, error: error.code || error.message }));
  });
}

module.exports = { counters, interfaces, routing, connections, ping, portCheck };
