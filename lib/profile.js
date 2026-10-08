'use strict';

// Local user + machine profile.

const os = require('node:os');
const path = require('node:path');

const { run, readJsonSafe } = require('./exec');

function extractOwnerChat(node) {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ownerAllowFrom' && Array.isArray(child)) {
        for (const item of child) {
          const match = String(item).match(/telegram:(-?\d+)/);
          if (match) found.push(match[1]);
        }
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  return found[0] || null;
}

async function report() {
  const info = os.userInfo();
  const [fullName, groups, swVers, config] = await Promise.all([
    run('/usr/bin/id', ['-F'], { timeout: 5000 }),
    run('/usr/bin/id', ['-Gn'], { timeout: 5000 }),
    run('/usr/bin/sw_vers', [], { timeout: 5000 }),
    readJsonSafe(path.join(os.homedir(), '.openclaw', 'openclaw.json')),
  ]);

  let macos = null;
  for (const line of swVers.stdout.split('\n')) {
    const [key, value] = line.split(':').map((part) => part && part.trim());
    if (key === 'ProductVersion') macos = value;
  }

  const groupList = groups.stdout.trim().split(/\s+/).filter(Boolean);
  return {
    username: info.username,
    fullName: fullName.stdout.trim() || info.username,
    uid: info.uid,
    gid: info.gid,
    home: os.homedir(),
    shell: info.shell,
    hostname: os.hostname(),
    macos,
    uptime: Math.round(os.uptime()),
    groups: groupList,
    admin: groupList.includes('admin'),
    ownerChat: extractOwnerChat(config),
  };
}

module.exports = { report };
