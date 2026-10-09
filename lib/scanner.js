'use strict';

// Read-only inventory of everything installed on this Mac: AI runtimes and
// models, agent tooling, services, ports, Homebrew, applications, packages and
// where the disk space actually went.
//
// Every section is independently error-tolerant. A scan is a pure read: it
// never mutates the machine.

const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  run,
  runJson,
  fetchJson,
  exists,
  statSafe,
  readJsonSafe,
  readTextSafe,
  listDir,
  duOne,
  duPaths,
} = require('./exec');

const HOME = os.homedir();

const PATHS = {
  ollama: path.join(HOME, '.ollama'),
  ollamaManifests: path.join(HOME, '.ollama', 'models', 'manifests'),
  openclaw: path.join(HOME, '.openclaw'),
  openclawConfig: path.join(HOME, '.openclaw', 'openclaw.json'),
  openclawWorkflows: path.join(HOME, '.openclaw', 'workflows'),
  openclawModels: path.join(HOME, '.openclaw', 'models'),
  openclawExtensions: path.join(HOME, '.openclaw', 'extensions'),
  opencodeConfig: path.join(HOME, '.config', 'opencode'),
  comfyui: path.join(HOME, 'ComfyUI'),
  lmstudio: path.join(HOME, '.lmstudio'),
  lmstudioApp: path.join(HOME, 'Library', 'Application Support', 'LM Studio'),
  hfCache: path.join(HOME, '.cache', 'huggingface'),
  torchCache: path.join(HOME, '.cache', 'torch'),
  pipCache: path.join(HOME, 'Library', 'Caches', 'pip'),
  npmCache: path.join(HOME, '.npm'),
  brewCache: path.join(HOME, 'Library', 'Caches', 'Homebrew'),
  launchAgents: path.join(HOME, 'Library', 'LaunchAgents'),
  downloads: path.join(HOME, 'Downloads'),
  trash: path.join(HOME, '.Trash'),
};

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const COMFY_HOST = 'http://127.0.0.1:8188';

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|credential|bearer|authorization|private[-_]?key)/i;

function redact(value, depth = 0) {
  if (depth > 15 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && (typeof child === 'string' || typeof child === 'number')) {
        out[key] = '[redacted]';
      } else {
        out[key] = redact(child, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function firstLine(text) {
  return (text || '').trim().split('\n')[0].trim();
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

async function scanSystem() {
  const [hardware, memBytes, ncpu, swVers] = await Promise.all([
    runJson('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], { timeout: 30_000 }),
    run('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { timeout: 5_000 }),
    run('/usr/sbin/sysctl', ['-n', 'hw.ncpu'], { timeout: 5_000 }),
    run('/usr/bin/sw_vers', [], { timeout: 5_000 }),
  ]);

  const hw = (hardware && hardware.SPHardwareDataType && hardware.SPHardwareDataType[0]) || {};

  let productVersion = null;
  let buildVersion = null;
  for (const line of swVers.stdout.split('\n')) {
    const [key, value] = line.split(':').map((part) => part && part.trim());
    if (key === 'ProductVersion') productVersion = value;
    if (key === 'BuildVersion') buildVersion = value;
  }

  const disk = await scanDisk();

  return {
    hostname: os.hostname(),
    model: hw.machine_name || null,
    modelIdentifier: hw.machine_model || null,
    chip: hw.chip_type || null,
    cpuCores: hw.number_processors
      ? Number(String(hw.number_processors).replace('proc ', '').split(':')[0])
      : ncpu.stdout.trim() ? Number(ncpu.stdout.trim()) : null,
    memoryBytes: memBytes.ok ? Number(memBytes.stdout.trim()) : null,
    physicalMemoryLabel: hw.physical_memory || null,
    serialNumber: hw.serial_number || null,
    macos: productVersion ? `macOS ${productVersion}${buildVersion ? ` (${buildVersion})` : ''}` : os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()),
    disk,
  };
}

async function scanDisk() {
  const result = await run('/bin/df', ['-kP', '/System/Volumes/Data'], { timeout: 10_000 });
  const lines = result.stdout.trim().split('\n');
  const row = lines[lines.length - 1] || '';
  const parts = row.split(/\s+/);
  if (parts.length < 5) return null;
  const totalBytes = Number(parts[1]) * 1024;
  const usedBytes = Number(parts[2]) * 1024;
  const freeBytes = Number(parts[3]) * 1024;
  return {
    mount: parts[5] || '/System/Volumes/Data',
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
  };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function scanOllama() {
  const installed = await exists(PATHS.ollama);
  const versionResult = await run('ollama', ['--version'], { timeout: 8_000 });
  const version = versionResult.ok ? firstLine(versionResult.stdout || versionResult.stderr) : null;

  const tags = await fetchJson(`${OLLAMA_HOST}/api/tags`, 5_000);
  const running = tags !== null;
  const ps = running ? await fetchJson(`${OLLAMA_HOST}/api/ps`, 5_000) : null;

  const models = [];
  if (tags && Array.isArray(tags.models)) {
    for (const model of tags.models) {
      const details = model.details || {};
      models.push({
        name: model.name,
        digest: (model.digest || '').slice(0, 12),
        sizeBytes: model.size ?? null,
        parameterSize: details.parameter_size || null,
        quantization: details.quantization_level || null,
        family: details.family || null,
        families: details.families || [],
        format: details.format || null,
        contextLength: details.context_length ?? null,
        capabilities: model.capabilities || [],
        modifiedAt: model.modified_at || null,
      });
    }
  }

  models.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

  // Ollama reports the same size for every tag that points at the same blob,
  // so summed tag sizes over-count. Deduplicate by digest for the on-disk
  // footprint, while still showing every tag.
  const digestCounts = new Map();
  for (const model of models) {
    const key = model.digest || model.name;
    digestCounts.set(key, (digestCounts.get(key) || 0) + 1);
  }
  const seenDigests = new Set();
  let totalBytes = 0;
  for (const model of models) {
    const key = model.digest || model.name;
    model.shared = digestCounts.get(key) > 1;
    if (!seenDigests.has(key)) {
      seenDigests.add(key);
      totalBytes += model.sizeBytes || 0;
    }
  }
  const uniqueModelCount = seenDigests.size;

  const loadedNames = new Set();
  const loaded = [];
  if (ps && Array.isArray(ps.models)) {
    for (const model of ps.models) {
      loadedNames.add(model.name);
      loaded.push({
        name: model.name,
        sizeBytes: model.size ?? null,
        sizeVram: model.size_vram ?? model.size ?? null,
        expiresAt: model.expires_at || null,
        contextLength: model.context_length ?? null,
      });
    }
  }

  // If the server is down, at least surface what is on disk.
  let diskModels = [];
  if (!running) {
    diskModels = await listManifests();
  }

  let dirBytes = null;
  if (installed) dirBytes = await duOne(PATHS.ollama, { timeout: 60_000 });

  return {
    installed,
    version,
    running,
    host: OLLAMA_HOST,
    dir: PATHS.ollama,
    dirBytes,
    modelCount: uniqueModelCount || diskModels.length,
    tagCount: models.length,
    uniqueModelCount,
    totalBytes: totalBytes || (diskModels.length ? null : 0),
    models,
    loaded,
    diskModels,
    services: [],
  };
}

async function listManifests() {
  const out = [];
  async function walk(dir, prefix) {
    const entries = await listDir(dir);
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else {
        out.push({ name: prefix ? `${prefix}:${entry.name}` : entry.name, manifest: full });
      }
    }
  }
  await walk(PATHS.ollamaManifests, '');
  return out;
}

// ---------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------

const DUP_SIZE_EXCLUDE = new Set(['put_checkpoints_here', 'put_loras_here']);

async function scanComfyUI() {
  const installed = await exists(PATHS.comfyui);
  if (!installed) return { installed: false };

  const versionText = await readTextSafe(path.join(PATHS.comfyui, 'comfyui_version.py'));
  const versionMatch = versionText && versionText.match(/__version__\s*=\s*"([^"]+)"/);
  const version = versionMatch ? versionMatch[1] : null;

  const modelsDir = path.join(PATHS.comfyui, 'models');
  const modelEntries = await listDir(modelsDir);
  const modelPaths = modelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(modelsDir, entry.name));
  const modelSizes = await duPaths(modelPaths, { timeout: 120_000 });

  const modelGroups = [];
  let modelsTotalBytes = 0;
  for (const entry of modelEntries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(modelsDir, entry.name);
    const bytes = modelSizes.get(full) ?? null;
    if (bytes) modelsTotalBytes += bytes;
    const files = await listFiles(full, 1);
    modelGroups.push({
      type: entry.name,
      path: full,
      bytes,
      fileCount: files.length,
      files: files.slice(0, 40),
    });
  }
  modelGroups.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));

  const checkpoints = (modelGroups.find((group) => group.type === 'checkpoints')?.files) || [];

  const customNodesDir = path.join(PATHS.comfyui, 'custom_nodes');
  const customNodes = (await listDir(customNodesDir))
    .filter((entry) => entry.isDirectory() && entry.name !== '__pycache__')
    .map((entry) => entry.name);

  const userWorkflowsDir = path.join(PATHS.comfyui, 'user', 'default', 'workflows');
  const [openclawWorkflows, nativeWorkflows] = await Promise.all([
    listNamedFiles(PATHS.openclawWorkflows),
    listNamedFiles(userWorkflowsDir),
  ]);

  const running = await isPortUp(COMFY_HOST, '/system_stats');
  const pip = await scanVenvPackages(path.join(PATHS.comfyui, '.venv', 'bin', 'python'));

  const [dirBytes, outputBytes, inputBytes] = await Promise.all([
    duOne(PATHS.comfyui, { timeout: 120_000 }),
    duOne(path.join(PATHS.comfyui, 'output'), { timeout: 60_000 }),
    duOne(path.join(PATHS.comfyui, 'input'), { timeout: 60_000 }),
  ]);

  return {
    installed,
    path: PATHS.comfyui,
    version,
    running,
    host: COMFY_HOST,
    dirBytes,
    modelsTotalBytes,
    modelGroups,
    checkpoints,
    customNodes,
    workflows: {
      openclaw: openclawWorkflows,
      native: nativeWorkflows,
    },
    outputBytes,
    inputBytes,
    python: pip,
  };
}

async function listFiles(dir, depth = 1) {
  const out = [];
  async function walk(current, level) {
    const entries = await listDir(current);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (level > 0) await walk(full, level - 1);
      } else if (!DUP_SIZE_EXCLUDE.has(entry.name) && !entry.name.endsWith('.aria2')) {
        const stat = await statSafe(full);
        if (stat) out.push({ name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    }
  }
  await walk(dir, depth);
  return out.sort((a, b) => b.bytes - a.bytes);
}

async function listNamedFiles(dir) {
  const entries = await listDir(dir);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function isPortUp(baseUrl, probePath) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    const response = await fetch(baseUrl + probePath, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function scanVenvPackages(pythonBin) {
  if (!(await exists(pythonBin))) return null;
  const [versionResult, pipResult] = await Promise.all([
    run(pythonBin, ['--version'], { timeout: 8_000 }),
    run(pythonBin, ['-m', 'pip', 'list', '--format=json'], { timeout: 30_000 }),
  ]);
  let packages = [];
  try {
    const parsed = JSON.parse(pipResult.stdout || '[]');
    if (Array.isArray(parsed)) packages = parsed.map((item) => `${item.name} ${item.version}`);
  } catch {
    packages = [];
  }
  const aiPackages = packages.filter((name) =>
    /torch|transformers|diffus|safetensors|comfy|numpy|onnx|accelerate|peft|scipy|xformers|pillow|opencv/i.test(name),
  );
  return {
    python: versionResult.ok ? versionResult.stdout.trim() : null,
    packageCount: packages.length,
    aiPackages,
  };
}

// ---------------------------------------------------------------------------
// Other ML runtimes
// ---------------------------------------------------------------------------

async function scanRuntimes() {
  const runtimes = [];

  const [whisperVersion, llamaBrew, mlxBrew, ggmlBrew] = await Promise.all([
    run('/opt/homebrew/bin/whisper-cli', ['--version'], { timeout: 8_000 }),
    brewVersion('llama.cpp'),
    brewVersion('mlx'),
    brewVersion('ggml'),
  ]);

  const whisperMatch = `${whisperVersion.stdout} ${whisperVersion.stderr}`.match(/version:\s*([\d.]+)/);
  runtimes.push({
    name: 'whisper.cpp',
    kind: 'speech-to-text',
    version: whisperMatch ? whisperMatch[1] : null,
    source: 'Homebrew',
    binary: '/opt/homebrew/bin/whisper-cli',
    models: await listModelFiles([
      path.join(PATHS.openclawModels, 'whisper'),
      '/opt/homebrew/share/whisper.cpp',
    ]),
  });

  runtimes.push({
    name: 'llama.cpp',
    kind: 'llm-inference',
    version: llamaBrew,
    source: 'Homebrew',
    binary: '/opt/homebrew/bin/llama-cli',
    models: [],
  });

  runtimes.push({
    name: 'MLX',
    kind: 'llm-framework',
    version: mlxBrew,
    source: 'Homebrew',
    binary: null,
    models: [],
  });

  runtimes.push({
    name: 'ggml',
    kind: 'tensor-library',
    version: ggmlBrew,
    source: 'Homebrew',
    binary: null,
    models: [],
  });

  return runtimes;
}

async function brewVersion(name) {
  const result = await run('/opt/homebrew/bin/brew', ['list', '--versions', name], { timeout: 20_000 });
  if (!result.ok) return null;
  const match = result.stdout.trim().match(/\s([\w.@+-]+)$/);
  return match ? match[1] : result.stdout.trim() || null;
}

async function listModelFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    const entries = await listDir(dir);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!/\.(bin|gguf|ggml|safetensors|pt|pth|onnx|mlmodel)$/.test(lower)) continue;
      const stat = await statSafe(path.join(dir, entry.name));
      if (stat) out.push({ name: entry.name, dir, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Agent stack: OpenClaw + opencode
// ---------------------------------------------------------------------------

async function scanAgentStack() {
  const [openclawVersion, opencodeVersion] = await Promise.all([
    run('openclaw', ['--version'], { timeout: 10_000 }),
    run('opencode', ['--version'], { timeout: 10_000 }),
  ]);

  const config = await readJsonSafe(PATHS.openclawConfig);
  const safeConfig = config ? redact(config) : null;

  let openclawSummary = null;
  if (safeConfig) {
    const agents = safeConfig.agents || {};
    const defaults = agents.defaults || {};
    const pluginEntries = (safeConfig.plugins && safeConfig.plugins.entries) || {};
    const skillEntries = (safeConfig.skills && safeConfig.skills.entries) || {};
    const toolEntries = (safeConfig.tools && safeConfig.tools.media && safeConfig.tools.media.models) || [];

    openclawSummary = {
      version: firstLine(openclawVersion.stdout) || null,
      configPath: PATHS.openclawConfig,
      workspace: defaults.workspace || null,
      primaryModel: defaults.model && defaults.model.primary ? defaults.model.primary : null,
      fallbackModels: (defaults.model && defaults.model.fallbacks) || [],
      aliasModels: defaults.models || {},
      utilityModel: defaults.utilityModel || null,
      subagentModel:
        (defaults.subagents && defaults.subagents.model) || null,
      imageModel: (defaults.imageModel && defaults.imageModel.primary) || null,
      mediaImage: (defaults.mediaModels && defaults.mediaModels.image) || null,
      agents: Object.entries(agents.entries || {}).map(([id, agent]) => ({
        id,
        name: (agent && agent.name) || id,
        identity: (agent && agent.identity && agent.identity.name) || null,
        heartbeat: (agent && agent.heartbeat && agent.heartbeat.every) || null,
      })),
      plugins: Object.entries(pluginEntries)
        .map(([name, value]) => ({ name, enabled: !!(value && value.enabled) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      enabledSkills: Object.entries(skillEntries)
        .filter(([, value]) => value && value.enabled)
        .map(([name]) => name)
        .sort(),
      gateway: safeConfig.gateway || null,
      toolsProfile: (safeConfig.tools && safeConfig.tools.profile) || null,
      mediaTools: toolEntries.map((item) => item.command || item.type).filter(Boolean),
    };
  }

  const workflows = await listNamedFiles(PATHS.openclawWorkflows);

  const extensionEntries = await listDir(PATHS.openclawExtensions);
  const extensions = [];
  for (const entry of extensionEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifest = await readJsonSafe(path.join(PATHS.openclawExtensions, entry.name, 'openclaw.plugin.json'));
    extensions.push({
      name: (manifest && (manifest.name || manifest.id)) || entry.name,
      version: (manifest && manifest.version) || null,
      description: (manifest && manifest.description) || null,
    });
  }

  // Only the agent's own state counts here. Models under ~/.openclaw/models are
  // already measured as ML runtimes, so including the whole dir would double-count.
  const openclawStateDir = path.join(PATHS.openclaw, 'state');
  const [openclawBytes, workflowsList] = await Promise.all([
    duOne(openclawStateDir, { timeout: 60_000 }),
    Promise.resolve(workflows),
  ]);

  return {
    openclaw: openclawSummary,
    openclawBytes,
    extensions,
    workflows: workflowsList,
    opencode: {
      version: firstLine(opencodeVersion.stdout) || null,
      configDir: (await exists(PATHS.opencodeConfig)) ? PATHS.opencodeConfig : null,
    },
    paths: {
      openclaw: PATHS.openclaw,
      workflows: PATHS.openclawWorkflows,
    },
  };
}

// ---------------------------------------------------------------------------
// Services & ports
// ---------------------------------------------------------------------------

const SERVICE_LABELS = {
  'ai.openclaw.gateway': 'OpenClaw gateway',
  'ai.openclaw.comfyui': 'ComfyUI server',
  'ai.openclaw.miniapp': 'OpenClaw miniapp',
  'ai.openclaw.miniapp-refresh': 'OpenClaw miniapp refresh',
  'sh.brew.ollama': 'Ollama server',
};

async function scanServices() {
  const result = await run('/bin/launchctl', ['list'], { timeout: 10_000 });
  const rows = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [pid, status, label] = parts;
    if (label.startsWith('com.apple.')) continue;
    rows.push({
      label,
      pid: pid === '-' ? null : Number(pid),
      status: Number(status),
      running: pid !== '-',
      friendly: SERVICE_LABELS[label] || null,
      managed: Boolean(SERVICE_LABELS[label]),
    });
  }
  rows.sort((a, b) => Number(b.managed) - Number(a.managed) || a.label.localeCompare(b.label));

  const agentEntries = await listDir(PATHS.launchAgents);
  const launchAgents = [];
  for (const entry of agentEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.plist')) continue;
    const stat = await statSafe(path.join(PATHS.launchAgents, entry.name));
    launchAgents.push({ name: entry.name, bytes: stat ? stat.size : null, modifiedAt: stat ? stat.mtime.toISOString() : null });
  }

  return { services: rows, launchAgents };
}

const PORT_LABELS = {
  11434: 'Ollama',
  8188: 'ComfyUI',
  8788: 'OpenClaw miniapp',
  18789: 'OpenClaw gateway',
  7000: 'macOS Control Center (AirPlay)',
  5000: 'macOS Control Center (AirPlay)',
};

async function scanPorts() {
  const result = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 20_000 });
  const byPort = new Map();
  for (const line of result.stdout.split('\n').slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+(\S+).*?\sTCP\s+(.+):(\d+)\s+\(LISTEN\)$/);
    if (!match) continue;
    const [, command, pid, user, bindHost, portStr] = match;
    const port = Number(portStr);
    if (!byPort.has(port)) {
      byPort.set(port, { port, command, pid: Number(pid), user, hosts: new Set(), label: PORT_LABELS[port] || null });
    }
    byPort.get(port).hosts.add(bindHost);
  }
  return [...byPort.values()]
    .map((item) => ({ ...item, hosts: [...item.hosts].sort() }))
    .sort((a, b) => a.port - b.port);
}

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

async function scanBrew() {
  const prefix = await run('/opt/homebrew/bin/brew', ['--prefix'], { timeout: 10_000 });
  const brewPrefix = prefix.ok ? prefix.stdout.trim() : '/opt/homebrew';

  const [formulae, casks, services] = await Promise.all([
    run('/opt/homebrew/bin/brew', ['list', '--versions'], { timeout: 60_000 }),
    run('/opt/homebrew/bin/brew', ['list', '--cask'], { timeout: 30_000 }),
    run('/opt/homebrew/bin/brew', ['services', 'list'], { timeout: 30_000 }),
  ]);

  const packages = formulae.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(' ');
      return index === -1
        ? { name: line, version: null }
        : { name: line.slice(0, index), version: line.slice(index + 1).trim() };
    });

  const caskList = casks.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  const brewServices = services.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { name: parts[0], status: parts[1] || null, user: parts[2] || null, file: parts[3] || null };
    });

  const [cellarBytes, cacheBytes] = await Promise.all([
    duOne(path.join(brewPrefix, 'Cellar'), { timeout: 60_000 }),
    duOne(PATHS.brewCache, { timeout: 60_000 }),
  ]);

  return {
    prefix: brewPrefix,
    formulaCount: packages.length,
    packages,
    casks: caskList,
    services: brewServices,
    cellarBytes,
    cacheBytes,
  };
}

// ---------------------------------------------------------------------------
// Language package managers
// ---------------------------------------------------------------------------

async function scanPackages() {
  const npmResult = await runJson('npm', ['ls', '-g', '--depth=0', '--json'], { timeout: 30_000 });
  const npmGlobal = [];
  if (npmResult && npmResult.dependencies) {
    for (const [name, info] of Object.entries(npmResult.dependencies)) {
      npmGlobal.push({ name, version: (info && info.version) || null });
    }
  }

  const [py314, py312] = await Promise.all([
    pipList('/opt/homebrew/bin/python3.14'),
    pipList('/opt/homebrew/bin/python3.12'),
  ]);

  const npmCacheBytes = await duOne(PATHS.npmCache, { timeout: 60_000 });
  const pipCacheBytes = await duOne(PATHS.pipCache, { timeout: 60_000 });

  return {
    npm: { global: npmGlobal, cacheBytes: npmCacheBytes },
    python: { '3.14': py314, '3.12': py312 },
    caches: { npm: npmCacheBytes, pip: pipCacheBytes },
  };
}

async function pipList(pythonBin) {
  if (!(await exists(pythonBin))) return null;
  const result = await run(pythonBin, ['-m', 'pip', 'list', '--format=json'], { timeout: 40_000 });
  let packages = [];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    if (Array.isArray(parsed)) packages = parsed.map((item) => ({ name: item.name, version: item.version }));
  } catch {
    packages = [];
  }
  return {
    version: null,
    count: packages.length,
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

async function scanApps() {
  const roots = ['/Applications', path.join(HOME, 'Applications')];
  const apps = [];
  for (const root of roots) {
    const entries = await listDir(root);
    for (const entry of entries) {
      if (!entry.name.endsWith('.app')) continue;
      apps.push({ name: entry.name.replace(/\.app$/, ''), path: path.join(root, entry.name), root });
    }
  }
  const sizes = await duPaths(apps.map((app) => app.path), { timeout: 120_000 });
  for (const app of apps) app.bytes = sizes.get(app.path) ?? null;
  apps.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  return { count: apps.length, apps };
}

// ---------------------------------------------------------------------------
// Storage: where the space went
// ---------------------------------------------------------------------------

async function scanStorage({ deep = true } = {}) {
  // A "shallow" scan skips reading inside the user's protected home folders
  // (Desktop, Documents, Downloads…). macOS would otherwise show a stack of
  // folder-access prompts the moment Vantage first runs, long before onboarding
  // has explained them. The full pass runs once setup is complete.
  const [homeChildren, caches, downloads, backups, trashBytes] = await Promise.all([
    deep ? homeTopLevel() : Promise.resolve([]),
    cacheBreakdown(),
    deep ? downloadsBreakdown() : Promise.resolve([]),
    deep ? backupBreakdown() : Promise.resolve({ home: [], openclaw: [] }),
    deep ? duOne(PATHS.trash, { timeout: 60_000 }) : Promise.resolve(null),
  ]);

  const hfBytes = (await exists(PATHS.hfCache)) ? await duOne(PATHS.hfCache, { timeout: 60_000 }) : null;
  const lmstudioBytes = (await exists(PATHS.lmstudio)) ? await duOne(PATHS.lmstudio, { timeout: 60_000 }) : null;

  return { homeTop: homeChildren, caches, downloads, backups, trashBytes, hfBytes, lmstudioBytes };
}

// macOS treats ~/Library as other apps' data and answers with the confusing
// "node would like to access data from other apps" prompt, which disk totals
// don't need. The user-facing folders (Desktop, Documents, Downloads, Movies,
// Music, Pictures) are measured normally: macOS asks once for each, which the
// onboarding finish step explains.
const AUTO_SKIP = new Set(['Library']);

async function homeTopLevel() {
  const entries = await listDir(HOME);
  const measurable = entries.filter((entry) => !entry.name.startsWith('.') && !AUTO_SKIP.has(entry.name));
  const paths = measurable.map((entry) => path.join(HOME, entry.name));
  const sizes = await duPaths(paths, { timeout: 180_000 });
  return measurable
    .map((entry) => {
      const full = path.join(HOME, entry.name);
      return { name: entry.name, path: full, bytes: sizes.get(full) ?? null, isDirectory: entry.isDirectory() };
    })
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

async function cacheBreakdown() {
  const targets = [
    PATHS.npmCache,
    PATHS.pipCache,
    PATHS.brewCache,
    path.join(HOME, '.cache'),
    path.join(HOME, 'Library', 'Caches'),
    PATHS.hfCache,
    PATHS.torchCache,
  ];
  const sizes = await duPaths(targets.filter(Boolean), { timeout: 120_000 });
  const out = [];
  for (const target of targets) {
    if (!target) continue;
    const bytes = sizes.get(target);
    if (bytes == null) continue;
    out.push({ name: target.replace(HOME, '~'), path: target, bytes });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

async function downloadsBreakdown() {
  const entries = await listDir(PATHS.downloads);
  const files = [];
  for (const entry of entries) {
    const full = path.join(PATHS.downloads, entry.name);
    const stat = await statSafe(full);
    if (stat) files.push({ name: entry.name, path: full, bytes: stat.size, isDirectory: entry.isDirectory() });
  }
  return files.sort((a, b) => b.bytes - a.bytes);
}

async function backupBreakdown() {
  const [homeBackups, openclawBackups] = await Promise.all([
    listBackupFiles(HOME),
    listBackupFiles(path.join(PATHS.openclaw, 'backups')),
  ]);
  return { home: homeBackups, openclaw: openclawBackups };
}

async function listBackupFiles(dir) {
  const entries = await listDir(dir);
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(tar\.gz|tgz|zip|tar|backup|bak)$/i.test(entry.name)) continue;
    const stat = await statSafe(path.join(dir, entry.name));
    if (stat) out.push({ name: entry.name, path: path.join(dir, entry.name), bytes: stat.size });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(result) {
  const ollama = result.ollama || {};
  const comfy = result.comfyui || {};
  const runtimes = result.runtimes || [];
  const agent = result.agentStack || {};
  const brew = result.homebrew || {};
  const storage = result.storage || {};
  const packages = result.packages || {};

  const speechBytes = runtimes
    .filter((runtime) => runtime.name === 'whisper.cpp')
    .flatMap((runtime) => runtime.models || [])
    .reduce((sum, model) => sum + (model.bytes || 0), 0);

  const cachesBytes = (storage.caches || []).reduce((sum, item) => sum + (item.bytes || 0), 0);

  const aiFootprintBytes =
    (ollama.totalBytes || 0) +
    (comfy.modelsTotalBytes || 0) +
    speechBytes +
    (agent.openclawBytes || 0);

  const categories = [
    { key: 'ollama', name: 'Ollama LLM models', bytes: ollama.totalBytes || 0, color: '#6366f1', count: ollama.modelCount },
    { key: 'image', name: 'ComfyUI image models', bytes: comfy.modelsTotalBytes || 0, color: '#ec4899', count: comfy.checkpoints?.length },
    { key: 'speech', name: 'Speech models', bytes: speechBytes, color: '#14b8a6', count: runtimes.find((r) => r.name === 'whisper.cpp')?.models?.length },
    agent.openclaw ? { key: 'agent', name: 'OpenClaw state', bytes: agent.openclawBytes || 0, color: '#f59e0b', count: null } : null,
  ].filter(Boolean).filter((category) => category.bytes > 0);

  return {
    aiFootprintBytes,
    speechBytes,
    cachesBytes,
    categories,
    counts: {
      ollamaModels: ollama.modelCount ?? ollama.models?.length ?? ollama.diskModels?.length ?? 0,
      ollamaLoaded: ollama.loaded?.length || 0,
      comfyCheckpoints: comfy.checkpoints?.length || 0,
      comfyGroups: comfy.modelGroups?.filter((group) => group.bytes > 0).length || 0,
      brewPackages: brew.formulaCount || 0,
      apps: result.apps?.count || 0,
      services: (result.services?.services || []).filter((service) => service.running).length,
      npmGlobal: packages.npm?.global?.length || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function scanAll(onProgress = () => {}, options = {}) {
  const deep = options.deep !== false;
  const result = { generatedAt: new Date().toISOString(), host: os.hostname() };

  const step = async (key, label, fn) => {
    onProgress(label);
    try {
      result[key] = await fn();
    } catch (error) {
      result[key] = { error: error && error.message ? error.message : String(error) };
    }
  };

  await step('system', 'Reading system info', scanSystem);
  await step('services', 'Checking launchd services', scanServices);
  await step('ports', 'Scanning listening ports', scanPorts);
  await step('ollama', 'Inventorying Ollama models', scanOllama);
  await step('comfyui', 'Inventorying ComfyUI', scanComfyUI);
  await step('runtimes', 'Checking ML runtimes', scanRuntimes);
  await step('agentStack', 'Reading OpenClaw & opencode config', scanAgentStack);
  await step('homebrew', 'Listing Homebrew packages', scanBrew);
  await step('packages', 'Listing language packages', scanPackages);
  await step('apps', 'Measuring applications', scanApps);
  await step('storage', deep ? 'Measuring storage & caches' : 'Checking caches', () => scanStorage({ deep }));

  result.summary = buildSummary(result);
  return result;
}

module.exports = { scanAll, PATHS };
