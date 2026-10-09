'use strict';

/* Vantage, Linear-inspired renderer with management controls. */

// --- element handles -------------------------------------------------------

const els = {
  nav: document.getElementById('nav'),
  view: document.getElementById('view'),
  viewTitle: document.getElementById('view-title'),
  viewSub: document.getElementById('view-sub'),
  machineCard: document.getElementById('machine-card'),
  machineLine: document.getElementById('machine-line'),
  scanStatus: document.getElementById('scan-status'),
  refresh: document.getElementById('refresh'),
  filter: document.getElementById('filter'),
  modeBadge: document.getElementById('mode-badge'),
  updateChip: document.getElementById('update-chip'),
  footVersion: document.getElementById('foot-version'),
  modalRoot: document.getElementById('modal-root'),
  toastRoot: document.getElementById('toast-root'),
  jobDock: document.getElementById('job-dock'),
  paletteRoot: document.getElementById('palette-root'),
  searchTrigger: document.getElementById('search-trigger'),
  menuBtn: document.getElementById('menu-btn'),
  navScrim: document.getElementById('nav-scrim'),
  progress: document.getElementById('progress'),
  panelRoot: document.getElementById('panel-root'),
  workspaceBtn: document.getElementById('workspace-btn'),
  settingsRoot: document.getElementById('settings-root'),
  onboardingRoot: document.getElementById('onboarding-root'),
};

const state = {
  data: null,
  renderedAt: null,
  session: { token: null, readOnly: true },
  actions: {},
  view: location.hash.replace(/^#/, '') || 'overview',
  filter: '',
  jobs: new Map(),
  update: { checked: false, supported: true, available: false },
  boot: null,
};

// --- motion + progress -----------------------------------------------------

const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
const inflight = { count: 0 };
let progressForced = false;

function updateProgress() {
  if (els.progress) els.progress.classList.toggle('active', inflight.count > 0 || progressForced);
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (...args) => {
  inflight.count += 1;
  updateProgress();
  return nativeFetch(...args).finally(() => {
    inflight.count = Math.max(0, inflight.count - 1);
    updateProgress();
  });
};

function skeletonRows(count = 4) {
  return `<div class="skeleton-rows">${Array.from({ length: count }, () => '<div class="skeleton-row"><span class="skeleton s-ico"></span><span class="skeleton s-line s-1"></span><span class="skeleton s-line s-2"></span></div>').join('')}</div>`;
}

function contentScroller() {
  return document.querySelector('.content-scroll');
}

// Smooth page transitions: use the View Transitions API (crossfade scoped to the
// content area, composited) when available; otherwise a short opacity/rise fade.
function navigate(update) {
  const scroller = contentScroller();
  if (scroller) scroller.scrollTop = 0;
  if (prefersReducedMotion || typeof document.startViewTransition !== 'function') {
    update();
    if (scroller && !prefersReducedMotion) {
      scroller.classList.remove('view-enter');
      void scroller.offsetWidth;
      scroller.classList.add('view-enter');
      setTimeout(() => scroller.classList.remove('view-enter'), 280);
    }
    return;
  }
  document.startViewTransition(update);
}

// --- preferences -----------------------------------------------------------

const PREFS_KEY = 'vantage.prefs';
const ACCENTS = {
  indigo: ['#5e6ad2', '#8b93e8'],
  blue: ['#0a84ff', '#5ac8fa'],
  cyan: ['#0aa0c0', '#38c6e0'],
  teal: ['#12967f', '#33b89e'],
  green: ['#1f9d55', '#4dc07e'],
  lime: ['#7ba600', '#a6cf3b'],
  yellow: ['#d19a00', '#eec24a'],
  orange: ['#e0762a', '#f59f57'],
  red: ['#e03a3f', '#f16a6e'],
  pink: ['#d84a86', '#ef74aa'],
  purple: ['#8b5cf6', '#a98bfa'],
  graphite: ['#7d838f', '#a6acb7'],
};
const DEFAULT_PREFS = { accent: 'system', density: 'comfortable', motion: 'auto', material: 'glass', sidebar: 'expanded', pins: [], notifyBrowser: false, wakeLock: true, touchId: false, idlePause: true };
let systemAccent = null;

// The "System" swatch must always show the detected macOS accent, never the
// currently-selected one (otherwise picking e.g. graphite repaints it grey).
function systemAccentColor() {
  return (ACCENTS[systemAccent] || ACCENTS.indigo)[0];
}

function loadPrefs() {
  try {
    const raw = window && window.localStorage ? window.localStorage.getItem(PREFS_KEY) : null;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
let prefs = loadPrefs();
function savePrefs() {
  try {
    if (window && window.localStorage) window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}
function hexToRgba(hex, alpha) {
  const raw = String(hex).replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function applyPrefs() {
  const name = prefs.accent === 'system' ? systemAccent || 'indigo' : prefs.accent;
  const pair = ACCENTS[name] || ACCENTS.indigo;
  const root = document.documentElement;
  if (root && root.style) {
    root.style.setProperty('--accent', pair[0]);
    root.style.setProperty('--accent-2', pair[1]);
    root.style.setProperty('--accent-soft', hexToRgba(pair[0], 0.16));
  }
  if (document.body && document.body.classList) {
    document.body.classList.toggle('compact', prefs.density === 'compact');
    document.body.classList.toggle('reduce-motion', prefs.motion === 'reduce');
    document.body.classList.toggle('glass', prefs.material !== 'solid');
    document.body.classList.toggle('sidebar-collapsed', prefs.sidebar === 'collapsed');
  }
}
function setPref(key, value) {
  prefs = { ...prefs, [key]: value };
  savePrefs();
  applyPrefs();
}
function togglePin(id) {
  const pins = Array.isArray(prefs.pins) ? prefs.pins : [];
  setPref('pins', pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]);
  renderNav();
}
function toggleSidebar() {
  setPref('sidebar', prefs.sidebar === 'collapsed' ? 'expanded' : 'collapsed');
}
function initials(name) {
  return String(name || '?').split(/\s+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

// --- helpers ---------------------------------------------------------------

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(bytes, digits = 1) {
  if (bytes == null || Number.isNaN(bytes)) return '–';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

const fmtNum = (value) => (value == null ? '–' : Number(value).toLocaleString());

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function relativeTime(value) {
  if (!value) return '–';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '–';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const baseName = (p) => String(p || '').split('/').filter(Boolean).pop() || p;

function baseOfName(name) {
  return String(name).split('/').pop().split(':')[0];
}

function agentUsedBases(data) {
  const oc = data?.agentStack?.openclaw || {};
  const names = [oc.primaryModel, oc.utilityModel, oc.subagentModel, oc.imageModel, ...(oc.fallbackModels || [])].filter(Boolean);
  return new Set([...names, ...Object.keys(oc.aliasModels || {})].map(baseOfName));
}

function expiresText(value) {
  if (!value) return 'no expiry';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'no expiry';
  const diff = then - Date.now();
  if (diff <= 0) return 'keep-alive expired';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'expires in under a minute';
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `expires in ${hours} h`;
}

const bar = (pct, color) => `<div class="bar"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%;${color ? `background:${color}` : ''}"></span></div>`;

const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const statusPill = (running) => (running ? pill('running', 'good') : pill('stopped', 'warn'));

function table(headers, rows, empty = 'Nothing here yet') {
  const head = headers.map((h) => `<th class="${h.num ? 'num' : ''}">${esc(h.label)}</th>`).join('');
  const emptyRow = `<tr><td colspan="${headers.length}" class="faint">${esc(empty)}</td></tr>`;
  let body;
  if (Array.isArray(rows)) body = rows.length ? rows.join('') : emptyRow;
  else body = rows && String(rows).trim() ? rows : emptyRow;
  return `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function group(title, hint, inner) {
  return `<div class="group">${title ? `<div class="group-title">${esc(title)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</div>` : ''}${inner}</div>`;
}

function card(inner, pad) {
  return `<div class="card${pad ? ' pad' : ''}">${inner}</div>`;
}

function row({ title, sub, size, actions, search, attrs, clickable, icon, badge }) {
  const haystack = (search || `${title || ''} ${sub || ''}`).toLowerCase();
  return `<div class="row${clickable ? ' clickable' : ''}" data-search="${esc(haystack)}"${attrs ? ` ${attrs}` : ''}>
    ${icon ? `<span class="row-ico">${icon}</span>` : ''}
    <div class="row-main"><div class="row-title">${title}</div>${sub ? `<div class="row-sub">${sub}</div>` : ''}</div>
    ${badge ? `<div class="row-badge">${badge}</div>` : ''}
    ${size != null ? `<div class="row-size">${size}</div>` : ''}
    ${actions ? `<div class="row-actions">${actions}</div>` : clickable ? '<span class="row-chevron">›</span>' : ''}
  </div>`;
}

function statTile(s) {
  const value = String(s.value);
  const tone = s.tone ? ` tone-${s.tone}` : '';
  const sparkValues = Array.isArray(s.spark) ? s.spark.filter((v) => Number.isFinite(v)) : [];
  const viz = sparkValues.length > 1
    ? `<span class="stat-spark">${areaChart(s.spark, { height: 34, width: 260, color: s.sparkColor || 'var(--accent)' })}</span>`
    : (s.viz ? `<span class="stat-viz">${s.viz}</span>` : '');
  return `<div class="card stat">
    <div class="stat-head">
      <span class="stat-ico">${svg(s.icon)}</span>
      <span class="stat-label">${esc(s.label)}</span>
      ${s.badge ? `<span class="stat-badge">${s.badge}</span>` : ''}
    </div>
    <span class="value${value.length > 8 ? ' small' : ''}${tone}">${esc(s.value)}</span>
    ${s.hint ? `<span class="hint">${esc(s.hint)}</span>` : ''}
    ${viz}
  </div>`;
}

// A slim usage meter. pct is 0..100.
function statMeter(pct, color) {
  const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
  return `<span class="stat-meter"><span style="width:${clamped.toFixed(1)}%;background:${color}"></span></span>`;
}

// A segmented bar, e.g. running vs stopped.
function statSegments(segments) {
  const total = segments.reduce((sum, s) => sum + (s.value || 0), 0) || 1;
  return `<span class="stat-seg">${segments
    .filter((s) => (s.value || 0) > 0)
    .map((s) => `<span style="width:${((s.value / total) * 100).toFixed(2)}%;background:${s.color}" title="${esc(s.label)}: ${esc(fmtNum(s.value))}"></span>`)
    .join('')}</span>`;
}

// A tiny bar chart for a handful of values (largest first).
function statBars(values) {
  const list = (values || []).filter((v) => v > 0);
  if (!list.length) return '';
  const max = Math.max(...list) || 1;
  return `<span class="sparkbars">${list
    .map((v) => `<span style="height:${Math.max(12, Math.round((v / max) * 100))}%" title="${esc(fmtBytes(v))}"></span>`)
    .join('')}</span>`;
}

function actBtn(id, params, label, variant = '', opts = {}) {
  const json = esc(JSON.stringify(params || {}));
  const disabled = state.session.readOnly ? ' disabled' : '';
  const cls = variant === 'danger' ? 'ghost-danger' : variant;
  const impact = opts.impact ? ` data-impact="${esc(opts.impact)}"` : '';
  return `<button class="btn small ${cls}" data-act="${esc(id)}" data-params='${json}'${impact}${disabled}>${esc(label)}</button>`;
}

// --- icons -----------------------------------------------------------------

const ICONS = {
  overview: '<path d="M2 12.5a6 6 0 0 1 12 0"/><path d="M8 12.5l3.2-3.6"/>',
  disk: '<rect x="1.5" y="3.5" width="13" height="9" rx="2.2"/><circle cx="4.6" cy="8" r="1"/>',
  brain: '<rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/>',
  photo: '<rect x="1.5" y="2.5" width="13" height="11" rx="2.2"/><circle cx="5.4" cy="6.4" r="1.2"/><path d="M2.2 11.4l3.4-3.3 2.9 2.8 1.9-1.9 3.4 3.3"/>',
  cube: '<path d="M8 1.6l5.8 3.1v6.6L8 14.4 2.2 11.3V4.7z"/><path d="M2.4 5L8 8l5.6-3M8 8v6.3"/>',
  bot: '<rect x="3" y="5" width="10" height="8" rx="2.6"/><circle cx="6.2" cy="9" r=".9" fill="currentColor" stroke="none"/><circle cx="9.8" cy="9" r=".9" fill="currentColor" stroke="none"/><path d="M8 5V2.6"/>',
  gears: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"/>',
  mug: '<path d="M2.2 5.2h8v4.6a3 3 0 0 1-3 3H5.2a3 3 0 0 1-3-3z"/><path d="M10.2 6.4h1.9a1.8 1.8 0 0 1 0 3.6h-1.9"/>',
  grid: '<rect x="2" y="2" width="5" height="5" rx="1.5"/><rect x="9" y="2" width="5" height="5" rx="1.5"/><rect x="2" y="9" width="5" height="5" rx="1.5"/><rect x="9" y="9" width="5" height="5" rx="1.5"/>',
  box: '<path d="M8 1.6l5.8 3.1v6.6L8 14.4 2.2 11.3V4.7z"/><path d="M2.4 5L8 8l5.6-3"/>',
  warning: '<path d="M8 2l6.4 11.4H1.6z"/><path d="M8 6.4v3.3M8 12h.01"/>',
  check: '<path d="M3 8.4l3.3 3.3L13 5.2"/>',
  download: '<path d="M8 1.6v8.2M4.6 6.4L8 9.9l3.4-3.5"/><path d="M2.6 13.6h10.8"/>',
  trash: '<path d="M2.6 4.2h10.8M5.6 4.2V2.6h4.8v1.6M3.7 4.2l.9 9.5h6.8l.9-9.5"/>',
  play: '<path d="M4.2 2.6l8.6 5.4-8.6 5.4z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.7"/>',
  restart: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13.2 2.6V5.2h-2.6"/>',
  eye: '<path d="M1.6 8s2.5-4 6.4-4 6.4 4 6.4 4-2.5 4-6.4 4S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.6"/>',
  bolt: '<path d="M8.6 1.6L3.2 9h4L6.8 14.4 12.8 7h-4z"/>',
  xmark: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  chevron: '<path d="M5 6.2l3 3 3-3"/>',
  back: '<path d="M9.6 4.6l-3.2 3.4 3.2 3.4"/>',
  star: '<path d="M8 2.4l1.7 3.5 3.8.6-2.8 2.7.7 3.8L8 11.1l-3.4 1.9.7-3.8-2.8-2.7 3.8-.6z"/>',
  search: '<path d="M6.7 1.8a4.9 4.9 0 1 0 3 8.7l3 3a.8.8 0 1 0 1.1-1.1l-3-3a4.9 4.9 0 0 0-4.1-7.6Zm0 1.5a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z" fill="currentColor" stroke="none"/>',
  gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"/>',
  pulse: '<path d="M1.5 8h3l1.8-4.6 3.1 9.2 1.8-4.6h3.3"/>',
  shield: '<path d="M8 1.6l5 2v4.3c0 3.3-2.2 5.6-5 6.6-2.8-1-5-3.3-5-6.6V3.6z"/>',
  bell: '<path d="M4 6.6a4 4 0 0 1 8 0c0 2.4.8 3.4 1.5 4.4h-11c.7-1 1.5-2 1.5-4.4z"/><path d="M6.5 13a1.5 1.5 0 0 0 3 0"/>',
  history: '<path d="M8 2.2a5.8 5.8 0 1 1-5.6 4.4"/><path d="M2 2.4v3h3"/><path d="M8 4.6V8l2.2 1.4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.6A1.6 1.6 0 0 0 8.9 2H3.6A1.6 1.6 0 0 0 2 3.6v5.3a1.6 1.6 0 0 0 1.6 1.6h1.9"/>',
  shop: '<path d="M3.4 5.4h9.2l-.8 8.4H4.2z"/><path d="M5.7 5.4V4.1a2.3 2.3 0 0 1 4.6 0v1.3"/>',
  user: '<circle cx="8" cy="5.6" r="2.6"/><path d="M2.8 13.6a5.2 5.2 0 0 1 10.4 0"/>',
  network: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 2 2.7 4 2.7 6S9.8 12 8 14c-1.8-2-2.7-4-2.7-6S6.2 4 8 2z"/>',
  cpu: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.3"/><path d="M6.6 1.6v3M9.4 1.6v3M6.6 11.4v3M9.4 11.4v3M1.6 6.6h3M1.6 9.4h3M11.4 6.6h3M11.4 9.4h3"/>',
  memory: '<rect x="1.6" y="4.8" width="12.8" height="6.4" rx="1.5"/><path d="M4.2 11.2v1.9M8 11.2v1.9M11.8 11.2v1.9M4.6 7.2v2.4M7 7.2v2.4M9.4 7.2v2.4M11.4 7.2v2.4"/>',
  swap: '<path d="M4.6 2.6v8.2M4.6 2.6L2.6 4.6M4.6 2.6l2 2M11.4 13.4V5.2M11.4 13.4l2-2M11.4 13.4l-2-2"/>',
  thermo: '<path d="M8 2.2a1.6 1.6 0 0 1 1.6 1.6v4.4a3 3 0 1 1-3.2 0V3.8A1.6 1.6 0 0 1 8 2.2z"/><path d="M8 6.6v4.1"/>',
  gpu: '<rect x="1.6" y="3.6" width="12.8" height="8.8" rx="1.6"/><circle cx="6" cy="8" r="2.1"/><path d="M11 6h1.5M11 10h1.5"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  terminal: '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2"/><path d="M4.4 6.4l2.2 2.2-2.2 2.2M8.2 10.9h3.2"/>',
  app: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M1.8 6h12.4"/><circle cx="4.2" cy="4.4" r=".5" fill="currentColor" stroke="none"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c1.9 2 2.9 4 2.9 6S9.9 12 8 14C6.1 12 5.1 10 5.1 8S6.1 4 8 2z"/>',
  layers: '<path d="M8 2.1l5.7 3L8 8.1 2.3 5.1z"/><path d="M2.3 8.1L8 11.1l5.7-3M2.3 11L8 14l5.7-3"/>',
  database: '<ellipse cx="8" cy="4.1" rx="5" ry="2"/><path d="M3 4.1v7.8c0 1.1 2.2 2 5 2s5-.9 5-2V4.1M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  key: '<circle cx="5.2" cy="10.8" r="2.5"/><path d="M7 9l6-6M11 3.2l1.9 1.9M9.4 4.8l1.9 1.9"/>',
  upload: '<path d="M8 14.4V6.2M4.6 9.6L8 6.1l3.4 3.5"/><path d="M2.6 2.4h10.8"/>',
  link: '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.8.2l1.9-1.9a2.7 2.7 0 0 0-3.8-3.8l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.8-.2L3.7 8.3a2.7 2.7 0 0 0 3.8 3.8l.9-.9"/>',
  folder: '<path d="M1.8 4.3a1.6 1.6 0 0 1 1.6-1.6h3.1l1.4 1.7h5.7a1.6 1.6 0 0 1 1.6 1.6v5.7a1.6 1.6 0 0 1-1.6 1.6H3.4a1.6 1.6 0 0 1-1.6-1.6z"/>',
  file: '<path d="M4 1.8h4.6L12.5 5.6v8.6H4z"/><path d="M8.4 1.8v3.9h4.1"/>',
  sparkle: '<path d="M7 2.2l1.4 3.4L11.8 7 8.4 8.4 7 11.8 5.6 8.4 2.2 7l3.4-1.4z"/><path d="M12.4 10.2l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/>',
  sidebar: '<rect x="1.8" y="3" width="12.4" height="10" rx="2"/><path d="M6.4 3v10"/>',
  monitor: '<rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.6"/><path d="M6 14h4M8 11.2V14"/>',
  film: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M4.9 2.6v10.8M11.1 2.6v10.8M1.8 8h12.4"/>',
  music: '<path d="M6.2 11.8V3.4l6-1.3v8.3"/><circle cx="4.4" cy="11.8" r="1.9"/><circle cx="10.4" cy="10.4" r="1.9"/>',
  camera: '<rect x="1.6" y="4.4" width="12.8" height="8.4" rx="2"/><path d="M5.7 4.4l.9-1.8h2.8l.9 1.8"/><circle cx="8" cy="8.6" r="2.4"/>',
};

// A few icons are authored on a 24x24 grid (e.g. the fingerprint); everything
// else uses the 16x16 set. Keeping the 24 box avoids re-scaling their geometry.
const ICON_24 = {
  fingerprint: '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
};

// Icon ids the server rendered as real SF Symbols. Null until loaded, so the
// first paint uses the built-in line icons and swaps once the catalog arrives.
let sfIcons = null;
let sfVersion = '';
let sfMasks = null;

function symbolSvg(name, extra = '') {
  const src = (sfMasks && sfMasks[name]) || `/api/symbol/icon?id=${encodeURIComponent(name)}&size=64${sfVersion ? `&v=${encodeURIComponent(sfVersion)}` : ''}`;
  const mask = `-webkit-mask:url('${src}') center / contain no-repeat;mask:url('${src}') center / contain no-repeat;`;
  return `<svg class="sf-symbol" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${extra} style="${mask}"></svg>`;
}

const svg = (name, extra = '') => {
  if (sfIcons && sfIcons.has(name)) return symbolSvg(name, extra);
  return ICON_24[name]
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICON_24[name]}</svg>`
    : `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name] || ''}</svg>`;
};

// Machine illustrations for the hero + sidebar (drawn locally so the dashboard
// stays offline and CSP-clean; keyed off the detected Mac model).
const DEVICE_COLORS = { body: '#c9ced6', bodyDark: '#aab0ba', line: '#969dab', screen: '#22252a', screenGlow: '#31363d' };

function deviceKey(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return 'mac';
  if (m.includes('macbook')) return 'laptop';
  if (m.includes('imac')) return 'imac';
  if (m.includes('mac pro')) return 'pro';
  if (m.includes('mini')) return 'mini';
  if (m.includes('studio')) return 'studio';
  return 'mac';
}

function deviceArt(model) {
  const c = DEVICE_COLORS;
  const vents = (y) => Array.from({ length: 6 }, (_, i) => `<circle cx="${17 + i * 6}" cy="${y}" r="1" fill="${c.line}" opacity=".5"/>`).join('');
  const art = {
    mac: `<rect x="12" y="6" width="40" height="26" rx="3.5" fill="${c.screen}" stroke="${c.line}"/>
      <rect x="14.5" y="8.5" width="35" height="21" rx="1.8" fill="${c.screenGlow}"/>
      <rect x="27" y="33" width="10" height="3" rx="1" fill="${c.bodyDark}"/>
      <rect x="21" y="36" width="22" height="2.6" rx="1.3" fill="${c.bodyDark}"/>`,
    studio: `<rect x="7" y="9" width="50" height="26" rx="8" fill="${c.body}" stroke="${c.line}"/>
      <rect x="7" y="27" width="50" height="8" rx="8" fill="${c.bodyDark}"/>
      <rect x="14" y="17" width="26" height="2.6" rx="1.3" fill="${c.line}" opacity=".4"/>
      <rect x="14" y="22" width="26" height="2.6" rx="1.3" fill="${c.line}" opacity=".4"/>
      <circle cx="50" cy="22" r="1.8" fill="var(--accent)"/>`,
    mini: `<rect x="12" y="15" width="40" height="16" rx="4.5" fill="${c.body}" stroke="${c.line}"/>
      <rect x="12" y="26" width="40" height="5" rx="4.5" fill="${c.bodyDark}"/>
      <rect x="18" y="20" width="16" height="2" rx="1" fill="${c.line}" opacity=".4"/>
      <circle cx="46" cy="23" r="1.6" fill="var(--accent)"/>`,
    laptop: `<rect x="14" y="7" width="36" height="23" rx="3" fill="${c.screen}" stroke="${c.line}"/>
      <rect x="16.5" y="9.5" width="31" height="18" rx="1.6" fill="${c.screenGlow}"/>
      <path d="M7 31h50l3 5.5H4z" fill="${c.body}" stroke="${c.line}"/>
      <rect x="28" y="32.4" width="8" height="1.6" rx=".8" fill="${c.line}"/>`,
    imac: `<rect x="12" y="5" width="40" height="25" rx="3" fill="${c.screen}" stroke="${c.line}"/>
      <rect x="14.5" y="7.5" width="35" height="20" rx="1.6" fill="${c.screenGlow}"/>
      <rect x="12" y="28.5" width="40" height="5.5" rx="2" fill="${c.body}" stroke="${c.line}"/>
      <path d="M29 34h6l2 6h-10z" fill="${c.bodyDark}"/>
      <rect x="24" y="39.4" width="16" height="2.2" rx="1.1" fill="${c.bodyDark}"/>`,
    pro: `<rect x="10" y="6" width="44" height="32" rx="3" fill="${c.bodyDark}" stroke="${c.line}"/>
      <rect x="6.5" y="13" width="3" height="18" rx="1.5" fill="${c.line}"/>
      <rect x="54.5" y="13" width="3" height="18" rx="1.5" fill="${c.line}"/>
      ${vents(14)}${vents(30)}`,
  }[deviceKey(model)] || '';
  return `<svg class="device-art" viewBox="0 0 64 44" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(model || 'Mac')}">${art}</svg>`;
}

function deviceBadge(model) {
  return `<div class="device-badge"><img class="device-img" loading="lazy" decoding="async" alt="" data-device="${esc(model || '')}" src="/api/device/image?model=${encodeURIComponent(model || '')}&v=2" /></div>`;
}

// --- views -----------------------------------------------------------------

const VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'overview', title: 'Overview' },
  { id: 'setup', label: 'Get set up', icon: 'bolt', title: 'Get set up', count: (d) => missingComponents(d).length || null },
  { id: 'monitor', label: 'Monitor', icon: 'pulse', title: 'Monitor' },
  { id: 'storage', label: 'Disk', icon: 'disk', title: 'Disk' },
  { id: 'network', label: 'Network', icon: 'network', title: 'Network' },
  { id: 'services', label: 'Services', icon: 'gears', title: 'Services & Ports', count: (d) => d.summary?.counts?.services },
  { id: 'security', label: 'Security', icon: 'shield', title: 'Security' },
  { id: 'notify', label: 'Alerts', icon: 'bell', title: 'Alerts' },
  { id: 'brew', label: 'Homebrew', icon: 'mug', title: 'Homebrew', count: (d) => d.summary?.counts?.brewPackages },
  { id: 'apps', label: 'Applications', icon: 'grid', title: 'Applications', count: (d) => d.summary?.counts?.apps },
  { id: 'packages', label: 'Packages', icon: 'box', title: 'Language Packages' },
  { id: 'store', label: 'Store', icon: 'shop', title: 'Homebrew Store' },
  { id: 'maintenance', label: 'Maintenance', icon: 'gear', title: 'Maintenance' },
  { id: 'ollama', label: 'Models', icon: 'brain', title: 'Ollama Models', count: (d) => d.summary?.counts?.ollamaModels },
  { id: 'comfy', label: 'Image Gen', icon: 'photo', title: 'ComfyUI', count: (d) => d.summary?.counts?.comfyCheckpoints, available: (d) => Boolean(d.comfyui && d.comfyui.installed) },
  { id: 'runtimes', label: 'Runtimes', icon: 'cube', title: 'ML Runtimes' },
  { id: 'agent', label: 'Agent Stack', icon: 'bot', title: 'Agent Stack', available: (d) => Boolean(d.agentStack && !d.agentStack.error && d.agentStack.openclaw) },
  { id: 'activity', label: 'Activity', icon: 'history', title: 'Agent Activity', available: (d) => Boolean(d.agentStack && !d.agentStack.error && d.agentStack.openclaw) },
  { id: 'ainews', label: 'AI News', icon: 'sparkle', title: 'AI News' },
  { id: 'history', label: 'History', icon: 'history', title: 'Action History' },
  { id: 'settings', label: 'Settings', icon: 'gears', title: 'Settings' },
];

const NAV_SECTIONS = [
  { label: 'General', ids: ['overview', 'setup', 'monitor', 'storage', 'network', 'services', 'security', 'notify'] },
  { label: 'Manage', ids: ['brew', 'apps', 'packages', 'store', 'maintenance'] },
  { label: 'AI', ids: ['ollama', 'comfy', 'runtimes', 'agent', 'activity', 'ainews'] },
  { label: 'System', ids: ['history'] },
];

// --- optional components & empty states ------------------------------------

const COMPONENTS = [
  {
    id: 'homebrew',
    label: 'Homebrew',
    icon: 'mug',
    category: 'Foundation',
    blurb: 'The package manager everything else installs through.',
    command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    docs: 'https://brew.sh',
    view: 'brew',
    present: (d) => Boolean(d.homebrew && !d.homebrew.error),
  },
  {
    id: 'ollama',
    label: 'Ollama',
    icon: 'brain',
    category: 'AI',
    blurb: 'Run local LLMs like Llama, Qwen and Mistral with one command.',
    command: 'brew install ollama',
    docs: 'https://ollama.com/download',
    view: 'ollama',
    present: (d) => Boolean(d.ollama && d.ollama.installed),
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    icon: 'photo',
    category: 'AI',
    blurb: 'Node-based image generation, Stable Diffusion and friends.',
    docs: 'https://github.com/comfyanonymous/ComfyUI',
    view: 'comfy',
    present: (d) => Boolean(d.comfyui && d.comfyui.installed),
  },
  {
    id: 'runtimes',
    label: 'ML runtimes',
    icon: 'cube',
    category: 'AI',
    blurb: 'llama.cpp, MLX and whisper.cpp for local inference.',
    command: 'brew install llama.cpp mlx whisper.cpp',
    docs: 'https://github.com/ggml-org/llama.cpp',
    view: 'runtimes',
    present: (d) => Array.isArray(d.runtimes) && d.runtimes.length > 0,
  },
  {
    id: 'agentstack',
    label: 'OpenClaw agent',
    icon: 'bot',
    category: 'AI',
    blurb: 'A local agent runtime and message router.',
    docs: 'https://openclaw.ai',
    view: 'agent',
    present: (d) => Boolean(d.agentStack && !d.agentStack.error && d.agentStack.openclaw),
  },
];

function missingComponents(data) {
  const d = data || state.data || {};
  return COMPONENTS.filter((c) => {
    try {
      return !c.present(d);
    } catch {
      return true;
    }
  });
}

function emptyState({ icon = 'bolt', title, body = '', command = null, docs = null, action = '', steps = [] }) {
  const stepsHtml = steps.length ? `<ol class="empty-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : '';
  const cmd = command
    ? `<div class="cmd-block empty-cmd"><div class="cmd-head"><span>Terminal</span><button class="btn small icon" data-copy="${esc(command)}" title="Copy command">${svg('copy')}</button></div><code>${esc(command)}</code></div>`
    : '';
  const learn = docs ? `<a class="btn small" href="${esc(docs)}" target="_blank" rel="noopener">Learn more ↗</a>` : '';
  return `<div class="empty-state">
    <div class="empty-art">${svg(icon)}</div>
    <h2>${esc(title)}</h2>
    <p>${body}</p>
    ${stepsHtml}
    ${cmd}
    <div class="empty-actions">${action}${learn}</div>
  </div>`;
}



function viewSetup(data) {
  const d = data || state.data || {};
  const missing = missingComponents(d);
  const installed = COMPONENTS.length - missing.length;
  const pct = Math.round((installed / COMPONENTS.length) * 100);
  const hero = `<div class="card hero">
    <div class="hero-main">
      <div class="hero-title">${installed} of ${COMPONENTS.length} components ready</div>
      <div class="hero-sub">${missing.length ? 'This dashboard works on any Mac, add the pieces you want, each unlocks a page.' : 'Everything is installed. Nice.'}</div>
      <div style="margin-top:12px;max-width:420px">${bar(pct, pct === 100 ? 'var(--green)' : 'var(--accent)')}</div>
    </div>
    <div class="hero-pills"><button class="btn small" data-scan>${svg('restart')} Rescan</button></div>
  </div>`;

  const componentRow = (c) => {
    const ok = !missing.includes(c);
    return row({
      icon: `<span class="row-ico-svg">${svg(c.icon)}</span>`,
      title: esc(c.label),
      sub: esc(c.blurb),
      badge: ok ? pill('ready', 'good') : pill('not installed'),
      actions: `${ok ? '' : `<button class="btn small icon" data-copy="${esc(c.command || c.docs || '')}" title="Copy install command">${svg('copy')}</button>`}<button class="btn small" data-goto="${esc(c.view)}">Open</button>`,
      search: `${c.label} ${c.category}`,
    });
  };
  const categories = [...new Set(COMPONENTS.map((c) => c.category))];
  const groups = categories
    .map((cat) => group(cat, null, card(`<div class="rows">${COMPONENTS.filter((c) => c.category === cat).map(componentRow).join('')}</div>`)))
    .join('');
  return hero + groups;
}



// --- dev preview overlay ----------------------------------------------------

const DEV_SIM_KEYS = ['homebrew', 'ollama', 'comfyui', 'runtimes', 'agent', 'packages'];
let devOpen = false;
let devSim = {};

function devActive() {
  return DEV_SIM_KEYS.some((k) => devSim[k]);
}

function simulateData(data) {
  if (!data || !devActive()) return data;
  const d = { ...data, summary: { ...(data.summary || {}), counts: { ...(data.summary?.counts || {}) } } };
  if (devSim.homebrew) {
    d.homebrew = { error: 'Preview: Homebrew not installed' };
    d.summary.counts.brewPackages = 0;
  }
  if (devSim.ollama) {
    d.ollama = { installed: false };
    d.summary.counts.ollamaModels = 0;
    d.summary.aiFootprintBytes = 0;
    d.summary.categories = [];
  }
  if (devSim.comfyui) {
    d.comfyui = { installed: false };
    d.summary.counts.comfyCheckpoints = 0;
  }
  if (devSim.runtimes) d.runtimes = [];
  if (devSim.agent) d.agentStack = { error: 'Preview: OpenClaw not installed' };
  if (devSim.packages) {
    d.packages = {};
    d.summary.counts.npmGlobal = 0;
  }
  return d;
}

function renderDevPanel() {
  const host = document.getElementById('dev-root');
  if (!host) return;
  if (document.body) document.body.classList.toggle('previewing', devActive());
  if (!devOpen) {
    host.innerHTML = devActive() ? `<button class="dev-badge" data-dev-open>${svg('bolt')} Preview mode</button>` : '';
    return;
  }
  const rows = [
    ['fresh', 'Fresh install, hide all optional components'],
    ['homebrew', 'Homebrew not installed'],
    ['ollama', 'Ollama not installed'],
    ['comfyui', 'ComfyUI not installed'],
    ['runtimes', 'No ML runtimes'],
    ['agent', 'OpenClaw not installed'],
    ['packages', 'No Python / Node packages'],
  ];
  host.innerHTML = `<div class="dev-panel">
    <div class="dev-head"><span>${svg('gear')} Preview states</span><button class="dev-icon" data-dev-close aria-label="Close">${svg('xmark')}</button></div>
    <p class="dev-note">Preview how pages look with components missing. Nothing changes on the server.</p>
    <div class="dev-rows">${rows.map(([k, l]) => `<label class="dev-row"><input type="checkbox" data-dev-key="${esc(k)}" ${(k === 'fresh' ? devSim.fresh : devSim[k]) ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
    <button class="btn small" data-dev-reset>Reset</button>
  </div>`;
}

function toggleDevPanel() {
  devOpen = !devOpen;
  renderDevPanel();
}

function applyDevSim() {
  renderDevPanel();
  renderNav();
  renderView();
}

// --- view renderers --------------------------------------------------------

const CATEGORY_COLORS = { ollama: '#0a84ff', image: '#ff2d55', speech: '#30b0c7', agent: '#ff9500' };
const CATEGORY_SHORT = { ollama: 'Ollama', image: 'Images', speech: 'Speech', agent: 'Agent' };

function viewOverview(data) {
  const system = data.system || {};
  const summary = data.summary || {};
  const ollama = data.ollama || {};
  const comfy = data.comfyui || {};
  const disk = system.disk || {};
  const svcContext = data.services?.services || [];
  const stoppedServices = svcContext.filter((s) => !s.running).length;

  const categories = (summary.categories || []).filter((c) => c.bytes > 0);
  const total = categories.reduce((sum, c) => sum + c.bytes, 0) || 1;
  const topModels = (ollama.models || ollama.diskModels || [])
    .map((m) => m.sizeBytes || m.bytes || 0)
    .sort((a, b) => b - a)
    .slice(0, 7);
  const runningServices = svcContext.filter((s) => s.running).length;
  const casks = (data.homebrew && data.homebrew.casks) || [];

  const stats = [
    ollama.installed ? {
      icon: 'layers', label: 'AI footprint', value: fmtBytes(summary.aiFootprintBytes),
      hint: categories.length ? categories.map((c) => `${CATEGORY_SHORT[c.key] || c.name} ${fmtBytes(c.bytes)}`).join(' · ') : 'nothing measured yet',
      viz: categories.length ? `<span class="stacked stat-stacked">${categories.map((c) => `<span style="width:${(c.bytes / total) * 100}%;background:${CATEGORY_COLORS[c.key] || 'var(--accent)'}" title="${esc(c.name)}"></span>`).join('')}</span>` : '',
    } : null,
    ollama.installed ? {
      icon: 'brain', label: 'Ollama models', value: fmtNum(summary.counts?.ollamaModels),
      hint: `${fmtBytes(ollama.totalBytes)} on disk${summary.counts?.ollamaLoaded ? ` · ${fmtNum(summary.counts.ollamaLoaded)} loaded` : ''}`,
      viz: statBars(topModels),
    } : null,
    comfy.installed ? { icon: 'photo', label: 'Image checkpoints', value: fmtNum(summary.counts?.comfyCheckpoints), hint: `${fmtBytes(comfy.modelsTotalBytes)} of models`, viz: statBars((comfy.checkpoints || []).map((c) => c.bytes || 0)) } : null,
    {
      icon: 'disk', label: 'Free disk space', value: fmtBytes(disk.freeBytes),
      hint: `${fmtBytes(disk.usedBytes)} used · ${disk.usedPercent}% of ${fmtBytes(disk.totalBytes)}`,
      viz: statMeter(disk.usedPercent, disk.usedPercent > 90 ? 'var(--red)' : disk.usedPercent > 75 ? 'var(--orange)' : 'var(--green)'),
    },
    {
      icon: 'gears', label: 'Services running', value: fmtNum(summary.counts?.services),
      hint: `${stoppedServices} stopped · ${svcContext.length} total`,
      viz: statSegments([{ value: runningServices, color: 'var(--green)', label: 'Running' }, { value: stoppedServices, color: 'var(--orange)', label: 'Stopped' }]),
    },
    (data.homebrew && !data.homebrew.error) ? {
      icon: 'mug', label: 'Homebrew formulae', value: fmtNum(summary.counts?.brewPackages),
      hint: casks.length ? `${fmtNum(casks.length)} casks` : 'formulae installed',
      viz: statSegments([{ value: summary.counts?.brewPackages || 0, color: 'var(--accent)', label: 'Formulae' }, { value: casks.length, color: 'var(--text-3)', label: 'Casks' }]),
    } : null,
  ]
    .filter(Boolean)
    .map(statTile)
    .join('');

  const stacked = categories.map((c) => `<span style="width:${(c.bytes / total) * 100}%;background:${CATEGORY_COLORS[c.key]}"></span>`).join('');
  const legend = categories
    .map((c) => `<span class="item"><span class="dot" style="background:${CATEGORY_COLORS[c.key]}"></span>${esc(c.name)} · ${fmtBytes(c.bytes)}${c.count != null ? ` (${c.count})` : ''}</span>`)
    .join('');

  const diskGroup = disk.totalBytes
    ? group('Disk', disk.mount, card(`<div class="pad">
        ${bar(disk.usedPercent, disk.usedPercent > 90 ? 'var(--red)' : disk.usedPercent > 75 ? 'var(--orange)' : 'var(--green)')}
        <div class="legend"><span class="item">Used ${fmtBytes(disk.usedBytes)} (${disk.usedPercent}%)</span><span class="item">Free ${fmtBytes(disk.freeBytes)}</span><span class="item">Total ${fmtBytes(disk.totalBytes)}</span></div>
        <div class="disk-trend" id="disk-trend"><span class="faint" style="font-size:11px">Loading 7-day trend…</span></div>
      </div>`))
    : '';

  const footprint = categories.length
    ? group('AI footprint', null, card(`<div class="pad"><div class="stacked">${stacked}</div><div class="legend">${legend}</div></div>`))
    : '';

  const quickActions = state.session.readOnly
    ? ''
    : group('Quick actions', null, card(`<div class="rows">
        ${row({ title: 'Clean up disk', sub: 'Empty Trash, prune caches and stale files', actions: `<button class="btn small" data-cleanup>${svg('trash')} Clean up…</button>` })}
        ${row({ title: 'Pull an Ollama model', sub: 'Download a model from the Ollama registry', actions: `<button class="btn small" data-form="ollama.pull">${svg('download')} Pull…</button>` })}
        ${ollama.loaded?.length ? row({ title: 'Unload all models', sub: `Free memory held by ${ollama.loaded.length} loaded model${ollama.loaded.length === 1 ? '' : 's'}`, actions: `<button class="btn small" data-act="ollama.unloadAll" data-params='{}'>${svg('stop')} Unload</button>` }) : ''}
        ${row({ title: 'Rescan this Mac', sub: 'Refresh the full inventory', actions: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>` })}
      </div>`));

  const hero = `<div class="card hero">
    <div class="hero-art">${deviceBadge(system.model)}</div>
    <div class="hero-main">
      <div class="hero-title">${esc(system.model || 'Mac')}${system.chip ? ` · ${esc(system.chip)}` : ''}</div>
      <div class="hero-sub">${esc(system.physicalMemoryLabel || '')}${system.macos ? ` · ${esc(system.macos)}` : ''} · up ${esc(fmtUptime(system.uptimeSeconds))}</div>
    </div>
    <div class="hero-pills">
      ${pill(`${svcContext.filter((s) => s.running).length}/${svcContext.length} services`, '')}
      ${stoppedServices ? pill(`${stoppedServices} stopped`, 'warn') : ''}
      ${pill(`${fmtBytes(disk.freeBytes)} free`, '')}
    </div>
  </div>`;

  const missing = missingComponents(data);
  const setupPrompt = missing.length
    ? group(
        'Get set up',
        `${missing.length} to add`,
        card(`<div class="rows">${missing
          .slice(0, 4)
          .map((c) =>
            row({
              icon: `<span class="row-ico-svg">${svg(c.icon)}</span>`,
              title: esc(c.label),
              sub: esc(c.blurb),
              actions: `<button class="btn small" data-goto="setup">Set up</button>`,
              search: c.label,
            }),
          )
          .join('')}</div>`),
      )
    : '';

  return `${hero}<div id="overview-extras">${skeletonRows(2)}</div><div class="grid stats">${stats}</div>${setupPrompt}${diskGroup}${footprint}${quickActions}`;
}

const CACHE_TARGET_BY_NAME = (name) => {
  if (name.includes('.npm')) return 'npm';
  if (name.includes('Caches/pip')) return 'pip';
  if (name.includes('Caches/Homebrew')) return 'brew';
  return null;
};

function viewStorage(data) {
  const storage = data.storage || {};
  const diskRoot = `<div id="disk-root">${skeletonRows(4)}</div>`;
  if (storage.error) return diskRoot + card(`<div class="empty-note">${esc(storage.error)}</div>`);

  const home = (storage.homeTop || []).slice(0, 16);
  const max = Math.max(1, ...home.map((h) => h.bytes || 0));
  const homeRowsFixed = home
    .map((h) => `<div class="row clickable" data-dir="${esc(h.path)}" data-search="${esc(h.name.toLowerCase())}">
      <span class="row-ico">${folderIconImg(h.name)}</span>
      <div class="row-main"><div class="row-title">${esc(h.name)}</div><div style="margin-top:6px;max-width:320px">${bar(((h.bytes || 0) / max) * 100, 'var(--accent)')}</div></div>
      <div class="row-size">${fmtBytes(h.bytes)}</div>
    </div>`)
    .join('');

  const cacheRows = (storage.caches || [])
    .map((c) => {
      const target = CACHE_TARGET_BY_NAME(c.name);
      const actions = target && !state.session.readOnly
        ? `${actBtn('cache.prune', { target }, 'Prune…', 'danger')}`
        : '';
      return row({ title: esc(c.name), size: fmtBytes(c.bytes), actions, search: c.name });
    })
    .join('');

  const fileRow = (item, labelPrefix = '') =>
    row({
      title: esc(labelPrefix + item.name),
      icon: `<span class="row-ico">${fileIconImg(item.name)}</span>`,
      size: fmtBytes(item.bytes),
      actions: `${actBtn('file.reveal', { path: item.path }, 'Reveal')}${actBtn('file.trash', { path: item.path }, 'Trash…', 'danger')}`,
      search: item.name,
      clickable: true,
      attrs: `data-file-path="${esc(item.path)}" data-file-name="${esc(item.name)}" data-file-bytes="${item.bytes || 0}"`,
    });

  const downloadRows = (storage.downloads || []).slice(0, 12).map((f) => fileRow(f)).join('');
  const backups = [...(storage.backups?.home || []), ...(storage.backups?.openclaw || []).map((b) => ({ ...b, name: `openclaw/backups/${b.name}` }))];
  const backupRows = backups.map((b) => fileRow(b, '')).join('');

  const misc = [
    storage.hfBytes ? { name: 'HuggingFace cache', bytes: storage.hfBytes } : null,
    storage.lmstudioBytes ? { name: 'LM Studio', bytes: storage.lmstudioBytes } : null,
    storage.trashBytes ? { name: 'Trash', bytes: storage.trashBytes } : null,
  ].filter(Boolean);
  const miscRows = misc.map((m) => row({ title: esc(m.name), size: fmtBytes(m.bytes) })).join('');

  const disk = data.system?.disk || {};
  const cachesBytes = data.summary?.cachesBytes || (storage.caches || []).reduce((sum, c) => sum + (c.bytes || 0), 0);
  const downloadsBytes = (storage.downloads || []).reduce((sum, f) => sum + (f.bytes || 0), 0);
  const storageWidgets = [
    disk.totalBytes ? {
      icon: 'disk', label: 'Disk usage', value: fmtBytes(disk.usedBytes),
      hint: `${fmtBytes(disk.freeBytes)} free of ${fmtBytes(disk.totalBytes)}`,
      viz: statMeter(disk.usedPercent, disk.usedPercent > 90 ? 'var(--red)' : disk.usedPercent > 75 ? 'var(--orange)' : 'var(--green)'),
    } : null,
    { icon: 'layers', label: 'Caches', value: fmtBytes(cachesBytes), hint: `${(storage.caches || []).length} locations` },
    storage.trashBytes ? { icon: 'trash', label: 'Trash', value: fmtBytes(storage.trashBytes), hint: 'emptied from the Clean up panel' } : null,
    { icon: 'download', label: 'Downloads', value: fmtBytes(downloadsBytes), hint: `${(storage.downloads || []).length} items` },
    storage.hfBytes ? { icon: 'brain', label: 'HuggingFace cache', value: fmtBytes(storage.hfBytes), hint: 'model downloads' } : null,
  ].filter(Boolean).map(statTile).join('');

  return [
    storageWidgets ? `<div class="grid stats">${storageWidgets}</div>` : '',
    diskRoot,
    group('Home directory', 'largest items first', card(`<div class="rows">${homeRowsFixed || '<div class="empty-note">No data</div>'}</div>`)),
    group('Caches', null, card(`<div class="rows">${cacheRows || '<div class="empty-note">No caches found</div>'}</div>`)),
    group('Downloads', null, card(`<div class="rows">${downloadRows || '<div class="empty-note">Empty</div>'}</div>`)),
    group('Backups', null, card(`<div class="rows">${backupRows || '<div class="empty-note">None</div>'}</div>`)),
    misc.length ? group('Other', null, card(`<div class="rows">${miscRows}</div>`)) : '',
  ].join('');
}

function viewOllama(data) {
  const ollama = data.ollama || {};
  if (ollama.error) {
    return emptyState({ icon: 'brain', title: 'Ollama', body: `Could not read Ollama: <span class="mono">${esc(ollama.error)}</span>`, action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>` });
  }
  if (!ollama.installed) {
    return emptyState({
      icon: 'brain',
      title: 'Run local AI models',
      body: 'Ollama serves open models locally. Install it, pull a model, and it shows up here with sizes, memory use and benchmarks.',
      command: 'brew install ollama',
      docs: 'https://ollama.com/download',
      steps: ['Install Ollama (or start the desktop app)', 'Start the server, <span class="mono">brew services start ollama</span>', 'Pull a model, <span class="mono">ollama pull llama3.2</span>'],
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }

  const loadedNames = new Set((ollama.loaded || []).map((m) => m.name));
  const max = Math.max(1, ...(ollama.models || []).map((m) => m.sizeBytes || 0));
  const memoryBytes = data.system?.memoryBytes || 0;
  const usedBases = agentUsedBases(data);

  const modelRows = (ollama.models || [])
    .map((m) => {
      const loaded = loadedNames.has(m.name);
      const used = usedBases.has(baseOfName(m.name));
      const ctx = m.contextLength ? `${Math.round(m.contextLength / 1024)}K ctx` : null;
      const details = [m.parameterSize, m.quantization, ctx, ...(m.capabilities || [])].filter(Boolean).join(' · ');
      const tooBig = memoryBytes && (m.sizeBytes || 0) > memoryBytes * 0.95;
      const badges = `${used ? pill('in use', 'accent') : ''}${loaded ? pill('in memory', 'accent') : ''}${m.shared ? pill('shared blob') : ''}${tooBig ? pill('exceeds RAM', 'bad') : ''}`;
      const copy = `<button class="btn small icon" data-copy="ollama run ${esc(m.name)}" title="Copy run command">${svg('copy')}</button>`;
      const actions = `${copy}${loaded ? actBtn('ollama.unload', { model: m.name }, 'Unload') : actBtn('ollama.load', { model: m.name }, 'Load')}${actBtn('ollama.benchmark', { model: m.name }, 'Bench')}${actBtn('ollama.remove', { model: m.name }, 'Delete…', 'danger', { impact: `Frees up to ${fmtBytes(m.sizeBytes)} (shared blobs free when all tags go)` })}`;
      const search = `${m.name} ${m.family || ''} ${m.quantization || ''} ${(m.capabilities || []).join(' ')}`.toLowerCase();
      const modelIcon = (m.capabilities || []).includes('vision') ? 'photo' : 'brain';
      return `<div class="row model-row clickable" data-model="${esc(m.name)}" data-search="${esc(search)}">
      <span class="row-ico-svg">${svg(modelIcon)}</span>
      <div class="row-main">
        <div class="row-line">
          <span class="model-name" title="${esc(m.name)}">${esc(m.name)}</span>
          ${badges}
        </div>
        <div class="row-sub" title="${esc(details)}">${esc(details || '–')}</div>
      </div>
      <div class="model-meter">${bar(((m.sizeBytes || 0) / max) * 100)}</div>
      <div class="row-size">${fmtBytes(m.sizeBytes)}<div class="model-when faint">${esc(relativeTime(m.modifiedAt))}</div></div>
      <div class="row-actions">${actions}</div>
    </div>`;
    })
    .join('');

  const loadedRows = (ollama.loaded || [])
    .map((m) =>
      row({
        title: esc(m.name),
        sub: `${fmtBytes(m.sizeVram)} in memory · ${esc(expiresText(m.expiresAt))}`,
        actions: actBtn('ollama.unload', { model: m.name }, 'Unload'),
        search: m.name,
        clickable: true,
        attrs: `data-model="${esc(m.name)}"`,
      }),
    )
    .join('');

  const header = state.session.readOnly
    ? ''
    : `<div class="toolbar-row">
        ${ollama.loaded?.length ? `<button class="btn small" data-act="ollama.unloadAll" data-params='{}'>Unload all</button>` : ''}
        <button class="btn primary" data-form="ollama.pull">${svg('download')} Pull model…</button>
      </div>`;

  const modelHint = [
    `${ollama.modelCount || 0} installed`,
    ollama.tagCount && ollama.tagCount !== ollama.modelCount ? `${ollama.tagCount} tags` : null,
    fmtBytes(ollama.totalBytes),
  ]
    .filter(Boolean)
    .join(' · ');

  const server = card(`<dl class="kv">
    <dt>Status</dt><dd>${statusPill(ollama.running)}</dd>
    <dt>Version</dt><dd>${esc(ollama.version || '–')}</dd>
    <dt>Endpoint</dt><dd class="mono">${esc(ollama.host)}</dd>
    <dt>Models directory</dt><dd class="mono">${esc(ollama.dir)}</dd>
    <dt>Disk usage</dt><dd>${fmtBytes(ollama.dirBytes)}</dd>
  </dl>`);

  const loadedBytes = (ollama.loaded || []).reduce((sum, m) => sum + (m.sizeVram || 0), 0);
  const modelSizes = (ollama.models || []).map((m) => m.sizeBytes || 0).sort((a, b) => b - a).slice(0, 7);
  const biggest = (ollama.models || []).slice().sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))[0];
  const ollamaWidgets = [
    { icon: 'brain', label: 'Installed models', value: fmtNum(ollama.modelCount), hint: `${fmtBytes(ollama.totalBytes)} on disk${ollama.tagCount && ollama.tagCount !== ollama.modelCount ? ` · ${fmtNum(ollama.tagCount)} tags` : ''}`, viz: statBars(modelSizes) },
    { icon: 'layers', label: 'In memory', value: fmtBytes(loadedBytes), hint: `${(ollama.loaded || []).length} loaded`, tone: (ollama.loaded || []).length ? 'accent' : '' },
    biggest ? { icon: 'cube', label: 'Largest model', value: fmtBytes(biggest.sizeBytes), hint: biggest.name } : null,
  ].filter(Boolean).map(statTile).join('');

  return [
    header,
    `<div class="grid stats">${ollamaWidgets}</div>`,
    group('Loaded in memory', `${ollama.loaded?.length || 0} of ${ollama.modelCount || 0}`, card(`<div class="rows">${loadedRows || '<div class="empty-note">No models currently loaded.</div>'}</div>`)),
    group('Installed models', modelHint, card(`<div class="rows">${modelRows || '<div class="empty-note">No models found.</div>'}</div>`)),
    `<div id="model-extras">${skeletonRows(3)}</div>`,
    group('Server', null, server),
  ].join('');
}

function viewComfy(data) {
  const comfy = data.comfyui || {};
  if (comfy.error) {
    return emptyState({ icon: 'photo', title: 'ComfyUI', body: `Could not read ComfyUI: <span class="mono">${esc(comfy.error)}</span>`, action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>` });
  }
  if (!comfy.installed) {
    return emptyState({
      icon: 'photo',
      title: 'Generate images locally',
      body: 'ComfyUI is a node-based interface for Stable Diffusion. Point it at a model folder and your checkpoints appear here with sizes and usage.',
      docs: 'https://github.com/comfyanonymous/ComfyUI',
      command: 'git clone https://github.com/comfyanonymous/ComfyUI.git ~/ComfyUI',
      steps: ['Clone ComfyUI into <span class="mono">~/ComfyUI</span>', 'Add checkpoints to <span class="mono">~/ComfyUI/models/checkpoints</span>', 'Start it with <span class="mono">python main.py</span> (or your own launch agent)'],
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }

  const groups = (comfy.modelGroups || []).filter((g) => (g.bytes || 0) > 0);
  const groupRows = groups.map((g) => `<tr class="clickable" data-comfy-group="${esc(g.type)}" data-search="${esc(g.type.toLowerCase())}"><td>${esc(g.type)}</td><td class="num">${fmtBytes(g.bytes)}</td><td class="num">${g.fileCount}</td><td class="truncate muted">${esc((g.files || []).map((f) => f.name).join(', '))}</td></tr>`);

  const checkpointRows = (comfy.checkpoints || []).map((f) =>
    row({
      title: esc(f.name),
      sub: `${fmtBytes(f.bytes)} · added ${esc(relativeTime(f.modifiedAt))}`,
      icon: `<span class="row-ico">${fileIconImg(f.name)}</span>`,
      actions: `${actBtn('file.reveal', { path: `${comfy.path}/models/checkpoints/${f.name}` }, 'Reveal')}${actBtn('file.trash', { path: `${comfy.path}/models/checkpoints/${f.name}` }, 'Trash…', 'danger')}`,
      search: f.name,
      clickable: true,
      attrs: `data-checkpoint="${esc(`${comfy.path}/models/checkpoints/${f.name}`)}" data-ckpt-name="${esc(f.name)}" data-ckpt-bytes="${f.bytes || 0}"`,
    }),
  ).join('');

  const workflows = [
    ...(comfy.workflows?.openclaw || []).map((w) => ({ name: w, where: 'OpenClaw' })),
    ...(comfy.workflows?.native || []).map((w) => ({ name: w, where: 'ComfyUI' })),
  ];
  const workflowChips = workflows.length
    ? `<div class="chips">${workflows.map((w) => `<span class="chip" data-search="${esc((w.name + ' ' + w.where).toLowerCase())}">${esc(w.name)} <span class="faint">${esc(w.where)}</span></span>`).join('')}</div>`
    : '<div class="empty-note">No workflows found.</div>';

  const nodeChips = comfy.customNodes?.length
    ? `<div class="chips">${comfy.customNodes.map((n) => `<span class="chip" data-search="${esc(n.toLowerCase())}">${esc(n)}</span>`).join('')}</div>`
    : '<div class="empty-note">Only built-in example nodes.</div>';

  const py = comfy.python;
  const env = py
    ? `<dl class="kv"><dt>Python</dt><dd>${esc(py.python || '–')}</dd><dt>Packages</dt><dd>${fmtNum(py.packageCount)}</dd></dl><div class="chips">${(py.aiPackages || []).map((p) => `<span class="chip" data-search="${esc(p.toLowerCase())}">${esc(p)}</span>`).join('')}</div>`
    : '<div class="empty-note">No virtualenv found.</div>';

  const header = `<div class="toolbar-row">
    <a class="btn small" href="${esc(comfy.host)}" target="_blank" rel="noopener">Open ComfyUI</a>
    ${actBtn('file.reveal', { path: `${comfy.path}/output` }, 'Open outputs')}
    ${state.session.readOnly ? '' : actBtn('service.restart', { label: 'ai.openclaw.comfyui' }, 'Restart')}
  </div>`;

  return [
    header,
    group('Checkpoints', `${fmtBytes(comfy.modelsTotalBytes)} of models`, card(`<div class="rows">${checkpointRows || '<div class="empty-note">No checkpoints.</div>'}</div>`)),
    `<div id="comfy-analysis">${skeletonRows(3)}</div>`,
    `<div id="comfy-queue">${skeletonRows(2)}</div>`,
    group('Models by type', null, card(table([{ label: 'Type' }, { label: 'Size', num: true }, { label: 'Files', num: true }, { label: 'Contents' }], groupRows, 'No models installed.'))),
    group('Server', null, card(`<dl class="kv"><dt>Status</dt><dd>${statusPill(comfy.running)}</dd><dt>Version</dt><dd>${esc(comfy.version || '–')}</dd><dt>Endpoint</dt><dd class="mono">${esc(comfy.host)}</dd><dt>Install</dt><dd class="mono">${esc(comfy.path)}</dd><dt>Outputs</dt><dd>${fmtBytes(comfy.outputBytes)}</dd><dt>Inputs</dt><dd>${fmtBytes(comfy.inputBytes)}</dd></dl>`)),
    group('Environment', null, card(env)),
    group('Workflows', null, card(workflowChips)),
    group('Custom nodes', null, card(nodeChips)),
    `<div id="gallery-root">${skeletonRows(2)}</div>`,
    `<div id="hf-root">${skeletonRows(2)}</div>`,
  ].join('');
}

function viewRuntimes(data) {
  const runtimes = Array.isArray(data.runtimes) ? data.runtimes : [];
  if (!runtimes.length) {
    return emptyState({
      icon: 'cube',
      title: 'ML runtimes',
      body: 'llama.cpp, MLX and whisper.cpp let you run models outside Ollama. Install any of them and their binaries and models appear here.',
      command: 'brew install llama.cpp mlx whisper.cpp',
      docs: 'https://github.com/ggml-org/llama.cpp',
      steps: ['Install a runtime with Homebrew', 'Optionally add GGUF models under a models folder', 'Rescan to pick them up'],
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }
  const totalModelFiles = runtimes.reduce((sum, rt) => sum + (rt.models || []).length, 0);
  const totalModelBytes = runtimes.reduce((sum, rt) => sum + (rt.models || []).reduce((a, m) => a + (m.bytes || 0), 0), 0);
  const runtimeWidgets = [
    { icon: 'cube', label: 'Runtimes', value: fmtNum(runtimes.length), hint: runtimes.map((rt) => rt.name).join(', ') },
    { icon: 'layers', label: 'Local model files', value: fmtNum(totalModelFiles), hint: fmtBytes(totalModelBytes) },
  ].map(statTile).join('');
  return `<div class="grid stats">${runtimeWidgets}</div><div class="grid two">${runtimes
    .map((rt) => {
      const models = (rt.models || [])
        .map((m) =>
          row({
            title: esc(m.name),
            sub: esc(m.dir || ''),
            size: fmtBytes(m.bytes),
            actions: actBtn('file.reveal', { path: m.path || `${m.dir}/${m.name}` }, 'Reveal'),
            search: `${rt.name} ${m.name}`,
            clickable: true,
            attrs: `data-model-file="${esc(m.path || `${m.dir}/${m.name}`)}" data-file-name="${esc(m.name)}" data-file-dir="${esc(m.dir || '')}" data-file-bytes="${m.bytes || 0}"`,
          }),
        )
        .join('');
      const total = (rt.models || []).reduce((sum, m) => sum + (m.bytes || 0), 0);
      const header = `<div class="pad">
        <div class="row-line"><span style="font-size:15px;font-weight:600">${esc(rt.name)}</span>${pill(rt.kind || 'runtime')}</div>
        <div class="muted" style="font-size:12px;margin-top:3px">${esc(rt.version || 'version unknown')} · ${esc(rt.source || '')}</div>
        ${rt.binary ? `<div class="mono faint" style="font-size:11px;margin-top:5px">${esc(rt.binary)}</div>` : ''}
        ${total ? `<div class="hint" style="margin-top:6px">${fmtBytes(total)} of models</div>` : ''}
      </div>`;
      return card(`${header}${models ? `<div class="rows">${models}</div>` : '<div class="empty-note">No local model files</div>'}`);
    })
    .join('')}</div>`;
}

function viewAgent(data) {
  const agent = data.agentStack || {};
  if (agent.error) {
    return emptyState({ icon: 'bot', title: 'Agent stack', body: `Could not read the agent config: <span class="mono">${esc(agent.error)}</span>`, action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>` });
  }
  const oc = agent.openclaw;
  if (!oc) {
    return emptyState({
      icon: 'bot',
      title: 'Agent stack',
      body: 'OpenClaw is a local agent runtime. When its config exists, routing, plugins, workflows, backups and sessions all show up here.',
      docs: 'https://openclaw.ai',
      steps: ['Install OpenClaw', 'Create a config at <span class="mono">~/.openclaw/openclaw.json</span>', 'Start the gateway service'],
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }

  const routing = [
    ['Primary model', oc.primaryModel],
    ['Fallbacks', (oc.fallbackModels || []).join(', ') || 'none'],
    ['Utility model', oc.utilityModel],
    ['Subagent model', oc.subagentModel],
    ['Image model', oc.imageModel],
    ['Media image pipeline', oc.mediaImage?.primary],
    ['Gateway port', oc.gateway?.port],
    ['Tools profile', oc.toolsProfile],
  ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('');

  const aliases = Object.entries(oc.aliasModels || {}).map(([model, cfg]) => `<span class="chip" data-search="${esc((cfg.alias + ' ' + model).toLowerCase())}">${esc(cfg.alias || '?')} → ${esc(model)}</span>`).join('');
  const plugins = (oc.plugins || []).map((p) => `<span class="chip" data-search="${esc(p.name.toLowerCase())}">${esc(p.name)} ${p.enabled ? pill('on', 'good') : pill('off')}</span>`).join('');
  const skills = (oc.enabledSkills || []).map((s) => `<span class="chip" data-search="${esc(s.toLowerCase())}">${esc(s)}</span>`).join('');

  const agentRows = (oc.agents || []).map((a) => `<tr data-search="${esc((a.name + ' ' + a.id).toLowerCase())}"><td>${esc(a.name)}</td><td class="mono">${esc(a.id)}</td><td>${esc(a.identity || '–')}</td><td>${esc(a.heartbeat || '–')}</td></tr>`);
  const extRows = (agent.extensions || []).map((e) => `<tr data-search="${esc(e.name.toLowerCase())}"><td>${esc(e.name)}</td><td>${esc(e.version || '–')}</td><td class="truncate muted">${esc(e.description || '')}</td></tr>`);
  const workflowChips = (agent.workflows || []).map((w) => `<span class="chip" data-search="${esc(w.toLowerCase())}">${esc(w)}</span>`).join('');

  const header = `<div class="toolbar-row">
    <button class="btn small openclaw-toggle" id="openclaw-toggle" type="button" hidden></button>
    ${state.session.readOnly ? '' : `${actBtn('file.reveal', { path: oc.configPath }, 'Reveal config')}${actBtn('service.restart', { label: 'ai.openclaw.gateway' }, 'Restart gateway')}`}
  </div>`;

  return [
    header,
    group('Model routing', oc.version, card(`<dl class="kv">${routing || '<dt class="faint">No routing configured</dt>'}</dl>`)),
    aliases ? group('Model aliases', null, card(`<div class="chips">${aliases}</div>`)) : '',
    group('Plugins', null, card(`<div class="chips">${plugins || '<span class="faint">None</span>'}</div>`)),
    group('Enabled skills', `${(oc.enabledSkills || []).length}`, card(`<div class="chips">${skills || '<span class="faint">None</span>'}</div>`)),
    group('Agents', null, card(table([{ label: 'Name' }, { label: 'ID' }, { label: 'Identity' }, { label: 'Heartbeat' }], agentRows, 'No agents configured'))),
    group('Extensions', null, card(table([{ label: 'Name' }, { label: 'Version' }, { label: 'Description' }], extRows, 'No extensions'))),
    group('Workflows', null, card(`<div class="chips">${workflowChips || '<span class="faint">None</span>'}</div>`)),
    group('Configuration', null, card(`<dl class="kv"><dt>Config file</dt><dd class="mono">${esc(oc.configPath)}</dd><dt>State dir</dt><dd class="mono">${esc(agent.paths?.openclaw || '')}</dd><dt>Workspace</dt><dd class="mono">${esc(oc.workspace || '')}</dd><dt>opencode</dt><dd class="mono">${esc(agent.opencode?.version || '–')}</dd><dt>opencode config</dt><dd class="mono">${esc(agent.opencode?.configDir || 'not found')}</dd></dl><div class="pad" style="padding-top:0"><span class="faint" style="font-size:11px">Secrets in the config are redacted before display.</span></div>`)),
  ].join('');
}

function viewServices(data) {
  const services = data.services || {};
  const svcRows = (services.services || [])
    .map((s) => {
      const logName = s.label.split('.').pop();
      const logBtn = `<button class="btn small icon" data-log-jump="${esc(logName)}" title="Open matching log">${svg('history')}</button>`;
      const manage = state.session.readOnly
        ? ''
        : `${s.running ? actBtn('service.restart', { label: s.label }, 'Restart') : actBtn('service.start', { label: s.label }, 'Start')}${s.running ? actBtn('service.stop', { label: s.label }, 'Stop…', 'danger') : ''}`;
      const svcIcon = /comfy/i.test(s.label) ? 'photo' : /ollama/i.test(s.label) ? 'brain' : /openclaw|gateway|miniapp|icloud/i.test(s.label) ? 'bot' : 'gears';
      return `<div class="row clickable" data-service="${esc(s.label)}" data-search="${esc((s.label + ' ' + (s.friendly || '')).toLowerCase())}">
      <span class="status-dot ${s.running ? 'good' : 'warn'}"></span>
      <span class="row-ico-svg">${svg(svcIcon)}</span>
      <div class="row-main">
        <div class="row-title">${esc(s.friendly || s.label)}</div>
        <div class="row-sub mono">${esc(s.label)}${s.pid ? ` · pid ${s.pid}` : ''}</div>
      </div>
      <div class="row-actions">${manage}${logBtn}</div>
    </div>`;
    })
    .join('');

  const ports = Array.isArray(data.ports) ? data.ports : [];
  const portRows = ports.map((p) => `<tr class="clickable" data-port="${p.port}" data-search="${esc(((p.label || '') + ' ' + p.command + ' ' + p.port).toLowerCase())}"><td class="num mono">${p.port}</td><td><span class="td-ico">${svg(serviceGlyph(p.label || p.command))}</span>${esc(p.label || p.command)}</td><td class="mono">${esc(p.command)} <span class="faint">#${p.pid}</span></td><td class="mono">${esc((p.hosts || []).join(', '))}</td></tr>`);

  const agentRows = (services.launchAgents || []).map((a) => row({ title: esc(a.name), size: fmtBytes(a.bytes), sub: `modified ${esc(relativeTime(a.modifiedAt))}`, search: a.name, icon: `<span class="row-ico">${fileIconImg(a.name)}</span>` })).join('');

  const runningCount = (services.services || []).filter((s) => s.running).length;
  const stoppedCount = (services.services || []).length - runningCount;
  const serviceWidgets = [
    { icon: 'gears', label: 'Services running', value: fmtNum(runningCount), hint: `${stoppedCount} stopped · ${(services.services || []).length} total`, viz: statSegments([{ value: runningCount, color: 'var(--green)', label: 'Running' }, { value: stoppedCount, color: 'var(--orange)', label: 'Stopped' }]) },
    { icon: 'network', label: 'Listening ports', value: fmtNum(ports.length), hint: 'loopback + LAN' },
    { icon: 'layers', label: 'LaunchAgents', value: fmtNum((services.launchAgents || []).length), hint: 'user login items' },
  ].map(statTile).join('');

  return [
    `<div class="grid stats">${serviceWidgets}</div>`,
    `<div id="health-root">${skeletonRows(3)}</div>`,
    group('Launchd services', 'start, stop and restart your AI services', card(`<div class="rows">${svcRows || '<div class="empty-note">No user services</div>'}</div>`)),
    group('Listening ports', null, card(table([{ label: 'Port', num: true }, { label: 'Service' }, { label: 'Process' }, { label: 'Bind' }], portRows, 'None'))),
    group('LaunchAgents', null, card(`<div class="rows">${agentRows || '<div class="empty-note">None</div>'}</div>`)),
    `<div id="logs-root">${skeletonRows(3)}</div>`,
  ].join('');
}

const CORE_BREW = /(ollama|llama\.cpp|mlx|ggml|whisper|opencode|summarize|ffmpeg|python@|node|deno|uv|yt-dlp|aria2|cloudflared|tesseract|ripgrep|git)/i;

function viewBrew(data) {
  const brew = data.homebrew || {};
  if (brew.error) {
    return emptyState({
      icon: 'mug',
      title: 'Install Homebrew',
      body: 'Homebrew is the package manager much of this dashboard builds on, formulae, casks, and the Store all rely on it.',
      command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      docs: 'https://brew.sh',
      steps: ['Run the installer above', 'Follow the two commands it prints at the end', 'Rescan, installed packages and casks show up here'],
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }

  const brewSvcRows = (brew.services || []).map((s) => {
    const label = s.file ? s.file.split('/').pop().replace(/\.plist$/, '') : null;
    return `<tr${label ? ` class="clickable" data-service="${esc(label)}"` : ''} data-search="${esc(s.name.toLowerCase())}"><td class="mono">${esc(s.name)}</td><td>${esc(s.status || '')}</td></tr>`;
  });

  const toolbar = `<div class="toolbar-row">
    <button class="btn small" data-store-open>${svg('shop')} Open Store</button>
    ${state.session.readOnly ? '' : `<button class="btn small" data-act="brew.upgradeAll" data-params='{}'>Upgrade all…</button><button class="btn small" data-act="brew.cleanup" data-params='{}'>${svg('trash')} Clean up…</button>`}
  </div>`;

  return [
    toolbar,
    `<div class="grid stats">
      ${statTile({ icon: 'cube', label: 'Formulae', value: fmtNum(brew.formulaCount ?? (brew.packages || []).length), hint: `${fmtBytes(brew.cellarBytes)} installed`, viz: statSegments([{ value: brew.formulaCount || (brew.packages || []).length, color: 'var(--accent)', label: 'Formulae' }, { value: (brew.casks || []).length, color: 'var(--text-3)', label: 'Casks' }]) })}
      ${statTile({ icon: 'download', label: 'Download cache', value: fmtBytes(brew.cacheBytes), hint: 'safe to prune', viz: statMeter(((brew.cacheBytes || 0) / ((brew.cacheBytes || 0) + (brew.cellarBytes || 1))) * 100, 'var(--orange)') })}
      ${statTile({ icon: 'box', label: 'Casks', value: fmtNum((brew.casks || []).length), hint: (brew.casks || []).slice(0, 3).join(', ') || 'none' })}
    </div>`,
    `<div id="brew-root">${skeletonRows(7)}</div>`,
    brew.services?.length ? group('brew services', null, card(table([{ label: 'Service' }, { label: 'Status' }], brewSvcRows))) : '',
  ].join('');
}

// --- Homebrew split-pane ---------------------------------------------------

const SPLIT_NARROW = '(max-width: 1000px)';
const brewState = { data: null, names: new Set(), selected: null, filter: 'all', hideDeps: true, query: '' };

function brewVisible() {
  const query = brewState.query.trim().toLowerCase();
  return (brewState.data?.packages || []).filter((pkg) => {
    if (brewState.filter !== 'all' && pkg.kind !== brewState.filter) return false;
    if (brewState.hideDeps && pkg.reason === 'dependency') return false;
    if (query && !`${pkg.name} ${pkg.displayName || ''} ${pkg.desc || ''}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function brewShell() {
  const counts = brewState.data?.counts || {};
  const seg = (value, label, n) => `<button class="seg${brewState.filter === value ? ' active' : ''}" data-brew-filter="${value}">${label}<span class="seg-count">${fmtNum(n || 0)}</span></button>`;
  return `
    <div class="split">
      <div class="split-list">
        <div class="split-controls">
          <div class="segmented">${seg('all', 'All', counts.total)}${seg('formula', 'Formulae', counts.formula)}${seg('cask', 'Casks', counts.cask)}</div>
          <label class="toggle-inline"><input type="checkbox" data-brew-hidedeps ${brewState.hideDeps ? 'checked' : ''} /><span>Hide dependencies</span></label>
        </div>
        <input id="brew-search" class="row-input brew-search" placeholder="Search installed packages…" autocomplete="off" spellcheck="false" value="${esc(brewState.query)}" />
        <div class="list" id="brew-list">${skeletonRows(7)}</div>
      </div>
      <aside class="split-detail" id="brew-detail"><div class="empty-note">Select a package to see its details.</div></aside>
    </div>
    <div class="status-bar"><span class="status-dot ${counts.outdated ? 'amber' : 'good'}"></span>${counts.outdated ? `${fmtNum(counts.outdated)} upgrade${counts.outdated === 1 ? '' : 's'} available` : 'Ready'} · ${fmtNum(counts.total || 0)} packages${counts.dependencies ? ` · ${fmtNum(counts.dependencies)} dependencies hidden` : ''}</div>`;
}

function brewRow(pkg) {
  const selected = pkg.name === brewState.selected;
  const badge = `<span class="type-badge">${pkg.kind === 'cask' ? 'CASK' : 'FORMULA'}</span>`;
  const flag = pkg.outdated ? `<span class="pkg-flag amber" title="Upgrade available">↑ ${esc(pkg.latest || '')}</span>` : `<span class="pkg-flag good" title="Up to date">${svg('check')}</span>`;
  const icon = pkg.appPath ? `<img class="app-icon" loading="lazy" decoding="async" width="22" height="22" alt="" src="${esc(appIconUrl(pkg.appPath, 64))}" />` : '';
  return `<button class="pkg-row${selected ? ' selected' : ''}" data-brew-pkg="${esc(pkg.name)}">
    ${icon}
    <span class="pkg-main">
      <span class="pkg-title"><span class="pkg-name">${esc(pkg.name)}</span>${badge}${flag}</span>
      ${pkg.desc ? `<span class="pkg-desc">${esc(pkg.desc)}</span>` : ''}
      ${pkg.installed ? `<span class="pkg-ver mono">v${esc(pkg.installed)}</span>` : ''}
    </span>
    <span class="pkg-chevron">›</span>
  </button>`;
}

function brewDetail(pkg) {
  const dependents = (brewState.data?.dependents || {})[pkg.name] || [];
  const reason = pkg.reason === 'requested' ? 'Installed on request' : 'As dependency';
  const date = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '–');
  const cmd = `brew uninstall --${pkg.kind === 'cask' ? 'cask' : 'formula'} ${pkg.name}`;
  const deps = pkg.deps || [];
  const depChips = deps.length
    ? `<div class="chips">${deps.map((d) => (brewState.names.has(d) ? `<span class="chip clickable" data-brew-pkg="${esc(d)}">${esc(d)}</span>` : `<span class="chip">${esc(d)}</span>`)).join('')}</div>`
    : '<div class="detail-empty">No dependencies.</div>';
  const dependentRows = dependents.length
    ? `<div class="rows">${dependents.map((d) => row({ title: `<span class="mono">${esc(d)}</span>`, sub: 'depends on this package', clickable: true, attrs: `data-brew-pkg="${esc(d)}"`, search: d })).join('')}</div>`
    : '<div class="detail-empty">Nothing installed depends on this package.</div>';
  const actions = state.session.readOnly
    ? ''
    : [
        pkg.outdated ? actBtn('brew.upgrade', { name: pkg.name }, 'Upgrade') : '',
        actBtn('brew.uninstall', { name: pkg.name, kind: pkg.kind }, 'Uninstall…', 'danger', { impact: dependents.length ? `${dependents.length} installed package${dependents.length === 1 ? '' : 's'} depend on this` : `Removes ${pkg.name} from this Mac` }),
      ].filter(Boolean).join('');
  return `
    <div class="detail-head">
      <div class="detail-icon">${pkg.appPath ? `<img class="app-icon-lg" loading="lazy" decoding="async" alt="" src="${esc(appIconUrl(pkg.appPath, 128))}" />` : svg(pkg.kind === 'cask' ? 'box' : 'cube')}</div>
      <div class="detail-title"><h2>${esc(pkg.displayName || pkg.name)}</h2><p>${esc(pkg.desc || (pkg.kind === 'cask' ? 'Application' : 'Formula'))}</p></div>
      <span class="type-badge">${pkg.kind === 'cask' ? 'CASK' : 'FORMULA'}</span>
      ${pkg.outdated ? '<span class="pkg-flag amber">outdated</span>' : `<span class="pkg-flag good">${svg('check')}</span>`}
    </div>
    <div class="detail-scroll">
      <section class="detail-sec">
        <h3>Details</h3>
        <dl class="kv detail-kv">
          <dt>Installed</dt><dd class="mono">v${esc(pkg.installed || '–')}</dd>
          <dt>Latest version</dt><dd class="mono">v${esc(pkg.latest || '–')}${pkg.outdated ? ' <span class="pill warn">upgrade</span>' : ''}</dd>
          <dt>Installed on</dt><dd>${esc(date(pkg.installedOn))}${pkg.pouredFromBottle ? ' <span class="faint">poured from bottle</span>' : ''}</dd>
          <dt>Install reason</dt><dd>${esc(reason)}</dd>
          ${pkg.license ? `<dt>Licence</dt><dd>${esc(pkg.license)}</dd>` : ''}
          ${pkg.source ? `<dt>Source</dt><dd><a href="${esc(pkg.source)}" target="_blank" rel="noopener">${esc(pkg.tap || 'GitHub')} ↗</a></dd>` : ''}
          ${pkg.homepage ? `<dt>Homepage</dt><dd><a href="${esc(pkg.homepage)}" target="_blank" rel="noopener">${esc(pkg.homepage.replace(/^https?:\/\//, ''))} ↗</a></dd>` : ''}
        </dl>
      </section>
      <section class="detail-sec"><h3>Dependencies</h3>${depChips}</section>
      <section class="detail-sec"><h3>Dependents ${dependents.length ? '<span class="pill warn">blocking uninstall</span>' : ''}</h3>${dependentRows}</section>
      <section class="detail-sec">
        <h3>Uninstall</h3>
        <div class="cmd-block">
          <div class="cmd-head"><span>Terminal command</span><button class="btn small icon" data-copy="${esc(cmd)}" title="Copy command">${svg('copy')}</button></div>
          <code>${esc(cmd)}</code>
          <div class="cmd-note">Uninstalls this package from this Mac</div>
        </div>
        <div class="detail-actions">${actions}</div>
      </section>
    </div>`;
}

async function loadBrewPackages() {
  const host = document.getElementById('brew-root');
  if (!host) return;
  if (!brewState.data) {
    try {
      brewState.data = await fetch('/api/brew/packages', { cache: 'no-store' }).then((r) => r.json());
      brewState.names = new Set((brewState.data.packages || []).map((pkg) => pkg.name));
    } catch (error) {
      host.innerHTML = `<div class="empty-note">Could not read Homebrew packages: ${esc(error.message)}</div>`;
      return;
    }
  }
  const visible = brewVisible();
  if (!(brewState.data.packages || []).some((pkg) => pkg.name === brewState.selected) && visible.length) {
    brewState.selected = visible[0].name;
  }
  host.innerHTML = brewShell();
  renderBrew();
}

function renderBrew() {
  const list = document.getElementById('brew-list');
  const detail = document.getElementById('brew-detail');
  if (!list || !detail) return;
  const visible = brewVisible();
  list.innerHTML = visible.length ? visible.map(brewRow).join('') : '<div class="empty-note">No packages match.</div>';
  const selected = (brewState.data?.packages || []).find((pkg) => pkg.name === brewState.selected);
  detail.innerHTML = selected ? brewDetail(selected) : '<div class="empty-note">Select a package to see its details.</div>';
}

function selectBrewPkg(name) {
  brewState.selected = name;
  if (window.matchMedia && window.matchMedia(SPLIT_NARROW).matches) {
    const pkg = (brewState.data?.packages || []).find((p) => p.name === name);
    if (pkg) openPanel({ title: pkg.displayName || pkg.name, subtitle: pkg.desc || '', body: brewDetail(pkg) });
    return;
  }
  renderBrew();
}

const appsState = { apps: [], selected: null, query: '', filter: 'all', details: new Map() };

function appVisible() {
  const query = appsState.query.trim().toLowerCase();
  return appsState.apps.filter((app) => {
    if (appsState.filter === 'user' && app.root === '/Applications') return false;
    if (appsState.filter === 'system' && app.root !== '/Applications') return false;
    if (query && !`${app.name} ${app.root}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function appsShell() {
  const apps = appsState.apps;
  const userCount = apps.filter((a) => a.root !== '/Applications').length;
  const sysCount = apps.length - userCount;
  const totalSize = apps.reduce((sum, a) => sum + (a.bytes || 0), 0);
  const seg = (value, label, n) => `<button class="seg${appsState.filter === value ? ' active' : ''}" data-apps-filter="${value}">${label}<span class="seg-count">${fmtNum(n)}</span></button>`;
  return `
    <div class="split">
      <div class="split-list">
        <div class="split-controls">
          <div class="segmented">${seg('all', 'All', apps.length)}${seg('system', 'Applications', sysCount)}${seg('user', 'User', userCount)}</div>
          <span class="faint" style="font-size:11.5px">${fmtBytes(totalSize)} total</span>
        </div>
        <input id="apps-search" class="row-input brew-search" placeholder="Search applications…" autocomplete="off" spellcheck="false" value="${esc(appsState.query)}" />
        <div class="list" id="apps-list">${appRowsHtml()}</div>
      </div>
      <aside class="split-detail" id="apps-detail"><div class="empty-note">Select an application to see its details.</div></aside>
    </div>`;
}

function appRowsHtml() {
  const visible = appVisible();
  return visible.length ? visible.map(appRow).join('') : '<div class="empty-note">No applications match.</div>';
}

function appRow(app) {
  const selected = app.path === appsState.selected;
  return `<button class="pkg-row${selected ? ' selected' : ''}" data-app="${esc(app.path)}">
    <img class="app-icon" loading="lazy" decoding="async" width="22" height="22" alt="" src="${esc(appIconUrl(app.path, 64))}" />
    <span class="pkg-main">
      <span class="pkg-title"><span class="pkg-name">${esc(app.name)}</span></span>
      <span class="pkg-desc">${esc(app.root)}</span>
    </span>
    <span class="row-size">${fmtBytes(app.bytes)}</span>
    <span class="pkg-chevron">›</span>
  </button>`;
}

const APP_ICON_FALLBACK = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3.5" fill="#5b6070"/><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="2" fill="#8a90a0"/></svg>')}`;

function appIconUrl(appPath, size) {
  return `/api/apps/icon?path=${encodeURIComponent(appPath)}&size=${size}&v=1`;
}

function renderAppsList() {
  const list = document.getElementById('apps-list');
  if (list) list.innerHTML = appRowsHtml();
}

async function fetchAppDetail(appPath) {
  if (appsState.details.has(appPath)) return appsState.details.get(appPath);
  const info = await fetch(`/api/apps/detail?path=${encodeURIComponent(appPath)}`, { cache: 'no-store' }).then((r) => r.json());
  if (info.error) throw new Error(info.error);
  appsState.details.set(appPath, info);
  return info;
}

async function loadAppsDetail() {
  const detail = document.getElementById('apps-detail');
  if (!detail) return;
  const appPath = appsState.selected;
  if (!appPath) {
    detail.innerHTML = '<div class="empty-note">Select an application to see its details.</div>';
    return;
  }
  detail.innerHTML = skeletonRows(5);
  try {
    const info = await fetchAppDetail(appPath);
    detail.innerHTML = appDetailBody(info) + `<div class="detail-actions">${appDetailActions(info)}</div>`;
  } catch (error) {
    detail.innerHTML = `<div class="empty-note">${esc(error.message)}</div>`;
  }
}

function selectApp(appPath) {
  appsState.selected = appPath;
  if (window.matchMedia && window.matchMedia(SPLIT_NARROW).matches) {
    showAppDetail(appPath);
    return;
  }
  renderAppsList();
  loadAppsDetail();
}

function appDetailBody(info) {
  return `
    <div class="detail-head">
      <div class="detail-icon"><img class="app-icon-lg" loading="lazy" decoding="async" alt="" src="${esc(appIconUrl(info.path, 128))}" /></div>
      <div class="detail-title"><h2>${esc(info.name || baseName(info.path))}</h2><p>${esc(info.bundleId || info.path)}</p></div>
      ${info.system ? pill('system', 'warn') : pill('user', 'good')}
    </div>
    <div class="detail-scroll">
      <section class="detail-sec">
        <h3>Details</h3>
        <dl class="kv detail-kv">
          <dt>Bundle id</dt><dd class="mono">${esc(info.bundleId || '–')}</dd>
          <dt>Version</dt><dd>${esc(info.shortVersion || '–')}${info.buildVersion ? ` (${esc(info.buildVersion)})` : ''}</dd>
          <dt>Size</dt><dd>${fmtBytes(info.size)}</dd>
          <dt>Architecture</dt><dd>${esc(info.arch || '–')}</dd>
          <dt>Minimum macOS</dt><dd>${esc(info.minOS || '–')}</dd>
          <dt>Executable</dt><dd class="mono">${esc(info.executable || '–')}</dd>
          <dt>Modified</dt><dd>${esc(relativeTime(info.modifiedAt))}</dd>
          <dt>Signature</dt><dd>${info.signature && info.signature.signed != null ? (info.signature.signed ? pill('signed', 'good') : pill('unsigned', 'warn')) : '–'}</dd>
          ${info.signature && info.signature.authority ? `<dt>Signed by</dt><dd>${esc(info.signature.authority)}</dd>` : ''}
          ${info.signature && info.signature.teamId ? `<dt>Team ID</dt><dd class="mono">${esc(info.signature.teamId)}</dd>` : ''}
          <dt>Quarantined</dt><dd>${info.quarantined ? pill('yes', 'warn') : pill('no', 'good')}</dd>
          <dt>Location</dt><dd class="mono">${esc(info.path)}</dd>
        </dl>
      </section>
      <section class="detail-sec">
        <h3>Bundle contents</h3>
        ${(info.contents || []).length ? `<div class="chips">${info.contents.map((c) => `<span class="chip" data-search="${esc(c.toLowerCase())}">${esc(c)}</span>`).join('')}</div>` : '<div class="detail-empty">No contents listed.</div>'}
      </section>
    </div>`;
}

function appDetailActions(info) {
  return [
    `<button class="btn small" data-copy="${esc(info.bundleId || info.path)}">Copy bundle id</button>`,
    info.system ? '' : `<button class="btn small" data-act="app.quit" data-params='${esc(JSON.stringify({ name: info.name }))}' data-close-panel>Quit</button>`,
    info.system ? '' : `<button class="btn small ghost-danger" data-act="app.trash" data-params='${esc(JSON.stringify({ path: info.path }))}' data-close-panel>Trash…</button>`,
  ].filter(Boolean).join('');
}

function viewApps(data) {
  const apps = data.apps?.apps || [];
  if (data.apps?.error) return card(`<div class="empty-note">${esc(data.apps.error)}</div>`);
  appsState.apps = apps;
  if (!apps.some((a) => a.path === appsState.selected) && apps.length) appsState.selected = apps[0].path;
  return appsShell();
}

const packagesState = { data: null, source: '3.14', query: '', selected: null, outdated: null, details: new Map() };

function packageSources() {
  const packages = packagesState.data || {};
  const sources = [];
  const python = packages.python || {};
  for (const label of ['3.14', '3.12']) {
    if (python[label]) sources.push({ id: `py:${label}`, label: `Python ${label}`, count: python[label].count ?? (python[label].packages || []).length });
  }
  if (packages.npm) sources.push({ id: 'npm', label: 'npm', count: (packages.npm.global || []).length });
  return sources;
}

function packageItems() {
  const packages = packagesState.data || {};
  if (packagesState.source === 'npm') return (packages.npm?.global || []).map((p) => ({ name: p.name, version: p.version }));
  const label = packagesState.source.split(':')[1];
  return (packages.python?.[label]?.packages || []).map((p) => ({ name: p.name, version: p.version }));
}

function packagesVisible() {
  const query = packagesState.query.trim().toLowerCase();
  const items = packageItems();
  return query ? items.filter((item) => item.name.toLowerCase().includes(query)) : items;
}

function outdatedNames() {
  const outdated = packagesState.outdated;
  if (!outdated) return null;
  const set = new Set();
  if (packagesState.source === 'npm') {
    for (const pkg of (outdated.npm && outdated.npm.packages) || []) set.add(pkg.name);
  } else {
    const label = packagesState.source.split(':')[1];
    for (const pkg of (outdated.python && outdated.python[label] && outdated.python[label].packages) || []) set.add(pkg.name);
  }
  return set;
}

function ensurePackageSelection() {
  const items = packageItems();
  if (!items.some((item) => item.name === packagesState.selected) && items.length) packagesState.selected = items[0].name;
}

function packagesShell() {
  const sources = packageSources();
  const seg = sources.map((s) => `<button class="seg${packagesState.source === s.id ? ' active' : ''}" data-packages-source="${s.id}">${esc(s.label)}<span class="seg-count">${fmtNum(s.count)}</span></button>`).join('');
  const outSet = outdatedNames();
  const outdatedCount = outSet ? packageItems().filter((item) => outSet.has(item.name)).length : 0;
  const isNpm = packagesState.source === 'npm';
  const label = packagesState.source.split(':')[1];
  let status;
  if (!outSet) status = '<span class="faint" style="font-size:11.5px">checking for updates…</span>';
  else if (!outdatedCount) status = `<span class="faint" style="font-size:11.5px">up to date</span>`;
  else if (state.session.readOnly) status = `<span class="pill warn">${outdatedCount} outdated</span>`;
  else status = `<button class="btn small primary" data-act="${isNpm ? 'npm.updateAll' : 'pip.upgradeAll'}" data-params='${esc(JSON.stringify(isNpm ? {} : { label }))}' data-close-panel>Update all ${outdatedCount}</button>`;
  const searchLabel = isNpm ? 'npm' : `Python ${label}`;
  return `
    <div class="split">
      <div class="split-list">
        <div class="split-controls">
          <div class="segmented">${seg}</div>
          ${status}
        </div>
        <input id="packages-search" class="row-input brew-search" placeholder="Search ${esc(searchLabel)} packages…" autocomplete="off" spellcheck="false" value="${esc(packagesState.query)}" />
        <div class="list" id="packages-list">${packageRowsHtml()}</div>
      </div>
      <aside class="split-detail" id="packages-detail"><div class="empty-note">Select a package to see its details.</div></aside>
    </div>`;
}

function packageRowsHtml() {
  const outSet = outdatedNames();
  const visible = packagesVisible();
  if (!visible.length) return '<div class="empty-note">No packages match.</div>';
  return visible.map((item) => packageRow(item, outSet)).join('');
}

function packageRow(item, outSet) {
  const selected = item.name === packagesState.selected;
  const outdated = outSet && outSet.has(item.name);
  const glyph = packagesState.source === 'npm' ? 'box' : 'cube';
  return `<button class="pkg-row${selected ? ' selected' : ''}" data-pkg-name="${esc(item.name)}">
    <span class="row-ico-svg">${svg(glyph)}</span>
    <span class="pkg-main">
      <span class="pkg-title"><span class="pkg-name">${esc(item.name)}</span>${outdated ? '<span class="pkg-flag amber" title="Update available">↑</span>' : ''}</span>
      <span class="pkg-ver mono">v${esc(item.version || '?')}</span>
    </span>
    <span class="pkg-chevron">›</span>
  </button>`;
}

function packageDetailShell(title, subtitle, body, actions) {
  return `<div class="detail-head">
      <div class="detail-icon">${svg('cube')}</div>
      <div class="detail-title"><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>
    </div>
    <div class="detail-scroll">${body}<div class="detail-actions">${actions}</div></div>`;
}

function renderPackagesList() {
  const list = document.getElementById('packages-list');
  if (list) list.innerHTML = packageRowsHtml();
}

function renderPackages() {
  const root = document.getElementById('packages-root');
  if (root) root.innerHTML = packagesShell();
  loadPackagesDetail();
}

async function fetchPyDetail(name, label) {
  const key = `py:${label}:${name}`;
  if (packagesState.details.has(key)) return packagesState.details.get(key);
  const d = await fetch(`/api/packages/python/detail?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label || '')}`, { cache: 'no-store' }).then((r) => r.json());
  if (d.error) throw new Error(d.error);
  packagesState.details.set(key, d);
  return d;
}

async function fetchNpmDetail(name) {
  const key = `npm:${name}`;
  if (packagesState.details.has(key)) return packagesState.details.get(key);
  const d = await fetch(`/api/packages/npm/detail?name=${encodeURIComponent(name)}`, { cache: 'no-store' }).then((r) => r.json());
  if (d.error) throw new Error(d.error);
  packagesState.details.set(key, d);
  return d;
}

async function loadPackagesDetail() {
  const detail = document.getElementById('packages-detail');
  if (!detail) return;
  const item = packagesVisible().find((entry) => entry.name === packagesState.selected);
  if (!item) {
    detail.innerHTML = '<div class="empty-note">Select a package to see its details.</div>';
    return;
  }
  detail.innerHTML = skeletonRows(5);
  try {
    if (packagesState.source === 'npm') {
      const d = await fetchNpmDetail(item.name);
      detail.innerHTML = packageDetailShell(d.name || item.name, `npm · ${d.version || item.version || ''}`, npmDetailBody(d, item.version), npmDetailActions(d, item.name, item.version));
    } else {
      const label = packagesState.source.split(':')[1];
      const d = await fetchPyDetail(item.name, label);
      detail.innerHTML = packageDetailShell(d.name || item.name, `Python ${d.interpreterLabel || label} · ${d.version || item.version || ''}`, pyDetailBody(d, item.version), pyDetailActions(d, item.name, item.version, label));
    }
  } catch (error) {
    detail.innerHTML = `<div class="empty-note">${esc(error.message)}</div>`;
  }
}

function selectPackage(name) {
  packagesState.selected = name;
  if (window.matchMedia && window.matchMedia(SPLIT_NARROW).matches) {
    if (packagesState.source === 'npm') showNpmDetail(name);
    else showPyDetail(name, undefined, packagesState.source.split(':')[1]);
    return;
  }
  renderPackagesList();
  loadPackagesDetail();
}

function viewPackages(data) {
  const packages = data.packages || {};
  if (packages.error) {
    return emptyState({ icon: 'box', title: 'Language packages', body: `Could not read packages: <span class="mono">${esc(packages.error)}</span>`, action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>` });
  }
  packagesState.data = packages;
  const sources = packageSources();
  if (!sources.length) {
    return emptyState({
      icon: 'box',
      title: 'No language package managers',
      body: 'Python (pip) and Node (npm) global packages show up here, per interpreter. Install one and rescan.',
      command: 'brew install python node',
      docs: 'https://nodejs.org',
      steps: ['Install Python and/or Node', 'Install global packages as usual', 'Rescan, they appear here with update status'],
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }
  if (!sources.some((s) => s.id === packagesState.source) && sources.length) packagesState.source = sources[0].id;
  ensurePackageSelection();

  const cacheRows = [
    packages.caches?.npm != null ? row({ title: 'npm cache', sub: '~/.npm', size: fmtBytes(packages.caches.npm), actions: actBtn('cache.prune', { target: 'npm' }, 'Prune…', 'danger'), search: 'npm cache' }) : '',
    packages.caches?.pip != null ? row({ title: 'pip cache', sub: '~/Library/Caches/pip', size: fmtBytes(packages.caches.pip), actions: actBtn('cache.prune', { target: 'pip' }, 'Prune…', 'danger'), search: 'pip cache' }) : '',
  ].filter(Boolean).join('');

  return [
    `<div id="packages-root">${packagesShell()}</div>`,
    cacheRows ? group('Caches', null, card(`<div class="rows">${cacheRows}</div>`)) : '',
  ].join('');
}

// --- maintenance -----------------------------------------------------------

function viewMaintenance() {
  return `<div id="maintenance-root">${skeletonRows(4)}</div>`;
}

function maintenanceBody(m, ruleData, scheduleData) {
  const caff = m.caffeinate || {};
  const power = group(
    'Power',
    caff.on ? 'keeping awake' : 'normal sleep',
    card(
      `<div class="rows">${row({
        icon: `<span class="row-ico-svg">${svg('bolt')}</span>`,
        title: 'Keep this Mac awake',
        sub: 'Prevents idle, display, disk and system sleep while long jobs run (caffeinate).',
        badge: caff.on ? pill('on', 'good') : pill('off'),
        actions: state.session.readOnly ? '' : `<button class="btn small ${caff.on ? '' : 'primary'}" data-act="maintenance.caffeinate" data-params='${esc(JSON.stringify({ on: !caff.on }))}'>${caff.on ? 'Turn off' : 'Turn on'}</button>`,
        search: 'keep awake caffeinate power sleep',
      })}</div>`,
    ),
  );

  const profile = m.ollama?.profile;
  const presets = `<div class="segmented">${(m.profiles || []).map((p) => `<button class="seg${profile === p ? ' active' : ''}" data-ollama-profile="${esc(p)}">${esc(p)}</button>`).join('')}</div>`;
  const env = m.ollama?.env || {};
  const envList = Object.entries(env).filter(([, v]) => v).map(([k, v]) => `<span class="chip">${esc(k.replace('OLLAMA_', ''))} <span class="faint">${esc(v)}</span></span>`).join('') || '<span class="faint">Using Ollama defaults</span>';
  const ollama = group('Ollama tuning', profile ? `${profile} profile` : 'defaults', card(`<div class="pad"><div class="row-title">Preset</div><div style="margin:10px 0 12px">${presets}</div><div class="chips">${envList}</div></div>`));

  const loginRows = (m.loginItems || [])
    .map((item) =>
      row({
        icon: `<span class="row-ico-svg">${svg('gears')}</span>`,
        title: esc(item.name),
        sub: esc(item.file),
        badge: item.loaded ? pill('loaded', 'good') : pill('not loaded'),
        actions: state.session.readOnly ? '' : `<label class="switch"><input type="checkbox" data-login-item="${esc(item.label)}" ${item.loaded ? 'checked' : ''}><span class="switch-track"></span></label>`,
        search: item.name,
      }),
    )
    .join('');
  const loginGroup = group('Login items', `${(m.loginItems || []).length}`, card(`<div class="rows">${loginRows || '<div class="empty-note">No LaunchAgents</div>'}</div>`));

  const lastBackup = (m.backup?.last || '').split('/').filter(Boolean).pop() || null;
  const backups = group(
    'Backups',
    lastBackup || 'none found',
    card(
      `<div class="rows">${row({
        icon: `<span class="row-ico-svg">${svg('history')}</span>`,
        title: 'Time Machine',
        sub: lastBackup ? `Latest snapshot ${esc(lastBackup)}` : 'No backups found, set up Time Machine to protect this Mac',
        actions: state.session.readOnly ? '' : `<button class="btn small" data-act="maintenance.backupNow" data-params='{}'>Back up now</button>`,
        search: 'time machine backup',
      })}</div>`,
    ),
  );

  const rulesData = ruleData || { rules: [], metrics: {} };
  const metricLabel = (metric) => (rulesData.metrics && rulesData.metrics[metric] ? rulesData.metrics[metric].label : metric);
  const metricUnit = (metric) => (rulesData.metrics && rulesData.metrics[metric] ? rulesData.metrics[metric].unit : '');
  const ruleRows = (rulesData.rules || [])
    .map((rule) =>
      row({
        icon: `<span class="row-ico-svg">${svg('bell')}</span>`,
        title: `${esc(metricLabel(rule.metric))} ${esc(rule.op)} ${esc(String(rule.threshold))}${esc(metricUnit(rule.metric))}`,
        sub: `Cooldown ${esc(String(rule.cooldownMinutes))} min${rule.action ? ` · runs ${esc(rule.action)}` : ''}`,
        badge: rule.enabled ? pill('on', 'good') : pill('off'),
        actions: state.session.readOnly ? '' : `<button class="btn small icon" data-rule-toggle="${esc(rule.id)}" data-enabled="${rule.enabled ? '0' : '1'}" title="Toggle">${svg(rule.enabled ? 'stop' : 'play')}</button><button class="btn small icon ghost-danger" data-rule-delete="${esc(rule.id)}" title="Delete">${svg('trash')}</button>`,
        search: `${rule.metric} ${rule.threshold}`,
      }),
    )
    .join('');
  const rulesGroup = group(
    'Alert rules',
    `${(rulesData.rules || []).length}`,
    card(`<div class="rows">${ruleRows || '<div class="empty-note">No rules yet, add the common ones or create your own.</div>'}</div>${state.session.readOnly ? '' : '<div class="toolbar-row" style="padding:0 16px 14px;margin:0"><button class="btn small" data-seed-rules>Add common rules</button><button class="btn small" data-add-rule>Add rule…</button></div>'}`),
  );

  const cadenceText = (c) => (!c ? '' : c.type === 'interval' ? `every ${c.minutes} min` : c.type === 'weekly' ? `weekly · day ${c.weekday} at ${c.time}` : `daily at ${c.time}`);
  const taskRows = (scheduleData.tasks || [])
    .map((task) =>
      row({
        icon: `<span class="row-ico-svg">${svg(task.kind === 'digest' ? 'bell' : 'clock')}</span>`,
        title: esc(task.label || (task.kind === 'digest' ? 'Digest' : task.action)),
        sub: `${esc(cadenceText(task.cadence))}${task.lastRun ? ` · last ${esc(new Date(task.lastRun).toLocaleString())}` : ''}`,
        badge: task.enabled ? pill('on', 'good') : pill('off'),
        actions: state.session.readOnly ? '' : `<button class="btn small icon" data-task-toggle="${esc(task.id)}" data-enabled="${task.enabled ? '0' : '1'}" title="Toggle">${svg(task.enabled ? 'stop' : 'play')}</button><button class="btn small icon ghost-danger" data-task-delete="${esc(task.id)}" title="Delete">${svg('trash')}</button>`,
        search: `${task.action} ${task.kind}`,
      }),
    )
    .join('');
  const schedulePresets = state.session.readOnly
    ? ''
    : `<div class="toolbar-row" style="padding:0 16px 14px;margin:0"><button class="btn small" data-schedule-preset="cleanup">Weekly clean-up</button><button class="btn small" data-schedule-preset="digest">Daily digest</button><button class="btn small" data-schedule-preset="backup">Nightly backup</button></div>`;
  const scheduleGroup = group('Scheduled actions', `${(scheduleData.tasks || []).length}`, card(`<div class="rows">${taskRows || '<div class="empty-note">Nothing scheduled.</div>'}</div>${schedulePresets}`));

  const nativeBuilt = m.native?.built;
  const nativeGroup = group(
    'Native app',
    nativeBuilt ? 'built' : 'not built',
    card(
      `<div class="rows">${row({
        icon: `<span class="row-ico-svg">${svg('app')}</span>`,
        title: 'Vantage.app',
        sub: 'A real Mac window with a menu-bar extra and native notifications, save dialogs, clipboard and wake lock.',
        badge: nativeBuilt ? pill('built', 'good') : pill('build on first open'),
        actions: state.session.readOnly ? '' : `<button class="btn small" data-act="native.launch" data-params='{}'>${svg('play')} Open app</button>`,
        search: 'native app window menu bar',
      })}</div>`,
    ),
  );

  return power + ollama + nativeGroup + loginGroup + backups + rulesGroup + scheduleGroup;
}

const RULE_METRIC_HINT = {
  diskFreePct: 'Alert when free disk space drops below the threshold.',
  cpu: 'Alert when CPU usage rises above the threshold.',
  memUsedPct: 'Alert when memory usage rises above the threshold.',
  swapUsedPct: 'Alert when swap usage rises above the threshold.',
  ollamaModels: 'Alert when the number of loaded Ollama models passes the threshold.',
};

function ruleSheet(metrics) {
  return new Promise((resolve) => {
    const options = Object.entries(metrics || {})
      .map(([id, meta]) => `<option value="${esc(id)}">${esc(meta.label)}${meta.unit ? ` (${esc(meta.unit)})` : ''}</option>`)
      .join('');
    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = null;
    }
    els.modalRoot.className = 'modal-root open';
    els.modalRoot.innerHTML = `
      <div class="overlay">
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="sheet-body">
            <div class="sheet-icon">${svg('bell')}</div>
            <h2>New alert rule</h2>
            <p>Get notified when a metric crosses a threshold.</p>
            <div class="field"><label class="faint">Metric</label><select data-rule-metric>${options}</select></div>
            <div class="field row2"><label class="faint">When it is</label><select data-rule-op><option value="<">below</option><option value=">">above</option></select><input type="number" data-rule-threshold value="10" /></div>
            <div class="field"><label class="faint">Cooldown (minutes)</label><input type="number" data-rule-cooldown value="60" /></div>
          </div>
          <div class="sheet-actions">
            <button class="btn" data-sheet-cancel>Cancel</button>
            <button class="btn primary" data-sheet-confirm>Add rule</button>
          </div>
        </div>
      </div>`;
    document.addEventListener('keydown', onSheetKey);
    els.modalRoot.querySelector('[data-sheet-cancel]').addEventListener('click', () => { closeSheet(); resolve(null); });
    els.modalRoot.querySelector('.overlay').addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) { closeSheet(); resolve(null); } });
    els.modalRoot.querySelector('[data-sheet-confirm]').addEventListener('click', () => {
      const rule = {
        metric: els.modalRoot.querySelector('[data-rule-metric]').value,
        op: els.modalRoot.querySelector('[data-rule-op]').value,
        threshold: Number(els.modalRoot.querySelector('[data-rule-threshold]').value),
        cooldownMinutes: Number(els.modalRoot.querySelector('[data-rule-cooldown]').value),
      };
      closeSheet();
      resolve(rule);
    });
    activateTrap(els.modalRoot.querySelector('.sheet'));
    syncScrollLock();
  });
}

async function addRule() {
  let meta = {};
  try {
    meta = (await fetch('/api/rules', { cache: 'no-store' }).then((r) => r.json())).metrics || {};
  } catch {
    /* use empty */
  }
  const rule = await ruleSheet(meta);
  if (!rule) return;
  try {
    await api('/api/rules', { method: 'POST', body: rule });
    toast('Rule added', 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadMaintenance();
}

async function schedulePreset(kind) {
  const presets = {
    cleanup: { kind: 'action', action: 'system.cleanAll', label: 'Weekly clean-up', cadence: { type: 'weekly', weekday: 0, time: '03:00' } },
    digest: { kind: 'digest', label: 'Daily digest', cadence: { type: 'daily', time: '09:00' } },
    backup: { kind: 'action', action: 'maintenance.backupNow', label: 'Nightly backup', cadence: { type: 'daily', time: '02:00' } },
  };
  const preset = presets[kind];
  if (!preset) return;
  try {
    await api('/api/schedule', { method: 'POST', body: preset });
    toast('Scheduled', 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadMaintenance();
}

async function loadMaintenance() {
  const host = document.getElementById('maintenance-root');
  if (!host) return;
  try {
    const [m, r, s] = await Promise.all([
      fetch('/api/maintenance', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/rules', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ rules: [], metrics: {} })),
      fetch('/api/schedule', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ tasks: [] })),
    ]);
    host.innerHTML = maintenanceBody(m, r, s);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Maintenance unavailable: ${esc(error.message)}</div>`;
  }
}

const MONITOR_RANGES = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '7d', minutes: 10080 },
];
let monitorRange = 60;
let monitorTimer = null;
let procTimer = null;

function viewMonitor() {
  return `<div id="monitor-root">${skeletonRows(4)}</div>`;
}

function areaChart(values, opts = {}) {
  const series = (values || []).map((v) => (Number.isFinite(v) ? v : 0));
  const w = opts.width || 600;
  const h = opts.height || 130;
  const pad = 6;
  if (series.length < 2) return '<div class="chart-empty">Not enough data yet</div>';
  const max = opts.max || Math.max(1, ...series);
  const min = opts.min || 0;
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (series.length - 1);
  const yOf = (v) => h - pad - ((v - min) / range) * (h - pad * 2);
  const pts = series.map((v, i) => [pad + i * stepX, yOf(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${(pad + (series.length - 1) * stepX).toFixed(1)} ${h - pad} L ${pad} ${h - pad} Z`;
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const color = opts.color || 'var(--accent)';
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function fmtUptime(sec) {
  if (sec == null) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function chartCard(label, values, opts = {}) {
  const series = (values || []).filter((v) => Number.isFinite(v));
  const format = opts.format || ((v) => String(v));
  const stat = series.length
    ? `<span class="chart-stat">${esc(format(series[series.length - 1]))} now · ${esc(format(Math.min(...series)))}–${esc(format(Math.max(...series)))}</span>`
    : '';
  return card(`<div class="pad"><div class="chart-label"><span>${esc(label)}</span>${stat}</div>${areaChart(values, opts)}</div>`);
}

function classifyProcess(p) {
  const cmd = String(p.command || p.name || '');
  const lower = cmd.toLowerCase();
  const base = baseName(p.name || cmd);
  const rules = [
    [/llama-server/, 'Ollama model server', 'Serves a model Ollama has loaded, its weights live in unified (wired) memory.', 'Local LLM inference stops; Ollama restarts it on the next request.'],
    [/comfy|(^|\/)main\.py/, 'ComfyUI', 'Image-generation server (PyTorch + Metal, large MPS allocations).', 'Image generation stops until the comfyui service restarts.'],
    [/icloud_bridge/, 'OpenClaw iCloud bridge', 'OpenClaw iCloud automation helper.', 'iCloud automations stop.'],
    [/miniapp/, 'OpenClaw miniapp', 'The mobile/web front-end for your agent.', 'The miniapp goes offline.'],
    [/openclaw/, 'OpenClaw gateway', 'Your agent runtime and message router.', 'Your agent stops responding.'],
    [/\bollama\b/, 'Ollama', 'The local LLM runtime.', 'Local LLM inference stops until Ollama restarts.'],
    [/opencode/, 'opencode', 'The OpenCode CLI/agent process.', 'OpenCode sessions stop.'],
    [/windowserver/, 'macOS WindowServer', 'macOS graphics compositor.', 'Protected by the system, it cannot be quit.'],
    [/zen|firefox/, 'Zen browser', 'Web browser.', 'Closes the browser and its tabs.'],
    [/telegram/, 'Telegram', 'Desktop messaging client.', 'Closes Telegram.'],
    [/sunshine/, 'Sunshine', 'Game-streaming host.', 'Remote streaming stops.'],
  ];
  for (const [re, label, why, affects] of rules) if (re.test(lower)) return { label, why, affects };
  if (base === 'python' || /^python[\d.]*$/.test(base)) {
    return { label: 'Python', why: 'A Python process, on this machine usually a local AI tool or script.', affects: 'Depends on the script it is running.' };
  }
  return { label: base, why: '', affects: '' };
}

function procAppPath(p) {
  const match = String(p.command || p.name || '').match(/(\/[^\s]*?\.app)\//);
  return match ? match[1] : null;
}

function procIcon(p, classification) {
  const appPath = procAppPath(p);
  if (appPath) return `<img class="app-icon" loading="lazy" decoding="async" width="22" height="22" alt="" src="${esc(appIconUrl(appPath, 64))}" />`;
  const cmd = String(p.command || p.name || '').toLowerCase();
  const label = ((classification && classification.label) || '').toLowerCase();
  const glyph = (name) => `<span class="row-ico-svg">${svg(name)}</span>`;
  const has = (re) => re.test(cmd) || re.test(label);
  if (has(/ollama|llama-server|mlx/)) return glyph('brain');
  if (has(/comfy|main\.py|torch/)) return glyph('photo');
  if (has(/openclaw|miniapp|icloud_bridge/)) return glyph('bot');
  if (has(/opencode/)) return glyph('terminal');
  if (has(/zen|firefox|chrome|safari|browser/)) return glyph('globe');
  if (has(/windowserver|finder|dock/)) return glyph('app');
  if (has(/node|deno|bun|npm/)) return glyph('terminal');
  if (has(/python/)) return glyph('bot');
  if (has(/telegram|slack|discord/)) return glyph('app');
  if (has(/ssh|sshd/)) return glyph('key');
  return glyph('cpu');
}

function managedServices(data) {
  const map = new Map();
  for (const service of data?.services?.services || []) if (service.pid) map.set(service.pid, service);
  return map;
}

function serviceGlyph(name) {
  const n = String(name || '').toLowerCase();
  if (/ollama/.test(n)) return 'brain';
  if (/comfy/.test(n)) return 'photo';
  if (/openclaw|gateway|miniapp/.test(n)) return 'bot';
  if (/dashboard/.test(n)) return 'overview';
  if (/ssh/.test(n)) return 'key';
  if (/screen|vnc/.test(n)) return 'eye';
  if (/smb|afp|file/.test(n)) return 'database';
  if (/cups|print/.test(n)) return 'app';
  return 'network';
}

function dirGlyph(name) {
  const n = String(name || '').toLowerCase();
  if (/ollama|models?/.test(n)) return 'brain';
  if (/comfy|checkpoint|image/.test(n)) return 'photo';
  if (/cache/.test(n)) return 'database';
  if (/download/.test(n)) return 'download';
  if (/trash/.test(n)) return 'trash';
  if (/library|application support|developer/.test(n)) return 'layers';
  if (/site-packages|node_modules|\.npm|\.cache|\.local|\.config|cellar|homebrew|opt\b|bin\b/.test(n)) return 'terminal';
  return 'folder';
}

// Native macOS art: real Finder folder icons and document-type icons, served by
// the server so the app matches the rest of the OS.
const FOLDER_NAME_ICON = { desktop: 'desktop', documents: 'documents', downloads: 'downloads', movies: 'movies', music: 'music', pictures: 'pictures' };

function folderIconId(name) {
  return FOLDER_NAME_ICON[String(name || '').toLowerCase()] || 'default';
}

function folderIconImg(name) {
  return `<img class="file-ico" data-fallback="${esc(dirGlyph(name))}" loading="lazy" decoding="async" alt="" src="/api/folder/icon?id=${esc(folderIconId(name))}&size=64" />`;
}

function fileIconImg(name) {
  return `<img class="file-ico" data-fallback="file" loading="lazy" decoding="async" alt="" src="/api/file/icon?name=${encodeURIComponent(String(name || ''))}&size=48" />`;
}

function reclaimGlyph(item) {
  const id = String((item && (item.id || item.label)) || '').toLowerCase();
  if (/ollama|orphan|model/.test(id)) return 'brain';
  if (/trash/.test(id)) return 'trash';
  if (/cache|pip|npm/.test(id)) return 'database';
  if (/download|partial/.test(id)) return 'download';
  if (/comfy|output|image/.test(id)) return 'photo';
  return 'layers';
}

function pipelineGlyph(pipeline) {
  const p = String(pipeline || '').toLowerCase();
  if (p.includes('video')) return 'play';
  if (p.includes('speech') || p.includes('audio') || p.includes('voice')) return 'pulse';
  if (p.includes('feature-extraction') || p.includes('sentence') || p.includes('embedding') || p.includes('classification')) return 'layers';
  if (p.includes('image') || p.includes('vision') || p.includes('detection') || p.includes('segmentation') || p.includes('depth')) return 'photo';
  if (p.includes('fill-mask') || p.includes('token')) return 'terminal';
  return 'brain';
}

function showProcessDetail(p) {
  const classification = classifyProcess(p);
  const service = managedServices(state.data).get(p.pid);
  const body = `<dl class="kv">
    <dt>Process</dt><dd>${esc(classification.label)}</dd>
    <dt>PID / PPID</dt><dd>${p.pid} / ${p.ppid ?? '–'}</dd>
    <dt>Memory</dt><dd>${fmtBytes(p.rss)}</dd>
    <dt>CPU</dt><dd>${p.cpu != null ? `${p.cpu.toFixed(1)}%` : '–'}</dd>
    ${service ? `<dt>Managed by</dt><dd class="mono">${esc(service.label)}${service.friendly ? ` (${esc(service.friendly)})` : ''}</dd>` : ''}
    <dt>Why it uses memory</dt><dd>${esc(classification.why || 'Unknown')}</dd>
    <dt>If you quit it</dt><dd>${esc(classification.affects || 'Unknown')}${service ? ' It is managed by launchd, so it will restart automatically.' : ''}</dd>
  </dl>
  <div class="pad"><div class="faint mono" style="font-size:11px;white-space:pre-wrap">${esc(p.command || '')}</div></div>`;
  const actions = state.session.readOnly
    ? ''
    : `<button class="btn small danger" data-act="process.kill" data-params='${esc(JSON.stringify({ pid: p.pid, name: p.name, label: classification.label }))}'${service ? ` data-impact="Managed by launchd (${esc(service.friendly || service.label)}), so it will restart automatically."` : ''}>Quit…</button><button class="btn small" data-copy="${esc(p.command || '')}">Copy command</button>`;
  openPanel({ title: classification.label, subtitle: `pid ${p.pid}`, body, actions });
}

function procRowsHtml(procs, managed) {
  return (procs || [])
    .map((p) => {
      const classification = classifyProcess(p);
      const service = managed.get(p.pid);
      const sub = [service ? `launchd: ${service.friendly || service.label}` : null, classification.why, classification.affects ? `Quitting → ${classification.affects}` : null].filter(Boolean).join(' · ');
      return row({
        title: `${esc(classification.label)}<span class="faint mono" style="margin-left:8px">${p.pid}</span>`,
        sub: esc(sub),
        size: `${fmtBytes(p.rss)}${p.cpu != null ? `<div class="model-when faint">${p.cpu.toFixed(1)}% CPU</div>` : ''}`,
        actions: `<button class="btn small icon" data-proc='${esc(JSON.stringify(p))}' title="Details">${svg('shield')}</button>${actBtn('process.kill', { pid: p.pid, name: p.name, label: classification.label }, 'Quit…', 'danger', service ? { impact: `Managed by launchd (${service.friendly || service.label}), so it will restart automatically.` } : {})}`,
        search: p.command || p.name,
        icon: procIcon(p, classification),
      });
    })
    .join('');
}

function monitorBody(sample, samples) {
  if (!sample) return '<div class="empty-note">Collecting the first sample…</div>';

  const managed = managedServices(state.data);
  const total = sample.mem.total || 1;
  const usedPct = (sample.mem.used / total) * 100;
  const disk = sample.disk || {};
  const cpu = sample.cpu == null ? '–' : `${sample.cpu.toFixed(0)}%`;

  const cpuTone = sample.cpu == null ? '' : sample.cpu > 85 ? 'bad' : sample.cpu > 60 ? 'warn' : '';
  const memTone = usedPct > 90 ? 'bad' : usedPct > 75 ? 'warn' : '';
  const cpuSeries = samples.map((s) => s.cpu || 0);
  const memUsedSeries = samples.map((s) => s.memUsed || 0);
  const memAvailSeries = samples.map((s) => s.memAvailable || 0);
  const diskFreeSeries = samples.map((s) => s.diskFree || 0);
  const ollamaSeries = samples.map((s) => s.ollamaBytes || 0);

  const tiles = [
    { label: 'CPU', value: cpu, hint: `load avg ${(sample.load1 || 0).toFixed(2)}`, icon: 'cpu', tone: cpuTone, spark: cpuSeries, sparkColor: '#5e6ad2' },
    { label: 'Memory used', value: fmtBytes(sample.mem.used), hint: `${usedPct.toFixed(0)}% of ${fmtBytes(total)}`, icon: 'memory', tone: memTone, viz: statMeter(usedPct, usedPct > 90 ? 'var(--red)' : usedPct > 75 ? 'var(--orange)' : '#4cc2c4') },
    { label: 'Memory available', value: fmtBytes(sample.mem.available), hint: 'free + cached', icon: 'layers', spark: memAvailSeries, sparkColor: '#4cb782' },
    { label: 'Swap used', value: fmtBytes(sample.swap.used), hint: sample.swap.total ? `of ${fmtBytes(sample.swap.total)}` : 'not in use', icon: 'swap', viz: sample.swap.total ? statMeter((sample.swap.used / sample.swap.total) * 100, 'var(--orange)') : '' },
    { label: 'Disk free', value: fmtBytes(disk.free), hint: `${fmtBytes(disk.used)} used`, icon: 'disk', spark: diskFreeSeries, sparkColor: '#f2a34a' },
    { label: 'Ollama in memory', value: fmtBytes(sample.ollama.bytes), hint: `${sample.ollama.models} model${sample.ollama.models === 1 ? '' : 's'}`, icon: 'brain', spark: ollamaSeries, sparkColor: '#0a84ff' },
  ]
    .map(statTile)
    .join('');

  const segments = [
    { label: 'Wired', bytes: sample.mem.wired, color: '#f2a34a' },
    { label: 'Active', bytes: sample.mem.active, color: '#5e6ad2' },
    { label: 'Compressed', bytes: sample.mem.compressed, color: '#cf6bd6' },
    { label: 'Available', bytes: sample.mem.available, color: '#3a3d45' },
  ];
  const segTotal = segments.reduce((sum, s) => sum + (s.bytes || 0), 0) || 1;
  const stacked = segments.map((s) => `<span style="width:${((s.bytes || 0) / segTotal) * 100}%;background:${s.color}"></span>`).join('');
  const legend = segments.map((s) => `<span class="item"><span class="dot" style="background:${s.color}"></span>${esc(s.label)} · ${fmtBytes(s.bytes)}</span>`).join('');
  const pressure = sample.pressure == null ? '' : ` · pressure ${sample.pressure}% free`;

  const rangeBar = `<div class="segmented">${MONITOR_RANGES.map((r) => `<button class="seg${r.minutes === monitorRange ? ' active' : ''}" data-range="${r.minutes}">${r.label}</button>`).join('')}</div>`;

  const freeSeries = samples.map((s) => s.diskFree || 0);
  const freeMin = freeSeries.length ? Math.min(...freeSeries) : 0;
  const freeMax = freeSeries.length ? Math.max(...freeSeries) : 1;
  const freePad = Math.max(1e9, (freeMax - freeMin) * 0.25);

  const charts = `<div class="grid two">
    ${chartCard('CPU %', samples.map((s) => s.cpu || 0), { max: 100, color: '#5e6ad2', format: (v) => `${v.toFixed(0)}%` })}
    ${chartCard('Memory used', samples.map((s) => s.memUsed || 0), { max: total, color: '#4cc2c4', format: fmtBytes })}
    ${chartCard('Memory available', samples.map((s) => s.memAvailable || 0), { max: total, color: '#4cb782', format: fmtBytes })}
    ${chartCard('Disk free', freeSeries, { min: freeMin - freePad, max: freeMax + freePad, color: '#f2a34a', format: fmtBytes })}
    ${chartCard('Swap used', samples.map((s) => s.swapUsed || 0), { color: '#cf6bd6', format: fmtBytes })}
    ${chartCard('Ollama in memory', samples.map((s) => s.ollamaBytes || 0), { max: total, color: '#0a84ff', format: fmtBytes })}
  </div>`;

  const procs = procRowsHtml(sample.procs || [], managed);

  const explain = [
    ['Wired', 'Kernel + GPU/model weights, loaded Ollama models live here.'],
    ['Active', 'App memory currently in use.'],
    ['Compressed', 'Memory the system compressed to avoid swapping.'],
    ['Available', 'Cache and free pages, reclaimed on demand.'],
  ];
  const explainList = `<div class="explain">${explain.map(([key, text]) => `<div class="explain-row"><span class="explain-key">${esc(key)}</span><span class="explain-text">${esc(text)}</span></div>`).join('')}</div>`;

  return [
    `<div class="grid stats">${tiles}</div>`,
    group('Unified memory', `${fmtBytes(sample.mem.used)} used of ${fmtBytes(total)}${pressure} · up ${fmtUptime(sample.uptimeSeconds)}`, card(`<div class="pad"><div class="stacked">${stacked}</div><div class="legend">${legend}</div>${explainList}</div>`)),
    `<div class="group"><div class="group-head"><div class="group-title">Trends</div>${rangeBar}</div>${charts}</div>`,
    group('Top processes', 'what is using memory and why', card(`<div class="rows" id="proc-rows">${procs || '<div class="empty-note">No processes above the threshold</div>'}</div>`)),
  ].join('');
}

async function loadOverviewExtras() {
  const extras = document.getElementById('overview-extras');
  const trend = document.getElementById('disk-trend');
  const [overviewData, series] = await Promise.all([
    fetch('/api/overview', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    fetch('/api/metrics/series?minutes=10080', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
  ]);
  if (extras) extras.innerHTML = overviewExtrasBody(overviewData);
  if (trend) trend.innerHTML = diskTrendBody(series);
}

function healthGroup(health) {
  if (!health) return '';
  const tone = health.band === 'good' ? 'good' : health.band === 'fair' ? 'warn' : 'bad';
  const label = health.band === 'good' ? 'Healthy' : health.band === 'fair' ? 'Needs a look' : 'Needs attention';
  const checks = health.checks || [];
  const badge = `<span class="health-score ${tone}">${health.score}</span>`;
  const checkRows = checks.length
    ? checks
        .map((check) =>
          row({
            icon: `<span class="row-ico-svg">${svg('warning')}</span>`,
            title: esc(check.label),
            sub: esc(check.detail || ''),
            badge: pill('to do', 'warn'),
            actions: check.view ? `<button class="btn small" data-goto="${esc(check.view)}">Open</button>` : '',
            search: `${check.label} ${check.detail || ''}`,
          }),
        )
        .join('')
    : row({ icon: `<span class="row-ico-svg">${svg('check')}</span>`, title: 'Setup complete', sub: 'Full Disk Access, notifications and firewall are in order', search: 'setup complete' });
  const healthCard = card(
    `<div class="pad health-card">${badge}<div class="health-meta"><div class="health-band">${esc(label)}</div><div class="health-sub">security · storage · packages · setup</div></div></div>`,
  );
  return group('Health', `${health.score}/100`, healthCard) + group('Setup checklist', checks.length ? `${checks.length} to review` : 'complete', card(`<div class="rows">${checkRows}</div>`));
}

function overviewExtrasBody(overviewData) {
  if (!overviewData) return '';
  const recs = overviewData.recommendations || [];

  const recRows = recs
    .map((rec) =>
      row({
        icon: `<span class="row-ico-svg">${svg(rec.severity === 'warn' ? 'warning' : 'bolt')}</span>`,
        title: esc(rec.title),
        sub: esc(rec.detail || ''),
        badge: rec.severity === 'warn' ? pill('action', 'warn') : pill('tip'),
        actions: `<button class="btn small" data-goto="${esc(rec.view)}">Open</button>`,
        search: rec.title,
      }),
    )
    .join('');

  const attention = group(
    'Attention',
    recs.length ? `${recs.length} suggestion${recs.length === 1 ? '' : 's'}` : 'all clear',
    card(`<div class="rows">${recRows || row({ icon: `<span class="row-ico-svg">${svg('check')}</span>`, title: 'Nothing needs attention', sub: 'Models are in use, disk is healthy and packages are current', search: 'all clear' })}</div>`),
  );

  return healthGroup(overviewData.health) + attention;
}

// --- AI news ---------------------------------------------------------------

function aiNewsBody(trending) {
  const list = trending || [];
  if (!list.length) {
    return emptyState({
      icon: 'sparkle',
      title: 'Nothing trending yet',
      body: 'This page lists what’s hot on Hugging Face right now, new models, fine-tunes and quantisations, refreshed live.',
      action: `<button class="btn small" data-scan>${svg('restart')} Rescan</button>`,
    });
  }
  const rows = list
    .map((item) =>
      row({
        icon: `<span class="row-ico-svg">${svg(pipelineGlyph(item.pipeline))}</span>`,
        title: esc(item.id),
        sub: `${fmtNum(item.downloads || 0)} downloads · ${fmtNum(item.likes || 0)} likes`,
        badge: item.pipeline ? pill(item.pipeline) : '',
        actions: `<a class="btn small" href="https://huggingface.co/${esc(item.id)}" target="_blank" rel="noopener">View</a>`,
        search: item.id,
        clickable: true,
        attrs: `data-hf="${esc(item.id)}" data-hf-downloads="${item.downloads || 0}" data-hf-likes="${item.likes || 0}" data-hf-pipeline="${esc(item.pipeline || '')}"`,
      }),
    )
    .join('');
  return group('Trending on Hugging Face', 'live', card(`<div class="rows">${rows}</div>`));
}

function viewAINews() {
  return `<div id="ai-news-root">${skeletonRows(6)}</div>`;
}

async function loadAINews() {
  const host = document.getElementById('ai-news-root');
  if (!host) return;
  try {
    const data = await fetch('/api/overview', { cache: 'no-store' }).then((r) => r.json());
    host.innerHTML = aiNewsBody(data.trending || []);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Could not load AI news: ${esc(error.message)}</div>`;
  }
}

function diskTrendBody(series) {
  const samples = series && series.samples;
  if (!samples || samples.length < 3) {
    return '<span class="faint" style="font-size:11px">Collecting trend data, check back in a few minutes.</span>';
  }
  const free = samples.map((s) => s.diskFree || 0);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanDays = Math.max((last.ts - first.ts) / 86400000, 1 / 24);
  const growth = ((last.diskUsed || 0) - (first.diskUsed || 0)) / spanDays;
  let projection;
  if (growth > 50 * 1024 * 1024) {
    const daysLeft = last.diskFree ? last.diskFree / growth : null;
    projection = `<span class="warn">Growing ~${fmtBytes(growth)}/day</span> · full in ${daysLeft == null ? '–' : daysLeft > 730 ? 'over 2 years' : `~${Math.round(daysLeft)} days`}`;
  } else if (growth < -50 * 1024 * 1024) {
    projection = `<span class="good">Freeing ~${fmtBytes(-growth)}/day</span>`;
  } else {
    projection = '<span class="muted">Free space is stable</span>';
  }
  return `<div class="spark">${areaChart(free, { height: 56, color: '#4cc2c4' })}</div><div class="disk-projection">${projection}</div>`;
}

async function refreshProcRows() {
  if (state.view !== 'monitor') return;
  const host = document.getElementById('proc-rows');
  if (!host) return;
  try {
    const data = await fetch('/api/processes', { cache: 'no-store' }).then((r) => r.json());
    host.innerHTML = procRowsHtml(data.procs || [], managedServices(state.data)) || '<div class="empty-note">No processes above the threshold</div>';
  } catch {
    /* keep the last list */
  }
}

async function loadMonitor() {
  if (state.idle) return;
  if (state.view !== 'monitor') {
    stopMonitorPolling();
    return;
  }
  const host = document.getElementById('monitor-root');
  if (!host) return;
  try {
    const [live, series] = await Promise.all([
      fetch('/api/metrics/live?fresh=1', { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/metrics/series?minutes=${monitorRange}`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    host.innerHTML = monitorBody(live.sample, series.samples || []);
    refreshProcRows();
  } catch {
    host.innerHTML = '<div class="empty-note">Metrics unavailable</div>';
  }
}

function startMonitorPolling() {
  stopMonitorPolling();
  loadMonitor();
  monitorTimer = setInterval(loadMonitor, 3000);
  procTimer = setInterval(refreshProcRows, 2000);
}

function stopMonitorPolling() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (procTimer) {
    clearInterval(procTimer);
    procTimer = null;
  }
}

// --- disk map + reclaim ----------------------------------------------------

let diskReport = null;
let diskPath = null;

const TM_COLORS = ['#3b4371', '#2f5d62', '#6b3f52', '#4f5530', '#3f4a6b', '#2f5a4a', '#54406b', '#5a4a30'];

function tileColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TM_COLORS[hash % TM_COLORS.length];
}

function squarify(items, x0, y0, w0, h0) {
  const out = [];
  const data = items.map((item) => ({ item, value: Math.max(item.value, 1) })).sort((a, b) => b.value - a.value);
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const scale = (w0 * h0) / total;

  let x = x0;
  let y = y0;
  let w = w0;
  let h = h0;
  let i = 0;

  const worst = (row, side) => {
    const sum = row.reduce((s, d) => s + d.value, 0) * scale;
    const max = Math.max(...row.map((d) => d.value * scale));
    const min = Math.min(...row.map((d) => d.value * scale));
    const side2 = side * side;
    return Math.max((side2 * max) / (sum * sum), (sum * sum) / (side2 * min));
  };

  while (i < data.length) {
    const side = Math.min(w, h);
    const row = [data[i]];
    let j = i + 1;
    while (j < data.length) {
      const next = row.concat(data[j]);
      if (worst(next, side) > worst(row, side)) break;
      row.push(data[j]);
      j += 1;
    }
    const rowArea = row.reduce((s, d) => s + d.value, 0) * scale;
    if (w >= h) {
      const rw = rowArea / h;
      let ry = y;
      for (const d of row) {
        const rh = (d.value * scale) / rw;
        out.push({ item: d.item, x, y: ry, w: rw, h: rh });
        ry += rh;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = rowArea / w;
      let rx = x;
      for (const d of row) {
        const rw = (d.value * scale) / rh;
        out.push({ item: d.item, x: rx, y, w: rw, h: rh });
        rx += rw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

function parentPath(p) {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

function reclaimPanel(report) {
  const items = (report.items || [])
    .map((item) => {
      let actions;
      if (item.action === 'ollama.pruneOrphans') actions = actBtn('ollama.pruneOrphans', {}, 'Prune…', 'danger', { impact: `Frees ${fmtBytes(item.bytes)}` });
      else if (item.action === 'trash.empty') actions = actBtn('trash.empty', {}, 'Empty…', 'danger', { impact: `Frees ${fmtBytes(item.bytes)}` });
      else if (item.action === 'cache.prune') actions = actBtn('cache.prune', item.actionParams || {}, 'Clear…', 'danger', { impact: `Frees ${fmtBytes(item.bytes)}` });
      else actions = actBtn('file.reveal', { path: `${report.home}/ComfyUI/output` }, 'Review');
      return row({
        title: `${esc(item.label)}${item.count ? ` <span class="faint">(${item.count})</span>` : ''}`,
        sub: esc(item.detail || ''),
        size: fmtBytes(item.bytes),
        actions,
        search: item.label,
        clickable: true,
        attrs: `data-reclaim="${esc(item.id)}"`,
        icon: `<span class="row-ico-svg">${svg(reclaimGlyph(item))}</span>`,
      });
    })
    .join('');

  const partials = (report.partials || [])
    .slice(0, 10)
    .map((p) =>
      row({
        title: esc(p.name),
        sub: 'incomplete download',
        size: fmtBytes(p.bytes),
        actions: actBtn('download.discard', { path: p.path }, 'Discard…', 'danger'),
        search: p.name,
        clickable: true,
        attrs: 'data-reclaim="partials"',
        icon: `<span class="row-ico-svg">${svg('download')}</span>`,
      }),
    )
    .join('');

  const total = report.totalBytes || 0;
  const snap = report.snapshots || {};
  const snapshotGroup = snap.count
    ? group('APFS local snapshots', `${snap.count} snapshot${snap.count === 1 ? '' : 's'}`, card(`<div class="rows">${row({
        title: `${snap.count} Time Machine local snapshot${snap.count === 1 ? '' : 's'} on /`,
        sub: 'macOS frees these automatically under disk pressure',
        actions: `<span class="faint" style="font-size:11px">managed by macOS</span>`,
        search: 'apfs snapshots time machine',
      })}</div>`))
    : '';

  return [
    group(
      'Reclaimable space',
      total ? `${fmtBytes(total)} can be freed` : 'nothing to reclaim',
      card(`<div class="rows">${items || '<div class="empty-note">Nothing to reclaim</div>'}</div>`),
    ),
    partials ? group('Incomplete downloads', null, card(`<div class="rows">${partials}</div>`)) : '',
    snapshotGroup,
  ].join('');
}

function breadcrumb(current, home) {
  if (!home || !current.startsWith(home)) return `<span class="mono hint">${esc(current)}</span>`;
  const rel = current.slice(home.length).split('/').filter(Boolean);
  const parts = [`<button class="crumb" data-disk-up="${esc(home)}">~</button>`];
  let acc = home;
  for (const segment of rel) {
    acc += `/${segment}`;
    parts.push('<span class="crumb-sep">/</span>');
    parts.push(`<button class="crumb" data-disk-up="${esc(acc)}">${esc(segment)}</button>`);
  }
  return parts.join('');
}

function treemapGroup(tree, home) {
  const W = 1000;
  const H = 340;
  const items = (tree.children || []).filter((c) => (c.bytes || 0) > 0).map((c) => ({ value: c.bytes, ...c }));
  const rects = items.length ? squarify(items, 0, 0, W, H) : [];

  const body = rects
    .map((r) => {
      const show = r.w > 66 && r.h > 26;
      const color = tileColor(r.item.name);
      return `<g class="tm-tile" data-tm-path="${esc(r.item.path)}" data-tm-dir="${r.item.isDirectory ? 1 : 0}">
        <title>${esc(r.item.name)}, ${esc(fmtBytes(r.item.bytes))}</title>
        <rect x="${(r.x + 1).toFixed(1)}" y="${(r.y + 1).toFixed(1)}" width="${Math.max(0, r.w - 2).toFixed(1)}" height="${Math.max(0, r.h - 2).toFixed(1)}" rx="4" fill="${color}"/>
        ${show ? `<text class="tm-name" x="${(r.x + 11).toFixed(1)}" y="${(r.y + 21).toFixed(1)}">${esc(r.item.name)}</text><text class="tm-size" x="${(r.x + 11).toFixed(1)}" y="${(r.y + 37).toFixed(1)}">${esc(fmtBytes(r.item.bytes))}</text>` : ''}
      </g>`;
    })
    .join('');

  const canUp = home && tree.path !== home && tree.path.startsWith(home);
  const up = canUp ? `<button class="btn small" data-disk-up="${esc(parentPath(tree.path))}">Up</button>` : '';

  return `<div class="group">
    <div class="group-head">
      <div class="group-title">Disk map <span class="crumbs">${breadcrumb(tree.path, home)}</span></div>
      ${up}
    </div>
    ${card(`<div class="tm-wrap">${body ? `<svg class="treemap" viewBox="0 0 ${W} ${H}">${body}</svg>` : '<div class="empty-note">No data</div>'}</div>`)}
    <div class="disk-note">Click a folder to drill in · macOS hides some protected folders from unprivileged scans (grant Full Disk Access to <span class="mono">node</span> for complete totals).</div>
  </div>`;
}

async function loadDisk(targetPath) {
  const host = document.getElementById('disk-root');
  if (!host) return;
  host.classList.add('loading');
  try {
    if (!diskReport) diskReport = await fetch('/api/reclaim', { cache: 'no-store' }).then((r) => r.json());
    if (diskReport.error) throw new Error(diskReport.error);
    const start = targetPath || diskPath || diskReport.home;
    const tree = await fetch(`/api/disk/tree?path=${encodeURIComponent(start)}`, { cache: 'no-store' }).then((r) => r.json());
    if (tree.error) throw new Error(tree.error);
    diskPath = tree.path;
    const toolbar = `<div class="toolbar-row">
      <button class="btn small" data-largest="${esc(diskPath)}">${svg('search')} Largest files</button>
      ${state.session.readOnly ? '' : `<button class="btn small ghost-danger" data-act="downloads.clear" data-params='{}'>${svg('trash')} Clear Downloads…</button>`}
    </div>`;
    host.innerHTML = toolbar + reclaimPanel(diskReport) + treemapGroup(tree, diskReport.home);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">${esc(error.message || 'Disk data unavailable')}</div>`;
  } finally {
    host.classList.remove('loading');
  }
}

async function showLargestFiles(target) {
  openPanel({ title: 'Largest files', subtitle: target, body: skeletonRows(5) });
  try {
    const data = await fetch(`/api/disk/largest?path=${encodeURIComponent(target)}&limit=50`, { cache: 'no-store' }).then((r) => r.json());
    if (data.error) throw new Error(data.error);
    const files = data.files || [];
    const rows = files
      .map((file) =>
        row({
          title: esc(file.name),
          sub: esc(file.path.replace(target, '~')),
          icon: `<span class="row-ico">${fileIconImg(file.name)}</span>`,
          size: fmtBytes(file.bytes),
          actions: `${actBtn('file.reveal', { path: file.path }, 'Reveal')}${actBtn('file.trash', { path: file.path }, 'Trash…', 'danger')}`,
          search: file.path,
        }),
      )
      .join('');
    const body = `<div class="pad" style="padding-bottom:0"><span class="faint" style="font-size:11.5px">Scanned ${fmtNum(data.scanned)} files</span></div><div class="rows">${rows || '<div class="empty-note">No files found</div>'}</div>`;
    openPanel({ title: 'Largest files', subtitle: `${fmtBytes(files.reduce((sum, f) => sum + f.bytes, 0))} across ${files.length} files`, body });
  } catch (error) {
    openPanel({ title: 'Largest files', subtitle: 'Error', body: `<div class="empty-note">${esc(error.message)}</div>` });
  }
}

function refreshAfterAction() {
  switch (state.view) {
    case 'overview':
      loadOverviewExtras();
      break;
    case 'storage':
      diskReport = null;
      loadDisk(diskPath);
      break;
    case 'monitor':
      loadMonitor();
      break;
    case 'network':
      loadNetwork();
      break;
    case 'ollama':
      loadModelExtras();
      break;
    case 'comfy':
      loadComfyExtras();
      break;
    case 'brew':
      brewState.data = null;
      loadBrewPackages();
      break;
    case 'store':
      if (storeState.query) storeSearch();
      else loadStore();
      break;
    case 'packages':
      packagesState.details.clear();
      loadPackagesOutdated();
      break;
    case 'maintenance':
      loadMaintenance();
      break;
    case 'apps':
      appsState.details.clear();
      loadAppsDetail();
      break;
    case 'history':
      loadHistory();
      break;
    case 'services':
      loadHealth();
      break;
    case 'security':
      loadSecurity();
      break;
    case 'activity':
      loadAgent();
      break;
    case 'ainews':
      loadAINews();
      break;
    default:
      break;
  }
}

// --- health + logs ---------------------------------------------------------

const logState = { logs: [], path: null, lines: [], follow: false };
let logTimer = null;

function healthPill(status) {
  const map = {
    healthy: ['Healthy', 'good'],
    auth: ['Auth required', 'warn'],
    reachable: ['Reachable', ''],
    error: ['Error', 'bad'],
    down: ['Down', 'bad'],
  };
  const [label, cls] = map[status] || [status, ''];
  return pill(label, cls);
}

function healthPanel(endpoints, services) {
  const endpointRows = endpoints
    .map(
      (ep) => `<tr data-search="${esc((ep.label + ' ' + ep.url).toLowerCase())}">
        <td>${esc(ep.label)}<div class="faint mono">${esc(ep.url)}</div></td>
        <td>${healthPill(ep.status)}</td>
        <td class="num">${ep.latencyMs != null ? `${ep.latencyMs} ms` : '–'}</td>
        <td class="muted">${esc(ep.httpStatus != null ? `HTTP ${ep.httpStatus}` : '')} ${esc(ep.detail || ep.error || '')}</td>
      </tr>`,
    )
    .join('');

  const serviceRows = services
    .map(
      (s) => `<tr data-search="${esc(s.label.toLowerCase())}">
        <td>${esc(s.label)}</td>
        <td>${s.running ? pill('running', 'good') : pill('stopped', 'warn')}</td>
        <td class="num">${s.pid ?? '–'}</td>
        <td class="num">${s.runs ?? '–'}</td>
        <td class="num">${s.lastExit != null && s.lastExit !== '' ? esc(s.lastExit) : '–'}</td>
      </tr>`,
    )
    .join('');

  return [
    `<div class="toolbar-row"><button class="btn small" data-health-refresh>${svg('restart')} Re-check</button></div>`,
    group('Endpoint health', 'live HTTP probes', card(table([{ label: 'Service' }, { label: 'Status' }, { label: 'Latency', num: true }, { label: 'Detail' }], endpointRows, 'No endpoints'))),
    group('Service supervision', 'restart counts & last exit', card(table([{ label: 'Service' }, { label: 'State' }, { label: 'PID', num: true }, { label: 'Runs', num: true }, { label: 'Last exit', num: true }], serviceRows, 'No services'))),
  ].join('');
}

function logsPanel() {
  const sources = logState.logs
    .map((l) => `<button class="log-source${l.path === logState.path ? ' active' : ''}" data-log="${esc(l.path)}">
      <span class="log-name">${esc(l.name)}</span><span class="log-size">${fmtBytes(l.bytes)}</span>
    </button>`)
    .join('');

  return group(
    'Logs',
    `${logState.logs.length} files`,
    card(`<div class="log-view">
      <div class="log-side">${sources || '<div class="empty-note">No logs found</div>'}</div>
      <div class="log-main">
        <div class="log-toolbar">
          <span class="log-path mono faint">${esc(logState.path || 'Select a log')}</span>
          <button class="btn small ${logState.follow ? 'primary' : ''}" data-log-follow>${logState.follow ? 'Following' : 'Follow'}</button>
          <button class="btn small" data-log-refresh>Refresh</button>
        </div>
        <pre class="log-pre" id="log-pre">${esc((logState.lines || []).join('\n'))}</pre>
      </div>
    </div>`),
  );
}

async function jumpToLog(token) {
  if (state.view !== 'services') setView('services');
  if (!logState.logs.length) await loadLogs();
  const needle = String(token || '').toLowerCase();
  const log = logState.logs.find((l) => l.name.toLowerCase().includes(needle));
  if (!log) {
    toast(`No log matching "${token}"`, 'error');
    return;
  }
  logState.path = log.path;
  logState.lines = [];
  await loadLogs();
  const host = document.getElementById('logs-root');
  if (host) host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadHealth() {
  const host = document.getElementById('health-root');
  if (!host) return;
  try {
    const data = await fetch('/api/health/checks', { cache: 'no-store' }).then((r) => r.json());
    host.innerHTML = healthPanel(data.endpoints || [], data.services || []);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Health checks unavailable: ${esc(error.message)}</div>`;
  }
}

async function loadLogs() {
  const host = document.getElementById('logs-root');
  if (!host) return;
  try {
    if (!logState.logs.length) {
      logState.logs = (await fetch('/api/logs', { cache: 'no-store' }).then((r) => r.json())).logs || [];
    }
    if (!logState.path && logState.logs.length) logState.path = logState.logs[0].path;
    if (logState.path) {
      const tail = await fetch(`/api/logs/tail?path=${encodeURIComponent(logState.path)}&lines=300`, { cache: 'no-store' }).then((r) => r.json());
      logState.lines = tail.lines || [];
    }
    host.innerHTML = logsPanel();
  } catch {
    host.innerHTML = '<div class="empty-note">Logs unavailable</div>';
  }
}

async function refreshLogTail() {
  if (state.idle) return;
  if (!logState.path || state.view !== 'services') return;
  try {
    const tail = await fetch(`/api/logs/tail?path=${encodeURIComponent(logState.path)}&lines=300`, { cache: 'no-store' }).then((r) => r.json());
    logState.lines = tail.lines || [];
    const pre = document.getElementById('log-pre');
    if (pre) {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = logState.lines.join('\n');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  } catch {
    /* ignore */
  }
}

function startLogFollow() {
  stopLogFollow();
  logTimer = setInterval(refreshLogTail, 3000);
}

function stopLogFollow() {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

// --- security --------------------------------------------------------------

function viewSecurity() {
  return `<div id="security-root">${skeletonRows(4)}</div>`;
}

function securityBody(report) {
  const issues = report.issues || [];
  const warnCount = issues.filter((i) => i.severity === 'warn').length;
  const postureList = report.posture || [];
  const posturePassed = postureList.filter((p) => p.ok).length;
  const exposedCount = (report.bindings || []).filter((b) => b.exposure !== 'loopback').length;
  const secretCount = (report.secrets && report.secrets.present) ? report.secrets.present.length : 0;
  const securityWidgets = [
    { icon: 'shield', label: 'Findings', value: fmtNum(issues.length), hint: warnCount ? `${warnCount} need attention` : 'all clear', tone: warnCount ? 'warn' : 'good' },
    { icon: 'check', label: 'Posture checks', value: `${posturePassed}/${postureList.length}`, hint: 'macOS hardening', viz: statMeter(postureList.length ? (posturePassed / postureList.length) * 100 : 0, 'var(--green)') },
    { icon: 'network', label: 'Exposed ports', value: fmtNum(exposedCount), hint: exposedCount ? 'reachable off-device' : 'all loopback', tone: exposedCount ? 'warn' : 'good' },
    { icon: 'key', label: 'Secrets set', value: fmtNum(secretCount), hint: `${(report.secrets && report.secrets.missing ? report.secrets.missing.length : 0)} missing` },
  ].map(statTile).join('');
  const issueRows = issues
    .map((issue, i) =>
      row({
        title: esc(issue.title),
        sub: `${esc(issue.detail || '')}${issue.fix ? ` <span class="faint">· ${esc(issue.fix)}</span>` : ''}`,
        badge: pill(issue.severity === 'warn' ? 'attention' : 'info', issue.severity === 'warn' ? 'warn' : ''),
        search: issue.title,
        clickable: true,
        attrs: `data-issue="${i}"`,
        icon: `<span class="row-ico-svg">${svg(issue.severity === 'warn' ? 'warning' : 'check')}</span>`,
      }),
    )
    .join('');

  const bindingRows = (report.bindings || [])
    .map((b) => {
      const exposure = b.exposure === 'loopback' ? pill('loopback', 'good') : b.exposure === 'all' ? pill('all interfaces', 'warn') : pill('LAN', 'warn');
      return `<tr class="clickable" data-binding="${b.port}" data-search="${esc((b.label || b.command).toLowerCase())}">
        <td class="num mono">${b.port}</td>
        <td><span class="td-ico">${svg(serviceGlyph(b.label || b.command))}</span>${esc(b.label || b.command)}</td>
        <td class="mono">${esc(b.command)} <span class="faint">#${b.pid}</span></td>
        <td>${exposure}</td>
      </tr>`;
    })
    .join('');

  const postureRows = (report.posture || [])
    .map((p) => row({ title: esc(p.label), sub: esc(p.detail || ''), actions: p.ok ? pill('on', 'good') : pill('off', 'bad'), search: p.label }))
    .join('');

  const remote = report.remote || {};
  const tailscale = remote.tailscale || {};
  const cloudflared = remote.cloudflared || {};
  const remoteRows = [
    row({ title: 'Tailscale', sub: tailscale.installed ? 'installed' : 'not installed', actions: tailscale.installed ? pill('installed', 'good') : pill('not installed'), search: 'tailscale' }),
    row({
      title: 'cloudflared',
      sub: cloudflared.installed ? (cloudflared.running ? `running · ${cloudflared.processes.length} process` : 'installed · no active tunnel') : 'not installed',
      actions: cloudflared.running ? pill('exposed', 'warn') : cloudflared.installed ? pill('idle') : pill('not installed'),
      search: 'cloudflared tunnel',
    }),
  ].join('');

  const secretInfo = report.secrets || {};
  const secretChips = (secretInfo.present || []).map((s) => `<span class="chip">${esc(s.name)}${s.empty ? ' <span class="faint">empty</span>' : ''}</span>`).join('');
  const missingRows = (secretInfo.missing || []).map((name) => row({ title: esc(name), sub: 'referenced but not set in env files', actions: pill('missing', 'bad'), search: name })).join('');

  return [
    `<div class="toolbar-row"><button class="btn small" data-security-refresh>${svg('restart')} Re-run audit</button></div>`,
    `<div class="grid stats">${securityWidgets}</div>`,
    group('Attention', warnCount ? `${warnCount} warning${warnCount === 1 ? '' : 's'}` : 'no issues found', card(`<div class="rows">${issueRows || '<div class="empty-note">No issues detected</div>'}</div>`)),
    group('Network exposure', 'listening TCP sockets', card(table([{ label: 'Port', num: true }, { label: 'Service' }, { label: 'Process' }, { label: 'Exposure' }], bindingRows, 'None'))),
    group('macOS posture', null, card(`<div class="rows">${postureRows}</div>`)),
    group('Remote access', null, card(`<div class="rows">${remoteRows}</div>`)),
    group('Secrets', `${secretInfo.present?.length || 0} set · ${secretInfo.missing?.length || 0} missing`, card(`<div class="chips">${secretChips || '<span class="faint">None</span>'}</div>${missingRows ? `<div class="rows">${missingRows}</div>` : ''}`)),
  ].join('');
}

async function loadSecurity() {
  const host = document.getElementById('security-root');
  if (!host) return;
  try {
    const report = await fetch('/api/security', { cache: 'no-store' }).then((r) => r.json());
    securityReportCache = report;
    host.innerHTML = securityBody(report);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Security audit unavailable: ${esc(error.message)}</div>`;
  }
}

// --- notifications ---------------------------------------------------------

function viewNotify() {
  return `<div id="notify-root">${skeletonRows(5)}</div>`;
}

function switchRow(name, label, sub, checked) {
  return `<div class="row">
    <div class="row-main"><div class="row-title">${esc(label)}</div>${sub ? `<div class="row-sub">${esc(sub)}</div>` : ''}</div>
    <label class="switch"><input type="checkbox" data-notify="${name}" ${checked ? 'checked' : ''}><span class="switch-track"></span></label>
  </div>`;
}

function inputRow(name, label, sub, value, type = 'text', placeholder = '') {
  return `<div class="row">
    <div class="row-main"><div class="row-title">${esc(label)}</div>${sub ? `<div class="row-sub">${esc(sub)}</div>` : ''}</div>
    <input class="row-input" type="${esc(type)}" data-notify="${name}" value="${esc(value == null ? '' : value)}" placeholder="${esc(placeholder)}">
  </div>`;
}

function notifyBody(info) {
  const s = info.settings || {};
  const tokenNote = info.telegramAvailable ? 'token found in OpenClaw env' : 'no bot token found';
  return [
    group('Notifications', 'macOS banners & Telegram alerts', card(`<div class="rows">
      ${switchRow('enabled', 'Enable notifications', 'Master switch for all alerts', s.enabled)}
      ${switchRow('macos', 'macOS notifications', 'Banners via Notification Center', s.macos)}
      ${switchRow('telegram', 'Telegram', 'Send alerts to your chat', s.telegram)}
      ${switchRow('push', 'Web Push', 'Send alerts to an installed PWA', s.push)}
      ${inputRow('telegramChatId', 'Telegram chat id', tokenNote, s.telegramChatId || info.telegramChatId || '', 'text', 'e.g. 867840921')}
      ${inputRow('diskFreePctThreshold', 'Disk free threshold (%)', 'Alert when free space drops below this', s.diskFreePctThreshold, 'number')}
      ${switchRow('notifyJobDone', 'Notify when a job finishes', null, s.notifyJobDone)}
      ${switchRow('notifyJobFailed', 'Notify when a job fails', null, s.notifyJobFailed)}
      ${switchRow('notifyServiceDown', 'Notify when a service goes down', null, s.notifyServiceDown)}
      ${inputRow('cooldownMinutes', 'Cooldown (minutes)', 'Minimum gap between repeat alerts', s.cooldownMinutes, 'number')}
    </div>`)),
    `<div class="toolbar-row">
      <button class="btn small" data-notify-test="macos">Test macOS</button>
      <button class="btn small" data-notify-test="telegram">Test Telegram</button>
      <button class="btn small" data-notify-test="push">Test push</button>
      <button class="btn small" data-notify-test="all">Test all</button>
      <button class="btn primary" data-notify-save>Save</button>
    </div>`,
  ].join('');
}

async function loadNotify() {
  const host = document.getElementById('notify-root');
  if (!host) return;
  try {
    const info = await fetch('/api/notify', { cache: 'no-store' }).then((r) => r.json());
    host.innerHTML = notifyBody(info);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Settings unavailable: ${esc(error.message)}</div>`;
  }
}

function readNotifyForm() {
  const patch = {};
  for (const el of els.view.querySelectorAll('[data-notify]')) {
    const name = el.getAttribute('data-notify');
    if (el.type === 'checkbox') patch[name] = el.checked;
    else if (el.type === 'number') patch[name] = Number(el.value);
    else patch[name] = el.value;
  }
  return patch;
}

async function saveNotify() {
  await api('/api/notify', { method: 'POST', body: readNotifyForm() });
  toast('Notification settings saved', 'good');
}

async function testNotify(channel) {
  if (channel === 'push' || channel === 'all') {
    try { await previewBrowserNotification(); } catch { /* preview is best-effort */ }
  }
  const result = await api('/api/notify/test', { method: 'POST', body: { channel } });
  toast(result.message || 'Sent', 'good');
  return result;
}

// --- model ops: usage, benchmarks, HuggingFace -----------------------------

async function loadPackagesOutdated() {
  if (!document.getElementById('packages-root')) return;
  try {
    packagesState.outdated = await fetch('/api/packages/outdated', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    packagesState.outdated = null;
  }
  renderPackages();
}

async function loadModelExtras() {
  const host = document.getElementById('model-extras');
  if (!host) return;
  try {
    const [insights, usage] = await Promise.all([
      fetch('/api/models/insights', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/models/usage', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    host.innerHTML = modelAdvisorBody(insights) + modelUsageBody(insights.models || [], usage.benchmarks || []);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Model insights unavailable: ${esc(error.message)}</div>`;
  }
}

function modelAdvisorBody(insights) {
  const recs = insights.recommended || [];
  const reclaim = insights.totalReclaimableBytes || 0;

  if (!recs.length) {
    return group('Prune advisor', 'nothing to prune', card(`<div class="rows">${row({
      title: 'No unused models',
      sub: `${insights.modelCount || 0} installed · all are used by your agent or loaded recently`,
      search: 'prune advisor models',
    })}</div>`));
  }

  const summary = `<div class="row" style="border-top:none">
    <div class="row-main">
      <div class="row-title">${recs.length} model${recs.length === 1 ? '' : 's'} unused for 7+ days</div>
      <div class="row-sub">Not referenced by your OpenClaw routing · deleting frees up to ${fmtBytes(reclaim)}</div>
    </div>
    <div class="row-actions">${actBtn('ollama.removeMany', { models: recs.map((r) => r.name) }, 'Delete all…', 'danger', { impact: `Frees up to ${fmtBytes(reclaim)}` })}</div>
  </div>`;

  const rows = recs
    .map((r) =>
      row({
        title: esc(r.name),
        badge: r.shared ? pill('shared blob', 'warn') : '',
        sub: `${r.freesIfDeleted ? `${fmtBytes(r.freesIfDeleted)} freed` : 'shared, delete all tags to free space'} · ${r.loads ? `loaded ${r.loads}×` : 'never loaded'}${r.lastLoaded ? ` · last ${relativeTime(new Date(r.lastLoaded).toISOString())}` : ''}`,
        icon: `<span class="row-ico-svg">${svg('brain')}</span>`,
        actions: actBtn('ollama.remove', { model: r.name }, 'Delete…', 'danger', { impact: r.freesIfDeleted ? `Frees ${fmtBytes(r.freesIfDeleted)}` : 'Shared blob, frees nothing alone' }),
        search: r.name,
      }),
    )
    .join('');

  return group('Prune advisor', `frees up to ${fmtBytes(reclaim)}`, card(`<div class="rows">${summary}${rows}</div>`));
}

function modelUsageBody(models, benchmarks) {
  const usageRows = models
    .slice()
    .sort((a, b) => (b.lastLoaded || 0) - (a.lastLoaded || 0))
    .map(
      (m) => `<tr data-search="${esc(m.name.toLowerCase())}">
        <td class="mono">${esc(m.name)}</td>
        <td>${m.used ? pill('in use', 'accent') : m.cold ? pill('cold', 'warn') : pill('idle')}</td>
        <td class="num">${m.loads || 0}</td>
        <td>${m.lastLoaded ? esc(relativeTime(new Date(m.lastLoaded).toISOString())) : '<span class="faint">never</span>'}</td>
      </tr>`,
    )
    .join('');

  const benchRows = benchmarks
    .map(
      (b) => `<tr data-search="${esc(b.model.toLowerCase())}"><td class="mono">${esc(b.model)}</td><td class="num">${b.tokPerSec ? b.tokPerSec.toFixed(1) : '–'}</td><td class="num">${b.loadMs ? `${(b.loadMs / 1000).toFixed(1)} s` : '–'}</td><td class="muted">${esc(relativeTime(new Date(b.ts).toISOString()))}</td><td class="num">${actBtn('ollama.benchmark', { model: b.model }, 'Re-run')}</td></tr>`,
    )
    .join('');

  return [
    group('Usage', 'what your agent and you actually run', card(table([{ label: 'Model' }, { label: 'Status' }, { label: 'Loads', num: true }, { label: 'Last loaded' }], usageRows, 'No usage recorded yet'))),
    group('Benchmark leaderboard', 'tokens/sec on this machine', card(table([{ label: 'Model' }, { label: 'tok/s', num: true }, { label: 'Load', num: true }, { label: 'When' }, { label: '' }], benchRows, 'No benchmarks yet, use the Bench button on a model'))),
  ].join('');
}

const HF_DIRS = ['checkpoints', 'loras', 'vae', 'controlnet', 'clip', 'clip_vision', 'text_encoders', 'unet', 'diffusion_models', 'upscale_models', 'embeddings'];
const hfState = { results: [], files: [], repo: null, query: '', dir: 'checkpoints' };

function hfPanel() {
  const results = (hfState.results || [])
    .map((m) => `<button class="hf-result${m.id === hfState.repo ? ' active' : ''}" data-hf-repo="${esc(m.id)}">
      <span class="hf-name">${esc(m.id)}</span>
      <span class="hf-meta">${fmtNum(m.downloads || 0)} downloads${m.pipeline ? ` · ${esc(m.pipeline)}` : ''}</span>
    </button>`)
    .join('');

  const fileRows = (hfState.files || [])
    .map((f) => {
      const name = typeof f === 'string' ? f : f.name;
      const bytes = typeof f === 'string' ? null : f.bytes;
      return row({ title: `<span class="mono">${esc(name)}</span>`, size: bytes != null ? fmtBytes(bytes) : null, actions: `<button class="btn small" data-hf-download="${esc(name)}"${state.session.readOnly ? ' disabled' : ''}>Download</button>`, search: name });
    })
    .join('');

  const dirSelect = `<select id="hf-dir" class="row-input">${HF_DIRS.map((d) => `<option${d === hfState.dir ? ' selected' : ''}>${d}</option>`).join('')}</select>`;

  return group(
    'HuggingFace',
    'download models into ComfyUI',
    card(`<div class="hf-bar">
      <input id="hf-query" class="row-input grow" placeholder="Search HuggingFace models…" value="${esc(hfState.query)}" />
      <button class="btn small primary" data-hf-search>Search</button>
    </div>
    ${results ? `<div class="hf-results">${results}</div>` : ''}
    ${hfState.repo ? `<div class="hf-file-head"><span class="mono">${esc(hfState.repo)}</span><span class="hf-target"><span class="faint">target</span>${dirSelect}</span></div><div class="rows">${fileRows || '<div class="empty-note">No downloadable files</div>'}</div>` : ''}`),
  );
}

async function loadHf() {
  const host = document.getElementById('hf-root');
  if (!host) return;
  host.innerHTML = hfPanel();
}

// --- ComfyUI queue + gallery -----------------------------------------------

async function loadComfyExtras() {
  const queueHost = document.getElementById('comfy-queue');
  const galleryHost = document.getElementById('gallery-root');
  const analysisHost = document.getElementById('comfy-analysis');
  if (analysisHost) {
    try {
      const analysis = await fetch('/api/comfy/analysis', { cache: 'no-store' }).then((r) => r.json());
      analysisHost.innerHTML = comfyAnalysisBody(analysis);
    } catch (error) {
      analysisHost.innerHTML = `<div class="empty-note">Analysis unavailable: ${esc(error.message)}</div>`;
    }
  }
  if (queueHost) {
    try {
      const q = await fetch('/api/comfy/queue', { cache: 'no-store' }).then((r) => r.json());
      queueHost.innerHTML = comfyQueueBody(q);
    } catch (error) {
      queueHost.innerHTML = `<div class="empty-note">Queue unavailable: ${esc(error.message)}</div>`;
    }
  }
  if (galleryHost) {
    try {
      const { images } = await fetch('/api/gallery', { cache: 'no-store' }).then((r) => r.json());
      galleryHost.innerHTML = galleryBody(images || []);
    } catch (error) {
      galleryHost.innerHTML = `<div class="empty-note">Gallery unavailable: ${esc(error.message)}</div>`;
    }
  }
}

function comfyAnalysisBody(a) {
  const groups = [];

  const dupGroups = a.duplicates || [];
  if (dupGroups.length) {
    const rows = dupGroups
      .map(
        (group) =>
          `<div class="rows">${group.files
            .map((file) =>
              row({
                title: esc(file.name),
                sub: `duplicate · ${fmtBytes(group.bytes)} each · ${esc(group.type)}`,
                size: fmtBytes(group.bytes),
                actions: `${actBtn('file.reveal', { path: file.path }, 'Reveal')}${actBtn('file.trash', { path: file.path }, 'Trash…', 'danger')}`,
                search: file.name,
              }),
            )
            .join('')}</div>`,
      )
      .join('');
    groups.push(group('Duplicate files', `${dupGroups.length} set${dupGroups.length === 1 ? '' : 's'} · ${fmtBytes(a.duplicateBytes)} reclaimable`, card(rows)));
  }

  const unused = a.unused || [];
  if (unused.length) {
    const rows = unused
      .map((file) =>
        row({
          title: esc(file.name),
          badge: pill(file.modelType),
          sub: `not referenced by any saved workflow · ${esc(file.type)}`,
          icon: `<span class="row-ico-svg">${svg('photo')}</span>`,
          size: fmtBytes(file.bytes),
          actions: `${actBtn('file.reveal', { path: file.path }, 'Reveal')}${actBtn('file.trash', { path: file.path }, 'Trash…', 'danger')}`,
          search: file.name,
        }),
      )
      .join('');
    groups.push(group('Possibly unused', `${unused.length} file${unused.length === 1 ? '' : 's'} · ${fmtBytes(a.unusedBytes)}`, card(`<div class="rows">${rows}</div>`)));
  }

  if (!groups.length) {
    groups.push(
      group(
        'Image model analysis',
        'no duplicates or unused files',
        card(`<div class="rows">${row({ title: 'Your image models look tidy', sub: `${fmtBytes(a.totalBytes)} across ${(a.files || []).length} files, all referenced by workflows`, search: 'image analysis' })}</div>`),
      ),
    );
  }
  return groups.join('');
}

function comfyQueueBody(q) {
  const actions = state.session.readOnly
    ? ''
    : '<button class="btn small" data-comfy-clear>Clear pending</button><button class="btn small" data-comfy-interrupt>Interrupt</button>';
  return group(
    'Queue',
    q.available ? `${q.running} running · ${q.pending} pending` : 'ComfyUI not reachable',
    card(`<div class="rows">
      ${row({ title: 'Running', sub: 'currently executing', size: String(q.running ?? 0), actions })}
      ${row({ title: 'Pending', sub: 'waiting to execute', size: String(q.pending ?? 0) })}
    </div>`),
  );
}

function galleryBody(images) {
  if (!images.length) {
    return group('Gallery', 'generated images', card('<div class="empty-note">No images in ~/ComfyUI/output yet</div>'));
  }
  const items = images
    .map((image) => {
      const src = `/api/gallery/image?path=${encodeURIComponent(image.path)}`;
      const m = image.meta || {};
      const dims = m.width && m.height ? `${m.width}×${m.height}` : '';
      const sub = [m.model, dims, m.seed != null ? `seed ${m.seed}` : null].filter(Boolean).join(' · ');
      const title = [m.positive, m.negative ? `Negative: ${m.negative}` : null].filter(Boolean).join('\n\n');
      return `<a class="gallery-item" href="${src}" target="_blank" rel="noopener" title="${esc(title || image.name)}" data-search="${esc((image.name + ' ' + (m.model || '') + ' ' + (m.positive || '')).toLowerCase())}">
        <img loading="lazy" src="${src}" alt="${esc(image.name)}" />
        <div class="gallery-meta"><span class="g-name">${esc(image.name)}</span><span class="g-sub">${esc(sub || relativeTime(image.modifiedAt))}</span></div>
      </a>`;
    })
    .join('');
  return group('Gallery', `${images.length} recent generations`, card(`<div class="gallery">${items}</div>`));
}

async function comfyInterrupt() {
  const result = await api('/api/comfy/interrupt', { method: 'POST', body: {} });
  toast(result.message || 'Interrupted', 'good');
  setTimeout(loadComfyExtras, 500);
}

async function comfyClearQueue() {
  const result = await api('/api/comfy/queue/clear', { method: 'POST', body: {} });
  toast(result.message || 'Cleared', 'good');
  setTimeout(loadComfyExtras, 500);
}

async function hfSearch() {
  const input = document.getElementById('hf-query');
  hfState.query = input ? input.value.trim() : hfState.query;
  if (!hfState.query) return;
  const response = await fetch(`/api/hf/search?q=${encodeURIComponent(hfState.query)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  const { models } = await response.json();
  hfState.results = models || [];
  hfState.repo = null;
  hfState.files = [];
  loadHf();
}

async function hfOpenRepo(repo) {
  hfState.repo = repo;
  try {
    const data = await fetch(`/api/hf/files?repo=${encodeURIComponent(repo)}`, { cache: 'no-store' }).then((r) => r.json());
    hfState.files = data.files || [];
  } catch (error) {
    toast(error.message, 'error');
    hfState.files = [];
  }
  loadHf();
}

function hfDownload(file, triggerEl) {
  const select = document.getElementById('hf-dir');
  const dir = select ? select.value : hfState.dir;
  runAction('hf.download', { repo: hfState.repo, file, dir }, triggerEl);
}

// --- agent activity --------------------------------------------------------

function viewActivity() {
  return `<div id="agent-root">${skeletonRows(5)}</div>`;
}

function agentBody(report) {
  if (!report.available) return '<div class="empty-note">OpenClaw database not found.</div>';
  const s = report.stats || {};

  const tiles = [
    { label: 'Agent runs (24h)', value: fmtNum(s.runs24h), icon: 'bot' },
    { label: 'Tool calls (24h)', value: fmtNum(s.tools24h), icon: 'bolt' },
    { label: 'Errors (24h)', value: s.errors24h ? fmtNum(s.errors24h) : '0', hint: `${(s.errorRate || 0).toFixed(1)}% of calls`, icon: 'warning' },
    { label: 'Avg tool time', value: fmtDuration(s.avgToolMs), icon: 'clock' },
    { label: 'Sessions', value: fmtNum(s.sessions), icon: 'user' },
    { label: 'Total runs', value: fmtNum(s.totalRuns), hint: `${fmtNum(s.totalEvents)} audit events`, icon: 'history' },
  ]
    .map(statTile)
    .join('');

  const activityRows = (report.activity || [])
    .map(
      (a, i) => `<tr class="clickable" data-event="${i}" data-search="${esc(((a.tool || '') + ' ' + a.action + ' ' + (a.agent || '')).toLowerCase())}">
        <td class="muted">${esc(relativeTime(new Date(a.at).toISOString()))}</td>
        <td>${esc(a.agent || '–')}</td>
        <td class="mono truncate">${esc(a.tool || a.action || '')}</td>
        <td>${a.status === 'error' ? pill('error', 'bad') : pill(a.status || 'ok', 'good')}</td>
        <td class="num">${fmtDuration(a.durationMs)}</td>
      </tr>`,
    )
    .join('');

  const toolChips = (report.topTools || []).map((t) => `<span class="chip" data-search="${esc(t.tool.toLowerCase())}">${esc(t.tool)} <span class="faint">${t.count}</span></span>`).join('');

  const autoRows = (report.automations || [])
    .map((j) =>
      row({
        title: esc(j.name),
        badge: j.enabled ? pill('on', 'good') : pill('paused'),
        sub: [j.description, j.nextRunAt ? `next ${new Date(j.nextRunAt).toLocaleString()}` : null, j.lastStatus ? `last ${j.lastStatus}` : null].filter(Boolean).map((x) => esc(x)).join(' · '),
        size: j.lastError ? pill('error', 'bad') : '',
        icon: `<span class="row-ico-svg">${svg('bot')}</span>`,
        search: j.name,
        clickable: true,
        attrs: `data-automation="${esc(j.id)}"`,
      }),
    )
    .join('');

  const skillRows = (report.skills || [])
    .map((k) => row({ title: esc(k.name), sub: `${esc(k.source || '')}${k.agent ? ` · ${esc(k.agent)}` : ''}`, size: `${k.uses} use${k.uses === 1 ? '' : 's'}`, search: k.name, clickable: true, attrs: `data-skill="${esc(k.name)}"` }))
    .join('');

  const backupRows = (report.backups || [])
    .map((b, i) => row({ title: esc(b.path), sub: esc(new Date(b.createdAt).toLocaleString()), size: b.status === 'ok' ? pill('ok', 'good') : pill(b.status || '?', 'warn'), search: b.path, clickable: true, attrs: `data-backup="${i}"` }))
    .join('');

  const sessionRows = (report.sessions || [])
    .map((x, i) => row({ title: esc(x.sessionKey), sub: `${esc(x.agent || '')} · seq ${x.lastSequence}`, size: esc(relativeTime(new Date(x.updatedAt).toISOString())), search: x.sessionKey, clickable: true, attrs: `data-session="${i}"` }))
    .join('');

  return [
    `<div class="grid stats">${tiles}</div>`,
    group('Recent activity', `${(report.activity || []).length} events`, card(table([{ label: 'When' }, { label: 'Agent' }, { label: 'Tool / action' }, { label: 'Status' }, { label: 'Duration', num: true }], activityRows, 'No activity'))),
    toolChips ? group('Top tools', null, card(`<div class="chips">${toolChips}</div>`)) : '',
    group('Automations', `${(report.automations || []).length} jobs`, card(`<div class="rows">${autoRows || '<div class="empty-note">None</div>'}</div>`)),
    group('Skill usage', null, card(`<div class="rows">${skillRows || '<div class="empty-note">No skills used yet</div>'}</div>`)),
    group('Backups', null, card(`<div class="rows">${backupRows || '<div class="empty-note">None</div>'}</div>`)),
    group('Sessions', null, card(`<div class="rows">${sessionRows || '<div class="empty-note">None</div>'}</div>`)),
  ].join('');
}

async function loadAgent() {
  const host = document.getElementById('agent-root');
  if (!host) return;
  try {
    const report = await fetch('/api/agent', { cache: 'no-store' }).then((r) => r.json());
    agentReportCache = report;
    host.innerHTML = agentBody(report);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">Agent data unavailable: ${esc(error.message)}</div>`;
  }
}

// --- store ----------------------------------------------------------------

const storeState = { kind: 'cask', query: '', results: [], featured: [], loading: false };

function viewStore() {
  return `<div id="store-root">${skeletonRows(5)}</div>`;
}

function storeInstallButton(name, kind, installed) {
  if (state.session.readOnly) return '';
  const act = installed ? 'brew.uninstall' : 'brew.install';
  return `<button class="btn small ${installed ? 'ghost-danger' : 'primary'}" data-act="${act}" data-params='${esc(JSON.stringify({ name, kind }))}'>${installed ? 'Uninstall' : 'Install'}</button>`;
}

function storeItemRow(item) {
  return `<div class="row clickable" data-store-item="${esc(item.name)}" data-store-kind="${esc(item.kind)}" data-search="${esc(item.name.toLowerCase())}">
    <div class="row-main">
      <div class="row-title">${esc(item.name)} ${item.installed ? pill('installed', 'good') : ''}</div>
      ${item.desc ? `<div class="row-sub">${esc(item.desc)}</div>` : ''}
    </div>
    <div class="row-actions">${storeInstallButton(item.name, item.kind, item.installed)}</div>
  </div>`;
}

function storeCard(app) {
  return `<div class="store-card clickable" data-store-item="${esc(app.name)}" data-store-kind="cask">
    <div class="store-card-head"><span class="store-name">${esc(app.name)}</span>${app.installed ? pill('installed', 'good') : ''}</div>
    <div class="store-desc">${esc(app.desc || '')}</div>
    <div class="store-actions">${storeInstallButton(app.name, 'cask', app.installed)}</div>
  </div>`;
}

function storeBody() {
  const seg = `<div class="segmented">
    <button class="seg${storeState.kind === 'cask' ? ' active' : ''}" data-store-kind-btn="cask">Apps</button>
    <button class="seg${storeState.kind === 'formula' ? ' active' : ''}" data-store-kind-btn="formula">Formulae</button>
  </div>`;

  let content;
  if (storeState.query) {
    content = storeState.loading
      ? skeletonRows(4)
      : storeState.results.length
        ? `<div class="rows">${storeState.results.map(storeItemRow).join('')}</div>`
        : '<div class="empty-note">No results</div>';
  } else if (storeState.kind === 'cask') {
    content = `<div class="store-grid">${storeState.featured.map(storeCard).join('')}</div>`;
  } else {
    content = '<div class="empty-note">Search for a formula, or manage installed packages on the Homebrew page.</div>';
  }

  return `<div class="group-head">${seg}<span class="faint" style="font-size:11.5px">Homebrew</span></div>
    ${card(`<div class="hf-bar"><input id="store-query" class="row-input grow" placeholder="Search ${storeState.kind === 'cask' ? 'apps' : 'formulae'}…" value="${esc(storeState.query)}" /><button class="btn small primary" data-store-search>Search</button></div>${content}`)}`;
}

async function loadStore() {
  const host = document.getElementById('store-root');
  if (!host) return;
  if (!storeState.query && storeState.kind === 'cask' && !storeState.featured.length) {
    try {
      storeState.featured = (await fetch('/api/store/featured', { cache: 'no-store' }).then((r) => r.json())).apps || [];
    } catch {
      storeState.featured = [];
    }
  }
  host.innerHTML = storeBody();
}

async function storeSearch() {
  const input = document.getElementById('store-query');
  if (input) storeState.query = input.value.trim();
  storeState.results = [];
  storeState.loading = Boolean(storeState.query);
  await loadStore();
  if (!storeState.query) return;
  try {
    const response = await fetch(`/api/store/search?q=${encodeURIComponent(storeState.query)}&kind=${storeState.kind}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const data = await response.json();
    storeState.results = data.results || [];
  } finally {
    storeState.loading = false;
    await loadStore();
  }
}

function setStoreKind(kind) {
  storeState.kind = kind === 'formula' ? 'formula' : 'cask';
  storeState.query = '';
  storeState.results = [];
  loadStore();
}

async function showStoreDetail(name, kind = 'formula') {
  openPanel({ title: name, subtitle: kind === 'cask' ? 'Application' : 'Formula', body: skeletonRows(4) });
  try {
    const info = await fetch(`/api/store/info?name=${encodeURIComponent(name)}&kind=${kind}`, { cache: 'no-store' }).then((r) => r.json());
    if (info.error) throw new Error(info.error);
    const body = `
      ${info.desc ? `<div class="pad" style="padding-bottom:0"><div class="muted">${esc(info.desc)}</div></div>` : ''}
      <dl class="kv">
        <dt>Name</dt><dd class="mono">${esc(info.name)}</dd>
        <dt>Kind</dt><dd>${esc(kind === 'cask' ? 'Cask (app)' : 'Formula')}</dd>
        <dt>Version</dt><dd>${esc(info.version || '–')}</dd>
        <dt>Status</dt><dd>${info.installed ? pill('installed', 'good') : pill('not installed')}</dd>
        ${info.homepage ? `<dt>Homepage</dt><dd><a href="${esc(info.homepage)}" target="_blank" rel="noopener">${esc(info.homepage)}</a></dd>` : ''}
      </dl>
      ${(info.deps || []).length ? `<div class="chips">${info.deps.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div>` : ''}
      ${info.caveats ? `<div class="pad"><div class="faint" style="font-size:11.5px;white-space:pre-wrap">${esc(info.caveats)}</div></div>` : ''}`;
    const actions = state.session.readOnly ? '' : [
      storeInstallButton(info.name, kind, info.installed),
      info.installed && kind === 'formula' ? `<button class="btn small" data-act="brew.upgrade" data-params='${esc(JSON.stringify({ name: info.name }))}'>Upgrade</button>` : '',
    ].filter(Boolean).join('');
    openPanel({ title: info.name, subtitle: info.desc || (kind === 'cask' ? 'Application' : 'Formula'), body, actions });
  } catch (error) {
    openPanel({ title: name, subtitle: 'Error', body: `<div class="empty-note">${esc(error.message)}</div>` });
  }
}

// --- profile ---------------------------------------------------------------

function prefRow(title, sub, key, checked) {
  return `<div class="row"><div class="row-main"><div class="row-title">${esc(title)}</div>${sub ? `<div class="row-sub">${esc(sub)}</div>` : ''}</div><label class="switch"><input type="checkbox" data-pref-toggle="${esc(key)}" ${checked ? 'checked' : ''}><span class="switch-track"></span></label></div>`;
}

function profileBody(p) {
  const groups = (p.groups || []).map((g) => `<span class="chip" data-search="${esc(g.toLowerCase())}">${esc(g)}</span>`).join('');
  const swatches = `<button class="accent-swatch${prefs.accent === 'system' ? ' active' : ''}" data-pref-accent="system" title="System (${esc(systemAccent || 'detecting…')})" style="background:${systemAccentColor()}"></button>${Object.entries(ACCENTS)
    .map(([name, pair]) => `<button class="accent-swatch${prefs.accent === name ? ' active' : ''}" data-pref-accent="${name}" title="${esc(name)}" style="background:${pair[0]}"></button>`)
    .join('')}`;
  return `
    <div class="profile-head">
      <div class="avatar">${esc(initials(p.fullName || p.username))}</div>
      <div><div class="profile-name">${esc(p.fullName || p.username)}</div><div class="faint">${esc(p.username)}@${esc(p.hostname)}</div></div>
    </div>
    <dl class="kv">
      <dt>User</dt><dd>${esc(p.username)} ${p.admin ? pill('admin', 'accent') : ''}</dd>
      <dt>UID / GID</dt><dd>${p.uid} / ${p.gid}</dd>
      <dt>Home</dt><dd class="mono">${esc(p.home)}</dd>
      <dt>Shell</dt><dd class="mono">${esc(p.shell)}</dd>
      <dt>macOS</dt><dd>${esc(p.macos || '–')}</dd>
      <dt>Uptime</dt><dd>${esc(fmtUptime(p.uptime))}</dd>
      ${p.ownerChat ? `<dt>OpenClaw owner</dt><dd class="mono">telegram:${esc(p.ownerChat)}</dd>` : ''}
    </dl>
    <div class="group-title" style="padding:0 18px;margin-top:6px">Groups</div>
    <div class="chips">${groups || '<span class="faint">None</span>'}</div>
    <div class="group-title" style="padding:0 18px;margin-top:6px">Appearance</div>
    <div class="rows">
      <div class="row"><div class="row-main"><div class="row-title">Accent colour</div></div><div class="row-actions">${swatches}</div></div>
      ${prefRow('Compact density', 'Tighter spacing for more on screen', 'density', prefs.density === 'compact')}
      ${prefRow('Reduce motion', 'Disable animations and transitions', 'motion', prefs.motion === 'reduce')}
      ${prefRow('Liquid Glass', 'Translucent, blurred surfaces', 'material', prefs.material !== 'solid')}
    </div>
    <div class="group-title" style="padding:0 18px;margin-top:6px">Behaviour</div>
    <div class="rows">
      ${prefRow('Browser notifications', 'Show job alerts as browser banners', 'notifyBrowser', prefs.notifyBrowser)}
      ${prefRow('Keep awake during jobs', 'Hold a screen wake lock while actions run', 'wakeLock', prefs.wakeLock)}
      ${prefRow('Pause polling when idle', 'Stop metric polling while you are away', 'idlePause', prefs.idlePause)}
      ${prefRow('Touch ID for destructive actions', touchIdUsable() ? 'Require a fingerprint before irreversible actions' : 'Available only when opened via http://localhost', 'touchId', prefs.touchId)}
    </div>
    <div class="group-title" style="padding:0 18px;margin-top:6px">Capabilities</div>
    <div class="rows">${capabilityRows()}</div>`;
}

async function openProfile() {
  openPanel({ title: 'Profile', subtitle: 'User & preferences', body: skeletonRows(4) });
  try {
    const p = await fetch('/api/profile', { cache: 'no-store' }).then((r) => r.json());
    if (p.error) throw new Error(p.error);
    openPanel({ title: p.fullName || p.username, subtitle: `${p.username}@${p.hostname}`, body: profileBody(p) });
  } catch (error) {
    openPanel({ title: 'Profile', subtitle: 'Error', body: `<div class="empty-note">${esc(error.message)}</div>` });
  }
}

// --- network --------------------------------------------------------------

let networkTimer = null;
let netRange = 360;
const netState = { data: null, series: null };

function viewNetwork() {
  return `<div id="network-root">
    <div id="net-live">${skeletonRows(4)}</div>
    <div id="net-conns">${skeletonRows(2)}</div>
    ${networkProbes()}
  </div>`;
}

function networkProbes() {
  return `<div class="group"><div class="group-title">Diagnostics</div>${card(`
    <div class="hf-bar">
      <button class="btn small" data-ping="gateway">Ping gateway</button>
      <button class="btn small" data-ping="1.1.1.1">Ping 1.1.1.1</button>
      <button class="btn small" data-ping="huggingface.co">Ping huggingface.co</button>
    </div>
    <div class="hf-bar">
      <input id="port-host" class="row-input" placeholder="host" value="127.0.0.1" />
      <input id="port-number" class="row-input" value="8188" placeholder="port" inputmode="numeric" />
      <button class="btn small" data-port-check>Check port</button>
    </div>
    <div class="pad" id="net-probe-result"><span class="faint" style="font-size:11.5px">Run a diagnostic above.</span></div>
  `)}</div>`;
}

function setProbeResult(html) {
  const host = document.getElementById('net-probe-result');
  if (host) host.innerHTML = html;
}

async function runPing(token) {
  const host = token === 'gateway' ? netState.data?.routing?.gateway : token;
  if (!host) {
    setProbeResult('<span class="warn">No gateway detected</span>');
    return;
  }
  setProbeResult(`<span style="display:inline-flex;align-items:center;gap:8px"><span class="spinner"></span>Pinging ${esc(host)}…</span>`);
  try {
    const result = await fetch(`/api/network/ping?host=${encodeURIComponent(host)}&count=3`, { cache: 'no-store' }).then((r) => r.json());
    if (result.error) throw new Error(result.error);
    const ok = result.lossPct === 0;
    setProbeResult(`<div class="net-result">${esc(result.host)} · ${ok ? pill('reachable', 'good') : pill(`${result.lossPct ?? '?'}% loss`, 'warn')} ${result.avgMs != null ? `· avg ${result.avgMs} ms (${result.minMs}–${result.maxMs})` : ''}</div>`);
  } catch (error) {
    setProbeResult(`<span class="bad">${esc(error.message)}</span>`);
    throw error;
  }
}

async function probePort(port) {
  try {
    const result = await fetch(`/api/network/port?host=127.0.0.1&port=${encodeURIComponent(port)}`, { cache: 'no-store' }).then((r) => r.json());
    toast(result.open ? `Port ${port} is open (${result.ms} ms)` : `Port ${port} ${result.error || 'closed'}`, result.open ? 'good' : 'error');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runPortCheck() {
  const hostEl = document.getElementById('port-host');
  const portEl = document.getElementById('port-number');
  const host = hostEl ? hostEl.value.trim() : '';
  const port = portEl ? portEl.value.trim() : '';
  if (!host || !port) return;
  setProbeResult(`<span style="display:inline-flex;align-items:center;gap:8px"><span class="spinner"></span>Checking ${esc(host)}:${esc(port)}…</span>`);
  try {
    const result = await fetch(`/api/network/port?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`, { cache: 'no-store' }).then((r) => r.json());
    if (result.error && !result.open) {
      setProbeResult(`<div class="net-result">${esc(host)}:${esc(String(port))} · ${pill(result.error === 'timed out' ? 'timeout' : 'closed', 'warn')}</div>`);
      return;
    }
    setProbeResult(`<div class="net-result">${esc(host)}:${esc(String(port))} · ${result.open ? pill('open', 'good') : pill('closed', 'warn')}${result.ms != null ? ` · ${result.ms} ms` : ''}</div>`);
  } catch (error) {
    setProbeResult(`<span class="bad">${esc(error.message)}</span>`);
    throw error;
  }
}

function networkLiveBody(data, series) {
  if (!data) return '<div class="empty-note">Network info unavailable</div>';
  const net = data.net || {};
  const primary = (data.interfaces || []).find((i) => i.status === 'active') || (data.interfaces || [])[0] || {};

  const samples = (series && series.samples) || [];
  const rx = [];
  const tx = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = (samples[i].ts - samples[i - 1].ts) / 1000;
    rx.push(dt > 0 ? Math.max(0, (samples[i].netRx - samples[i - 1].netRx) / dt) : 0);
    tx.push(dt > 0 ? Math.max(0, (samples[i].netTx - samples[i - 1].netTx) / dt) : 0);
  }

  const tiles = [
    { label: 'Download', value: net.rxRate != null ? `${fmtBytes(net.rxRate)}/s` : '–', hint: `${fmtBytes(net.rx)} total`, icon: 'download', spark: rx, sparkColor: '#4cc2c4' },
    { label: 'Upload', value: net.txRate != null ? `${fmtBytes(net.txRate)}/s` : '–', hint: `${fmtBytes(net.tx)} total`, icon: 'upload', spark: tx, sparkColor: '#5e6ad2' },
    { label: 'Active connections', value: String((data.connections || {}).total ?? 0), hint: primary.ipv4 ? `${primary.ipv4} on ${primary.name}` : 'current', icon: 'network' },
    { label: 'Link', value: primary.media ? primary.media.split('(')[0].trim() : '–', hint: primary.name ? `${primary.name}${primary.ipv4 ? ` · ${primary.ipv4}` : ''}` : '', icon: 'link' },
  ]
    .map(statTile)
    .join('');
  const rateFormat = (v) => `${fmtBytes(v)}/s`;
  const rangeBar = `<div class="segmented">${MONITOR_RANGES.map((r) => `<button class="seg${r.minutes === netRange ? ' active' : ''}" data-net-range="${r.minutes}">${r.label}</button>`).join('')}</div>`;
  const charts = `<div class="grid two">
    ${chartCard('Download', rx, { color: '#4cc2c4', format: rateFormat })}
    ${chartCard('Upload', tx, { color: '#5e6ad2', format: rateFormat })}
  </div>`;

  const interfaceRows = (data.interfaces || [])
    .map((iface) => {
      const ifaceGlyph = /wi-?fi|wireless/i.test(iface.port || '') ? 'network' : /ethernet|base|10\/100|1000|10g/i.test(iface.port || '') ? 'link' : 'layers';
      return row({
        title: `${esc(iface.name)} <span class="faint">${esc(iface.port || '')}</span>`,
        badge: iface.status === 'active' ? pill('active', 'good') : '',
        sub: [iface.ipv4, iface.ipv6, iface.mac, iface.media].filter(Boolean).join(' · ') || 'inactive',
        actions: iface.ipv4 ? `<button class="btn small icon" data-copy="${esc(iface.ipv4)}" title="Copy IP">${svg('copy')}</button>` : '',
        search: `${iface.name} ${iface.port || ''} ${iface.ipv4 || ''}`,
        clickable: true,
        attrs: `data-iface="${esc(iface.name)}"`,
        icon: `<span class="row-ico-svg">${svg(ifaceGlyph)}</span>`,
      });
    })
    .join('');

  const routing = data.routing || {};
  const routingCard = card(`<dl class="kv">
    <dt>Default gateway</dt><dd class="mono">${esc(routing.gateway || '–')}</dd>
    <dt>Interface</dt><dd class="mono">${esc(routing.defaultInterface || '–')}</dd>
    <dt>DNS servers</dt><dd class="mono">${esc((routing.dnsServers || []).join(', ') || '–')}</dd>
    <dt>Search domains</dt><dd class="mono">${esc((routing.searchDomains || []).join(', ') || '–')}</dd>
    <dt>Reachability</dt><dd>${routing.reachable ? pill('online', 'good') : pill('offline', 'bad')}</dd>
  </dl>`);

  return [
    `<div class="grid stats">${tiles}</div>`,
    `<div class="group"><div class="group-head"><div class="group-title">Throughput</div>${rangeBar}</div>${charts}</div>`,
    group('Interfaces', `${(data.interfaces || []).length}`, card(`<div class="rows">${interfaceRows || '<div class="empty-note">None</div>'}</div>`)),
    group('Routing & DNS', null, routingCard),
  ].join('');
}

function networkConnectionsBody(conn) {
  if (!conn) return '';
  const rows = (conn.processes || [])
    .map((p) =>
      row({
        title: `${esc(p.command)} <span class="faint mono">${p.pid}</span>`,
        sub: esc((p.remotes || []).join('   ')),
        size: String(p.count),
        search: `${p.command} ${p.pid}`,
        clickable: true,
        attrs: `data-conn="${p.pid}"`,
      }),
    )
    .join('');
  return group('Connections', `${conn.total} established`, card(`<div class="rows">${rows || '<div class="empty-note">No established connections</div>'}</div>`));
}

async function loadNetwork() {
  if (state.idle) return;
  if (state.view !== 'network') {
    stopNetworkPolling();
    return;
  }
  const live = document.getElementById('net-live');
  const conns = document.getElementById('net-conns');
  if (!live) return;
  try {
    const [data, series] = await Promise.all([
      fetch('/api/network', { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/metrics/series?minutes=${netRange}`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    netState.data = data;
    netState.series = series;
    live.innerHTML = networkLiveBody(data, series);
    if (conns) conns.innerHTML = networkConnectionsBody(data.connections);
  } catch (error) {
    live.innerHTML = `<div class="empty-note">Network unavailable: ${esc(error.message)}</div>`;
  }
}

function startNetworkPolling() {
  stopNetworkPolling();
  loadNetwork();
  networkTimer = setInterval(loadNetwork, 5000);
}

function stopNetworkPolling() {
  if (networkTimer) {
    clearInterval(networkTimer);
    networkTimer = null;
  }
}

// --- OpenClaw pause / resume ----------------------------------------------

let openclawInfo = null;

async function loadOpenclawStatus() {
  if (state.idle) return;
  try {
    openclawInfo = await fetch('/api/openclaw', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    openclawInfo = null;
  }
  renderOpenclawToggle();
}

function renderOpenclawToggle() {
  const button = document.getElementById('openclaw-toggle');
  if (!button) return;
  if (!openclawInfo) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const paused = Boolean(openclawInfo.paused);
  const running = (openclawInfo.services || []).filter((service) => service.running).length;
  button.classList.toggle('paused', paused);
  button.disabled = state.session.readOnly;
  button.title = paused
    ? `OpenClaw is paused${openclawInfo.pausedAt ? ` (since ${relativeTime(new Date(openclawInfo.pausedAt).toISOString())})` : ''}. Click to resume.`
    : `OpenClaw is running (${running} service${running === 1 ? '' : 's'}). Click to pause and unload models.`;
  button.innerHTML = paused
    ? `<span class="status-dot warn"></span><span class="oc-label-long">Resume</span> OpenClaw`
    : `<span class="status-dot good"></span><span class="oc-label-long">Pause</span> OpenClaw`;
}

function refreshOpenclawSoon() {
  loadOpenclawStatus();
  setTimeout(loadOpenclawStatus, 1500);
  setTimeout(loadOpenclawStatus, 4000);
}

function toggleOpenclaw() {
  if (state.session.readOnly) return;
  const paused = Boolean(openclawInfo && openclawInfo.paused);
  runAction(paused ? 'openclaw.resume' : 'openclaw.pause', paused ? {} : { unloadModels: true }, document.getElementById('openclaw-toggle'))
    .then(refreshOpenclawSoon)
    .catch(() => {});
}

// --- detail panels ---------------------------------------------------------

let securityReportCache = null;
let agentReportCache = null;

const raw = (html) => ({ __html: html });
const mono = (value) => (value ? raw(`<span class="mono">${esc(value)}</span>`) : null);

function kv(pairs) {
  const rows = pairs
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value && value.__html != null ? value.__html : esc(value)}</dd>`)
    .join('');
  return `<dl class="kv">${rows || '<dt class="faint">No details</dt>'}</dl>`;
}

function panelError(title, subtitle, error) {
  openPanel({ title, subtitle, body: `<div class="empty-note">${esc(error.message || error)}</div>` });
}

function modelStatusBadges(insight, loaded) {
  const parts = [];
  if (insight && insight.used) parts.push(pill('in use', 'accent'));
  if (loaded) parts.push(pill('in memory', 'accent'));
  if (insight && insight.shared) parts.push(pill('shared blob', 'warn'));
  if (insight && insight.cold) parts.push(pill('cold', 'warn'));
  return parts.join(' ');
}

function openRowDetail(event) {
  const simple = (attr, fn) => {
    const el = event.target.closest(`[${attr}]`);
    if (el) {
      fn(el.getAttribute(attr), el);
      return true;
    }
    return false;
  };
  if (simple('data-model', (v) => showModelDetail(v))) return true;
  if (simple('data-service', (v) => showServiceDetail(v))) return true;
  if (simple('data-port', (v) => showPortDetail(Number(v)))) return true;
  if (simple('data-reclaim', (v) => showReclaimDetail(v))) return true;
  if (simple('data-dir', (v) => showDirDetail(v))) return true;
  if (simple('data-iface', (v) => showInterfaceDetail(v))) return true;
  if (simple('data-conn', (v) => showConnectionProcess(Number(v)))) return true;
  if (simple('data-binding', (v) => showBindingDetail(Number(v)))) return true;
  if (simple('data-issue', (v) => showIssueDetail(v))) return true;
  if (simple('data-event', (v) => showEventDetail(v))) return true;
  if (simple('data-automation', (v) => showAutomationDetail(v))) return true;
  if (simple('data-skill', (v) => showSkillDetail(v))) return true;
  if (simple('data-backup', (v) => showBackupDetail(v))) return true;
  if (simple('data-session', (v) => showSessionDetail(v))) return true;
  if (simple('data-comfy-group', (v) => showComfyGroupDetail(v))) return true;
  if (simple('data-npm', (v, el) => showNpmDetail(v, el.getAttribute('data-npm-version')))) return true;
  if (simple('data-pypi', (v, el) => showPyDetail(v, el.getAttribute('data-pypi-version'), el.getAttribute('data-py-label')))) return true;
  if (simple('data-model-file', (v, el) => showRuntimeFileDetail(v, el.getAttribute('data-file-name'), el.getAttribute('data-file-dir'), Number(el.getAttribute('data-file-bytes'))))) return true;
  if (simple('data-hf', (v, el) => showHfDetail(v, el.getAttribute('data-hf-downloads'), el.getAttribute('data-hf-likes'), el.getAttribute('data-hf-pipeline')))) return true;
  if (simple('data-checkpoint', (v, el) => showCheckpointDetail(v, el.getAttribute('data-ckpt-name'), Number(el.getAttribute('data-ckpt-bytes')), el.getAttribute('data-ckpt-type'), el.getAttribute('data-ckpt-referenced')))) return true;
  if (simple('data-file-path', (v, el) => showFileDetail(v, el.getAttribute('data-file-name'), Number(el.getAttribute('data-file-bytes'))))) return true;
  return false;
}

async function showModelDetail(name) {
  openPanel({ title: name, subtitle: 'Model', body: skeletonRows(4) });
  try {
    const d = await fetch(`/api/models/detail?name=${encodeURIComponent(name)}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const m = d.model || {};
    const ins = d.insight || {};
    const roles = (d.roles || []).map((role) => pill(role)).join(' ');
    const body = kv([
      ['Size', fmtBytes(m.sizeBytes)],
      ['Parameters', m.parameterSize],
      ['Quantization', m.quantization],
      ['Family', m.family],
      ['Context', m.contextLength ? `${fmtNum(m.contextLength)} tokens` : null],
      ['Capabilities', (m.capabilities || []).join(', ')],
      ['Status', raw(modelStatusBadges(ins, d.loaded))],
      ['Agent roles', raw(roles || null)],
      ['Last loaded', ins.lastLoaded ? relativeTime(new Date(ins.lastLoaded).toISOString()) : 'never'],
      ['Times loaded', String(ins.loads ?? 0)],
      ['Digest', mono(m.digest)],
      ['Modified', relativeTime(m.modifiedAt)],
      ['Frees if deleted', ins.freesIfDeleted > 0 ? fmtBytes(ins.freesIfDeleted) : ins.shared ? 'shared, delete all tags' : '–'],
    ]);
    const actions = state.session.readOnly
      ? ''
      : `${d.loaded ? actBtn('ollama.unload', { model: name }, 'Unload') : actBtn('ollama.load', { model: name }, 'Load')}${actBtn('ollama.benchmark', { model: name }, 'Benchmark')}<button class="btn small" data-copy="ollama run ${esc(name)}">Copy run</button><button class="btn small ghost-danger" data-act="ollama.remove" data-params='${esc(JSON.stringify({ model: name }))}' data-close-panel>Delete…</button>`;
    openPanel({ title: name, subtitle: [m.parameterSize, m.quantization].filter(Boolean).join(' · ') || 'Model', body, actions });
  } catch (error) {
    panelError(name, 'Error', error);
  }
}

async function showServiceDetail(label) {
  openPanel({ title: label, subtitle: 'Service', body: skeletonRows(4) });
  try {
    const d = await fetch(`/api/services/detail?label=${encodeURIComponent(label)}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const c = d.check || {};
    const k = d.known || {};
    const body = kv([
      ['Friendly name', k.friendly],
      ['Status', raw(c.running ? pill('running', 'good') : pill('stopped', 'warn'))],
      ['PID', c.pid],
      ['Runs', c.runs],
      ['Last exit code', c.lastExit],
      ['State', c.state],
      ['Log file', mono(c.stdout)],
      ['Plist', mono(d.plist)],
    ]);
    const shortName = label.split('.').pop();
    const actions = [
      c.stdout ? `<button class="btn small" data-log-jump="${esc(shortName)}">Open log</button>` : '',
      d.plist ? actBtn('file.reveal', { path: d.plist }, 'Reveal plist') : '',
      state.session.readOnly
        ? ''
        : c.running
          ? `${actBtn('service.restart', { label }, 'Restart')}<button class="btn small ghost-danger" data-act="service.stop" data-params='${esc(JSON.stringify({ label }))}'>Stop…</button>`
          : actBtn('service.start', { label }, 'Start'),
    ].filter(Boolean).join('');
    openPanel({ title: k.friendly || label, subtitle: label, body, actions });
  } catch (error) {
    panelError(label, 'Error', error);
  }
}

async function showPortDetail(port) {
  openPanel({ title: `Port ${port}`, subtitle: 'Listening socket', body: skeletonRows(3) });
  try {
    const d = await fetch(`/api/ports/detail?port=${port}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const e = d.entry || {};
    const allInterfaces = (e.hosts || []).some((h) => h === '*' || h === '0.0.0.0' || h === '::');
    const body = kv([
      ['Service', e.label],
      ['Process', e.command],
      ['PID', e.pid],
      ['Bound to', (e.hosts || []).join(', ')],
      ['Exposure', raw(allInterfaces ? pill('all interfaces', 'warn') : pill('loopback', 'good'))],
      ['Managed by', d.service ? d.service.label : null],
      ['Command', d.command ? raw(`<span class="mono" style="white-space:pre-wrap">${esc(d.command)}</span>`) : null],
    ]);
    const actions = `<button class="btn small" data-copy="127.0.0.1:${esc(String(port))}">Copy endpoint</button><button class="btn small" data-port-probe="${esc(String(port))}">Test connection</button>`;
    openPanel({ title: e.label || `Port ${port}`, subtitle: e.command ? `${e.command} · pid ${e.pid}` : '', body, actions });
  } catch (error) {
    panelError(`Port ${port}`, 'Error', error);
  }
}

async function showFileDetail(filePath, name, bytes) {
  openPanel({ title: name || baseName(filePath), subtitle: 'File', body: skeletonRows(3) });
  try {
    const d = await fetch(`/api/file/detail?path=${encodeURIComponent(filePath)}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const body = kv([
      ['File', mono(d.name)],
      ['Type', d.type],
      ['Size', fmtBytes(d.bytes)],
      ['Modified', relativeTime(d.modifiedAt)],
      ['Created', d.created ? relativeTime(d.created) : null],
      ['Permissions', d.mode],
      ['Path', mono(d.path)],
    ]);
    const actions = `${actBtn('file.reveal', { path: d.path }, 'Reveal')}<button class="btn small" data-copy="${esc(d.path)}">Copy path</button>${state.session.readOnly ? '' : `<button class="btn small ghost-danger" data-act="file.trash" data-params='${esc(JSON.stringify({ path: d.path }))}' data-close-panel>Trash…</button>`}`;
    openPanel({ title: d.name, subtitle: d.type ? d.type.split(',')[0] : 'File', body, actions });
  } catch (error) {
    panelError(name || baseName(filePath), 'File', error);
  }
}

function showReclaimDetail(id) {
  const report = diskReport || {};
  const item = (report.items || []).find((i) => i.id === id);
  let title = item ? item.label : id;
  let body = '';
  let actions = '';

  if (id === 'ollama-orphans') {
    title = 'Orphaned Ollama blobs';
    body = kv([['Total', fmtBytes((report.orphans || []).reduce((sum, b) => sum + b.bytes, 0))], ['Count', (report.orphans || []).length], ['Location', mono('~/.ollama/models/blobs')]]) +
      `<div class="rows">${(report.orphans || []).slice(0, 40).map((b) => row({ title: `<span class="mono">${esc(b.name)}</span>`, size: fmtBytes(b.bytes), actions: actBtn('file.reveal', { path: b.path }, 'Reveal'), search: b.name })).join('') || '<div class="empty-note">None</div>'}</div>`;
    actions = state.session.readOnly ? '' : actBtn('ollama.pruneOrphans', {}, 'Prune all…', 'danger', { impact: `Frees ${fmtBytes((report.orphans || []).reduce((sum, b) => sum + b.bytes, 0))}` });
  } else if (id === 'partials') {
    title = 'Incomplete downloads';
    body = `<div class="rows">${(report.partials || []).map((p) => row({ title: esc(p.name), sub: `<span class="mono faint">${esc(p.path)}</span>`, size: fmtBytes(p.bytes), actions: actBtn('download.discard', { path: p.path }, 'Discard…', 'danger'), search: p.name })).join('') || '<div class="empty-note">None</div>'}</div>`;
  } else if (id === 'trash') {
    title = 'Trash';
    body = kv([['Size', fmtBytes(item && item.bytes)], ['Location', mono('~/.Trash')]]) + '<div class="pad"><span class="faint" style="font-size:11.5px">macOS hides the Trash contents from unprivileged processes.</span></div>';
    actions = state.session.readOnly ? '' : actBtn('trash.empty', {}, 'Empty Trash…', 'danger', { impact: `Frees ${fmtBytes(item && item.bytes)}` });
  } else if (id === 'old-outputs') {
    title = 'Stale ComfyUI outputs';
    body = kv([['Files', report.oldOutputs && report.oldOutputs.count], ['Size', fmtBytes(report.oldOutputs && report.oldOutputs.bytes)]]) +
      `<div class="rows">${((report.oldOutputs && report.oldOutputs.files) || []).map((f) => row({ title: esc(f.name), size: fmtBytes(f.bytes), actions: `${actBtn('file.reveal', { path: f.path }, 'Reveal')}${actBtn('file.trash', { path: f.path }, 'Trash…', 'danger')}`, search: f.name })).join('') || '<div class="empty-note">None</div>'}</div>`;
  } else if (item) {
    body = kv([['Size', fmtBytes(item.bytes)], ['Note', item.detail]]);
    actions = item.action ? actBtn(item.action, item.actionParams || {}, 'Clear…', 'danger', { impact: `Frees ${fmtBytes(item.bytes)}` }) : '';
  } else {
    panelError(id, 'Unknown', new Error('No details available'));
    return;
  }
  openPanel({ title, subtitle: 'Reclaimable space', body, actions });
}

async function showDirDetail(target) {
  openPanel({ title: baseName(target) || target, subtitle: target, body: skeletonRows(4) });
  try {
    const tree = await fetch(`/api/disk/tree?path=${encodeURIComponent(target)}`, { cache: 'no-store' }).then((r) => r.json());
    if (tree.error) throw new Error(tree.error);
    const children = (tree.children || []).filter((c) => c.bytes > 0).slice(0, 40);
    const body = kv([['Path', mono(tree.path)], ['Total', fmtBytes(tree.totalBytes)], ['Children', children.length]]) +
      `<div class="rows">${children.map((c) => row({ title: `${esc(c.name)}${c.isDirectory ? '' : ' <span class="faint">file</span>'}`, size: fmtBytes(c.bytes), actions: c.isDirectory ? `<button class="btn small" data-dir="${esc(c.path)}">Open</button>` : actBtn('file.reveal', { path: c.path }, 'Reveal'), search: c.name, icon: `<span class="row-ico">${c.isDirectory ? folderIconImg(c.name) : fileIconImg(c.name)}</span>` })).join('') || '<div class="empty-note">Empty</div>'}</div>`;
    const actions = `${actBtn('file.reveal', { path: tree.path }, 'Reveal')}<button class="btn small" data-largest="${esc(tree.path)}">Largest files</button><button class="btn small" data-disk-explore="${esc(tree.path)}">Explore map</button>`;
    openPanel({ title: baseName(tree.path) || tree.path, subtitle: fmtBytes(tree.totalBytes), body, actions });
  } catch (error) {
    panelError(baseName(target), 'Error', error);
  }
}

function showInterfaceDetail(name) {
  const iface = ((netState.data && netState.data.interfaces) || []).find((i) => i.name === name);
  if (!iface) return panelError(name, 'Interface', new Error('Unknown interface'));
  const body = kv([
    ['Device', iface.name],
    ['Hardware port', iface.port],
    ['Status', raw(iface.status === 'active' ? pill('active', 'good') : pill(iface.status || 'inactive', 'warn'))],
    ['IPv4', mono(iface.ipv4)],
    ['IPv6', mono(iface.ipv6)],
    ['MAC', mono(iface.mac)],
    ['Media', iface.media],
  ]);
  const actions = `<button class="btn small" data-copy="${esc(iface.ipv4 || '')}">Copy IP</button>${iface.ipv4 ? `<button class="btn small" data-ping-host="${esc(iface.ipv4)}">Ping</button>` : ''}`;
  openPanel({ title: iface.name, subtitle: iface.port || 'Interface', body, actions });
}

async function showConnectionProcess(pid) {
  try {
    const sample = await fetch('/api/metrics/live', { cache: 'no-store' }).then((r) => r.json()).then((j) => j.sample);
    const proc = sample && (sample.procs || []).find((p) => p.pid === Number(pid));
    if (proc) {
      showProcessDetail(proc);
      return;
    }
  } catch {
    /* fall through */
  }
  openPanel({ title: `pid ${pid}`, subtitle: 'Connection', body: `<div class="empty-note">This process is below the Monitor threshold. See the Monitor page for top processes.</div>` });
}

function showBindingDetail(port) {
  const report = securityReportCache;
  const b = report && (report.bindings || []).find((x) => x.port === Number(port));
  if (!b) return panelError(`Port ${port}`, 'Binding', new Error('Not found'));
  const exposed = b.exposure !== 'loopback';
  const body = kv([
    ['Port', b.port],
    ['Service', b.label],
    ['Process', b.command],
    ['PID', b.pid],
    ['Bound to', (b.hosts || []).join(', ')],
    ['Exposure', raw(exposed ? pill(b.exposure === 'all' ? 'all interfaces' : 'LAN', 'warn') : pill('loopback', 'good'))],
  ]);
  const actions = `<button class="btn small" data-copy="127.0.0.1:${esc(String(b.port))}">Copy endpoint</button>`;
  openPanel({ title: b.label || `Port ${b.port}`, subtitle: exposed ? 'Exposed to the network' : 'Loopback only', body, actions });
}

function showIssueDetail(index) {
  const report = securityReportCache;
  const issue = report && (report.issues || [])[Number(index)];
  if (!issue) return panelError('Issue', 'Security', new Error('Not found'));
  const body = `${kv([['Severity', raw(issue.severity === 'warn' ? pill('attention', 'warn') : pill('info'))], ['Detail', issue.detail]])}${issue.fix ? `<div class="pad"><div class="row-title">How to fix</div><div class="row-sub">${esc(issue.fix)}</div></div>` : ''}`;
  const actions = '<button class="btn small" data-open-url="x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension">Open Privacy &amp; Security</button>';
  openPanel({ title: issue.title, subtitle: 'Security', body, actions });
}

function showEventDetail(index) {
  const report = agentReportCache;
  const e = report && (report.activity || [])[Number(index)];
  if (!e) return panelError('Event', 'Activity', new Error('Not found'));
  const body = kv([
    ['When', new Date(e.at).toLocaleString()],
    ['Agent', e.agent],
    ['Kind', e.kind],
    ['Action', e.action],
    ['Tool', e.tool],
    ['Status', raw(e.status === 'error' ? pill('error', 'bad') : pill(e.status || 'ok', 'good'))],
    ['Duration', fmtDuration(e.durationMs)],
    ['Error code', e.errorCode],
    ['Session', mono(e.session)],
    ['Run', mono(e.run)],
    ['Tool call', mono(e.toolCallId)],
  ]);
  openPanel({ title: e.tool || e.action || 'Event', subtitle: e.agent || 'Activity', body });
}

function showAutomationDetail(id) {
  const report = agentReportCache;
  const a = report && (report.automations || []).find((x) => x.id === id);
  if (!a) return panelError(id, 'Automation', new Error('Not found'));
  const body = kv([
    ['Name', a.name],
    ['Description', a.description],
    ['Enabled', raw(a.enabled ? pill('on', 'good') : pill('paused', 'warn'))],
    ['Next run', a.nextRunAt ? new Date(a.nextRunAt).toLocaleString() : null],
    ['Last run', a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : null],
    ['Last status', a.lastStatus],
    ['Last error', a.lastError],
    ['Job id', mono(a.id)],
  ]);
  const actions = `<button class="btn small" data-reveal-path="~/.openclaw/cron">Reveal cron</button>`;
  openPanel({ title: a.name || id, subtitle: 'Automation', body, actions });
}

function showSkillDetail(name) {
  const report = agentReportCache;
  const s = report && (report.skills || []).find((x) => x.name === name);
  if (!s) return panelError(name, 'Skill', new Error('Not found'));
  const body = kv([['Name', s.name], ['Source', s.source], ['Uses', s.uses], ['Last used', s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : null], ['Last agent', s.agent]]);
  openPanel({ title: s.name, subtitle: 'Skill usage', body });
}

function showBackupDetail(index) {
  const report = agentReportCache;
  const b = report && (report.backups || [])[Number(index)];
  if (!b) return panelError('Backup', 'Activity', new Error('Not found'));
  const body = kv([['Created', new Date(b.createdAt).toLocaleString()], ['Status', raw(b.status === 'ok' ? pill('ok', 'good') : pill(b.status || '?', 'warn'))], ['Path', mono(b.path)]]);
  const actions = `<button class="btn small" data-reveal-path="${esc(b.path)}">Reveal</button>`;
  openPanel({ title: baseName(b.path), subtitle: 'Backup run', body, actions });
}

function showSessionDetail(index) {
  const report = agentReportCache;
  const s = report && (report.sessions || [])[Number(index)];
  if (!s) return panelError('Session', 'Activity', new Error('Not found'));
  const body = kv([['Session key', mono(s.sessionKey)], ['Agent', s.agent], ['Last sequence', s.lastSequence], ['Updated', s.updatedAt ? new Date(s.updatedAt).toLocaleString() : null]]);
  openPanel({ title: s.sessionKey, subtitle: s.agent || 'Session', body });
}

function npmDetailBody(d, fallbackVersion) {
  return kv([
    ['Installed version', d.version ? raw(`${esc(d.version)}${d.outdated ? ` ${pill(`outdated → ${d.latest}`, 'warn')}` : ''}`) : fallbackVersion],
    ['Latest', d.latest],
    ['Description', d.description],
    ['License', d.license],
    ['Dependencies', d.dependencies ? String(d.dependencies) : null],
    ['Binaries', (d.binNames || []).join(', ') || null],
    ['Install path', mono(d.path)],
    ['Registry', raw(`<a href="${esc(d.npmUrl)}" target="_blank" rel="noopener">npmjs.com</a>`)],
    ['Homepage', d.homepage ? raw(`<a href="${esc(d.homepage)}" target="_blank" rel="noopener">${esc(d.homepage)}</a>`) : null],
  ]);
}

function npmDetailActions(d, name, version) {
  const update = d.outdated && !state.session.readOnly ? `<button class="btn small primary" data-act="npm.update" data-params='${esc(JSON.stringify({ name }))}' data-close-panel>Update to ${esc(d.latest)}</button>` : '';
  return `${update}<button class="btn small" data-copy="npm install -g ${esc(name)}@${esc(d.latest || version || 'latest')}">Copy install</button>${state.session.readOnly ? '' : `<button class="btn small ghost-danger" data-act="npm.uninstall" data-params='${esc(JSON.stringify({ name }))}' data-close-panel>Uninstall…</button>`}`;
}

async function showNpmDetail(name, version) {
  openPanel({ title: name, subtitle: 'npm package', body: skeletonRows(4) });
  try {
    const d = await fetchNpmDetail(name);
    openPanel({ title: d.name || name, subtitle: `npm · ${d.version || version || ''}`, body: npmDetailBody(d, version), actions: npmDetailActions(d, name, version) });
  } catch (error) {
    panelError(name, 'npm package', error);
  }
}

function pyDetailBody(d, fallbackVersion) {
  return `${kv([
    ['Installed version', d.version ? raw(`${esc(d.version)}${d.outdated ? ` ${pill(`outdated → ${d.latest}`, 'warn')}` : ''}`) : fallbackVersion],
    ['Latest on PyPI', d.latest],
    ['Summary', d.summary],
    ['Author', d.author],
    ['License', d.license],
    ['Requires Python', d.requiresPython],
    ['Interpreter', mono(`${d.interpreterLabel || ''} · ${d.interpreter}`)],
    ['Location', mono(d.location)],
    ['Files', d.fileCount != null ? fmtNum(d.fileCount) : null],
    ['Homepage', d.homepage ? raw(`<a href="${esc(d.homepage)}" target="_blank" rel="noopener">${esc(d.homepage)}</a>`) : null],
    ['PyPI', raw(`<a href="${esc(d.pypiUrl)}" target="_blank" rel="noopener">${esc(d.pypiUrl)}</a>`)],
  ])}${(d.requires || []).length ? `<div class="group-title" style="padding:6px 18px 0">Requires (${d.requires.length})</div><div class="chips">${d.requires.slice(0, 40).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}${(d.requiredBy || []).length ? `<div class="group-title" style="padding:6px 18px 0">Required by (${d.requiredBy.length})</div><div class="chips">${d.requiredBy.slice(0, 40).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}`;
}

function pyDetailActions(d, name, version, label) {
  const update = d.outdated && !state.session.readOnly ? `<button class="btn small primary" data-act="pip.upgrade" data-params='${esc(JSON.stringify({ name: d.name || name, label: d.interpreterLabel || label }))}' data-close-panel>Update to ${esc(d.latest)}</button>` : '';
  return `${update}<button class="btn small" data-copy="pip install ${esc(name)}==${esc(d.version || version || '')}">Copy install</button><button class="btn small" data-copy="pip uninstall ${esc(name)}">Copy uninstall</button>${d.location ? `<button class="btn small" data-dir="${esc(d.location)}">Browse location</button>` : ''}`;
}

async function showPyDetail(name, version, label) {
  openPanel({ title: name, subtitle: 'Python package', body: skeletonRows(4) });
  try {
    const d = await fetchPyDetail(name, label);
    openPanel({ title: d.name || name, subtitle: `Python${d.interpreterLabel ? ` ${d.interpreterLabel}` : ''} · ${d.version || version || ''}`, body: pyDetailBody(d, version), actions: pyDetailActions(d, name, version, label) });
  } catch (error) {
    panelError(name, 'Python package', error);
  }
}

function showRuntimeFileDetail(path, name, dir, bytes) {
  const body = kv([['File', mono(name)], ['Size', fmtBytes(bytes)], ['Directory', mono(dir)], ['Path', mono(path)]]);
  const actions = `${actBtn('file.reveal', { path }, 'Reveal')}<button class="btn small" data-copy="${esc(path)}">Copy path</button>`;
  openPanel({ title: name, subtitle: 'Model file', body, actions });
}

async function showHfDetail(id, downloads, likes, pipeline) {
  openPanel({ title: id, subtitle: 'Hugging Face', body: skeletonRows(4) });
  try {
    const d = await fetch(`/api/hf/files?repo=${encodeURIComponent(id)}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const list = d.files || [];
    const body = `${kv([
      ['Repository', mono(id)],
      ['Downloads', fmtNum(d.downloads ?? (Number(downloads) || 0))],
      ['Likes', fmtNum(d.likes ?? (Number(likes) || 0))],
      ['Pipeline', d.pipeline || pipeline],
      ['License', d.license],
      ['Last modified', d.lastModified ? new Date(d.lastModified).toLocaleString() : null],
      ['Gated', d.gated ? raw(pill('gated', 'warn')) : null],
      ['Tags', (d.tags || []).slice(0, 12).join(', ')],
    ])}${list.length ? `<div class="group-title" style="padding:6px 18px 0">Files (${list.length})</div><div class="rows">${list.slice(0, 30).map((f) => {
      const fname = typeof f === 'string' ? f : f.name;
      const fbytes = typeof f === 'string' ? null : f.bytes;
      return row({ title: `<span class="mono">${esc(fname)}</span>`, size: fbytes != null ? fmtBytes(fbytes) : null, search: fname });
    }).join('')}</div>` : ''}`;
    const actions = `<a class="btn small" href="https://huggingface.co/${esc(id)}" target="_blank" rel="noopener">View on HF</a><button class="btn small primary" data-hf-open-repo="${esc(id)}">Download into ComfyUI</button>`;
    openPanel({ title: id, subtitle: 'Hugging Face', body, actions });
  } catch (error) {
    panelError(id, 'Hugging Face', error);
  }
}

async function showCheckpointDetail(filePath, name, bytes, modelType, referenced) {
  openPanel({ title: name || baseName(filePath), subtitle: 'Checkpoint', body: skeletonRows(4) });
  try {
    const d = await fetch(`/api/comfy/checkpoint?path=${encodeURIComponent(filePath)}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const st = d.safetensors || null;
    const body = kv([
      ['File', mono(d.name)],
      ['Size', fmtBytes(d.bytes)],
      ['Type', d.modelType || modelType],
      ['Referenced by workflow', d.referenced == null ? (referenced === '1' || referenced === '0' ? raw(referenced === '1' ? pill('yes', 'good') : pill('no', 'warn')) : null) : raw(d.referenced ? pill('yes', 'good') : pill('no', 'warn'))],
      ['Parameters', st && st.params ? `${(st.params / 1e9).toFixed(2)} B` : null],
      ['Tensors', st ? fmtNum(st.tensors) : null],
      ['Precision', st && st.dtypes ? Object.keys(st.dtypes).join(', ') : null],
      ['Architecture', st ? (st.sdxl ? 'SDXL-style' : null) : null],
      ['Format', st && st.metadata ? (st.metadata.format || Object.entries(st.metadata).map(([k, v]) => `${k}=${v}`).join(', ')) : null],
      ['Modified', relativeTime(d.modifiedAt)],
      ['Path', mono(d.path)],
    ]);
    const actions = `${actBtn('file.reveal', { path: d.path }, 'Reveal')}${state.session.readOnly ? '' : `<button class="btn small ghost-danger" data-act="file.trash" data-params='${esc(JSON.stringify({ path: d.path }))}' data-close-panel>Move to Trash…</button>`}`;
    openPanel({ title: d.name, subtitle: d.modelType || 'Checkpoint', body, actions });
  } catch (error) {
    panelError(name || baseName(filePath), 'Checkpoint', error);
  }
}

function showComfyGroupDetail(type) {
  const group = ((state.data && state.data.comfyui && state.data.comfyui.modelGroups) || []).find((g) => g.type === type);
  if (!group) return panelError(type, 'Model group', new Error('Not found'));
  const files = group.files || [];
  const body = kv([['Type', group.type], ['Size', fmtBytes(group.bytes)], ['Files', group.fileCount || files.length], ['Path', mono(group.path)]]) +
    `<div class="rows">${files.slice(0, 50).map((f) => row({ title: esc(f.name), size: fmtBytes(f.bytes), actions: `${actBtn('file.reveal', { path: `${group.path}/${f.name}` }, 'Reveal')}${state.session.readOnly ? '' : `<button class="btn small ghost-danger" data-act="file.trash" data-params='${esc(JSON.stringify({ path: `${group.path}/${f.name}` }))}' data-close-panel>Trash…</button>`}`, search: f.name })).join('') || '<div class="empty-note">Empty</div>'}</div>`;
  openPanel({ title: group.type, subtitle: fmtBytes(group.bytes), body });
}

// --- action history --------------------------------------------------------

function viewHistory() {
  return `<div id="history-root">${skeletonRows(5)}</div>`;
}

function historyBody(actions) {
  if (!actions.length) return card('<div class="empty-note">No actions recorded yet, anything you run from the dashboard shows up here.</div>');
  const rows = actions
    .map((a) => {
      const meta = state.actions[a.action] || {};
      const paramText = Object.entries(a.params || {})
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(' · ');
      const statusPill = a.status === 'done' ? pill('done', 'good') : a.status === 'running' ? pill('running', 'warn') : a.status === 'failed' ? pill('failed', 'bad') : pill(a.status || '?');
      const actionsCell = a.undoable && !a.undone
        ? `<button class="btn small" data-undo="${a.id}">Undo</button>`
        : a.undone
          ? pill('undone')
          : '';
      const sub = `${esc(new Date(a.ts).toLocaleString())}${paramText ? ` · <span class="mono faint">${esc(paramText.slice(0, 140))}</span>` : ''}${a.message ? ` · ${esc(a.message)}` : ''}`;
      return row({ title: `${esc(meta.label || a.action)} ${statusPill}`, sub, actions: actionsCell, search: `${a.action} ${paramText}` });
    })
    .join('');
  return card(`<div class="rows">${rows}</div>`);
}

function diagnosticsBody(entries, cacheStats) {
  const cacheLine = cacheStats ? `cache: ${cacheStats.keys} cached · ${cacheStats.hits} hits · ${cacheStats.misses} misses` : '';
  if (!entries.length) {
    return group('Diagnostics', cacheLine, card('<div class="empty-note">No server errors or warnings logged this session.</div>'));
  }
  const rows = entries
    .map((entry) => {
      const levelPill = entry.level === 'warn' ? pill('warn', 'warn') : pill('error', 'bad');
      const title = entry.message.length > 200 ? `${entry.message.slice(0, 200)}…` : entry.message;
      return row({ title: `${levelPill} ${esc(title)}`, sub: esc(new Date(entry.ts).toLocaleString()), search: entry.message });
    })
    .join('');
  return group('Diagnostics', cacheLine, card(`<div class="rows">${rows}</div>`));
}

async function loadHistory() {
  const host = document.getElementById('history-root');
  if (!host) return;
  try {
    const [history, diagnostics] = await Promise.all([
      fetch('/api/history?limit=150', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/diagnostics', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ entries: [], cache: null })),
    ]);
    host.innerHTML = group('Actions', 'newest first', historyBody((history && history.actions) || []))
      + diagnosticsBody((diagnostics && diagnostics.entries) || [], diagnostics && diagnostics.cache);
  } catch (error) {
    host.innerHTML = `<div class="empty-note">History unavailable: ${esc(error.message)}</div>`;
  }
}

const RENDERERS = {
  overview: viewOverview,
  setup: viewSetup,
  monitor: viewMonitor,
  storage: viewStorage,
  security: viewSecurity,
  notify: viewNotify,
  ollama: viewOllama,
  comfy: viewComfy,
  runtimes: viewRuntimes,
  agent: viewAgent,
  activity: viewActivity,
  ainews: viewAINews,
  services: viewServices,
  network: viewNetwork,
  history: viewHistory,
  brew: viewBrew,
  store: viewStore,
  apps: viewApps,
  packages: viewPackages,
  maintenance: viewMaintenance,
};

// --- rendering / shell -----------------------------------------------------

function renderNav() {
  const data = simulateData(state.data) || {};
  const pins = (Array.isArray(prefs.pins) ? prefs.pins : []).filter((id) => VIEWS.some((v) => v.id === id));
  const navItem = (v) => {
    const count = v.count && data.summary ? v.count(data) : null;
    const pinned = pins.includes(v.id);
    return `<button class="nav-item${v.id === state.view ? ' active' : ''}" data-view="${v.id}" title="${esc(v.label)}">
      <span class="ico">${svg(v.icon)}</span><span class="nav-label">${esc(v.label)}</span>${count != null ? `<span class="count">${esc(count)}</span>` : ''}
      <span class="nav-pin${pinned ? ' on' : ''}" data-pin="${v.id}" title="${pinned ? 'Unpin' : 'Pin to top'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(v.label)}">${svg('star')}</span>
    </button>`;
  };
  const isAvailable = (v) => {
    if (!v || !v.available) return true;
    try { return Boolean(v.available(data)); } catch { return true; }
  };
  const sections = NAV_SECTIONS.map((section) => {
    const items = section.ids
      .map((id) => VIEWS.find((v) => v.id === id))
      .filter(Boolean)
      .filter(isAvailable)
      .map(navItem)
      .join('');
    if (!items) return '';
    return `<div class="nav-section"><div class="nav-section-label">${esc(section.label)}</div>${items}</div>`;
  }).filter(Boolean);
  if (pins.length) {
    const pinnedItems = pins
      .map((id) => VIEWS.find((v) => v.id === id))
      .filter(Boolean)
      .filter(isAvailable)
      .map(navItem)
      .join('');
    if (pinnedItems) sections.unshift(`<div class="nav-section"><div class="nav-section-label">Pinned</div>${pinnedItems}</div>`);
  }
  els.nav.innerHTML = sections.join('') + `<div class="nav-section nav-section-foot"><button class="nav-item${state.view === 'settings' ? ' active' : ''}" data-view="settings" title="Settings (⌘,)"><span class="ico">${svg('gears')}</span><span class="nav-label">Settings</span></button></div>`;
}

function renderMachineCard() {
  const system = state.data?.system || {};
  const disk = system.disk || {};
  els.machineLine.textContent = system.macos || system.hostname || 'Local machine';
  if (!system.model && !system.chip) {
    els.machineCard.innerHTML = '';
    return;
  }
  els.machineCard.innerHTML = `
    <div class="machine-art">${deviceBadge(system.model)}</div>
    <div class="machine-head">
      <span class="machine-name">${esc(system.model || 'Mac')}</span>
      <span class="machine-chip">${esc(system.chip || '')}${system.physicalMemoryLabel ? ` · ${esc(system.physicalMemoryLabel)}` : ''}</span>
    </div>
    ${disk.totalBytes ? `${bar(disk.usedPercent, disk.usedPercent > 90 ? 'var(--red)' : 'var(--accent)')}
      <div class="machine-foot"><span>${fmtBytes(disk.usedBytes)} used</span><span>${fmtBytes(disk.freeBytes)} free</span></div>` : ''}`;
}

function renderModeBadge() {
  els.modeBadge.innerHTML = state.session.readOnly
    ? pill('Read-only', 'warn')
    : pill('Management enabled', 'good');
}

function renderView() {
  els.view.classList.toggle('view-settings', state.view === 'settings');
  if (state.view === 'settings') {
    renderSettingsView();
    return;
  }
  const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0];
  const data = simulateData(state.data);
  if (data && view.available && !view.available(data)) {
    state.view = 'overview';
    if (location.hash.replace(/^#/, '') !== 'overview') location.hash = 'overview';
    renderNav();
    return renderView();
  }
  resetRowCursor();
  els.viewTitle.textContent = view.title;
  els.viewSub.textContent = view.id === 'monitor'
    ? 'Live · processes every 2s'
    : view.id === 'network'
      ? 'Live · refresh every 5s'
      : data?.generatedAt
        ? `Scanned ${relativeTime(data.generatedAt)}`
        : 'Loading inventory…';

  if (view.id !== 'services') stopLogFollow();
  if (view.id !== 'network') stopNetworkPolling();

  if (view.id === 'monitor') {
    els.view.innerHTML = viewMonitor();
    applyFilter();
    startMonitorPolling();
    return;
  }

  if (view.id === 'network') {
    els.view.innerHTML = viewNetwork();
    applyFilter();
    startNetworkPolling();
    return;
  }
  stopMonitorPolling();

  if (!data) {
    els.view.innerHTML = `<div class="empty-note">Loading inventory…</div>`;
    return;
  }
  const renderer = RENDERERS[view.id] || (() => '<div class="empty-note">Nothing here.</div>');
  els.view.innerHTML = renderer(data);
  applyFilter();
  if (view.id === 'storage') loadDisk();
  if (view.id === 'overview') loadOverviewExtras();
  if (view.id === 'brew') loadBrewPackages();
  if (view.id === 'apps') loadAppsDetail();
  if (view.id === 'packages') loadPackagesOutdated();
  if (view.id === 'maintenance') loadMaintenance();
  if (view.id === 'history') loadHistory();
  if (view.id === 'store') loadStore();
  if (view.id === 'services') {
    loadHealth();
    loadLogs();
  }
  if (view.id === 'security') loadSecurity();
  if (view.id === 'notify') loadNotify();
  if (view.id === 'ollama') loadModelExtras();
  if (view.id === 'comfy') {
    loadHf();
    loadComfyExtras();
  }
  if (view.id === 'activity') loadAgent();
  if (view.id === 'agent') renderOpenclawToggle();
  if (view.id === 'ainews') loadAINews();
}

function setView(id) {
  const target = VIEWS.find((v) => v.id === id);
  if (!target) return;
  const data = simulateData(state.data);
  if (data && target.available && !target.available(data)) id = 'overview';
  closePanel();
  state.view = id;
  if (location.hash.replace(/^#/, '') !== id) location.hash = id;
  renderNav();
  navigate(renderView);
}

function render() {
  renderNav();
  renderMachineCard();
  renderModeBadge();
  renderView();
}

function setScanStatus(text, busy) {
  els.scanStatus.innerHTML = busy ? `<span style="display:inline-flex;align-items:center;gap:6px"><span class="spinner"></span>${esc(text)}</span>` : esc(text || '');
  progressForced = Boolean(busy);
  updateProgress();
}

function applyFilter() {
  const query = state.filter.trim().toLowerCase();
  for (const el of els.view.querySelectorAll('[data-search]')) {
    const haystack = el.getAttribute('data-search') || '';
    el.style.display = !query || haystack.includes(query) ? '' : 'none';
  }
}

// --- api -------------------------------------------------------------------

async function refreshSession() {
  try {
    const session = await fetch('/api/session', { cache: 'no-store' }).then((r) => r.json());
    if (session && session.token) state.session = { ...state.session, ...session };
    renderModeBadge();
    return session;
  } catch {
    return null;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const attempt = async () => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-dashboard-token'] = state.session.token;
    const response = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let { response, data } = await attempt();
  // The server may have restarted since this tab loaded, making the token
  // stale. Refresh it and retry once instead of surfacing "Forbidden".
  if (response.status === 403 && method !== 'GET') {
    const session = await refreshSession();
    if (session && session.token) ({ response, data } = await attempt());
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// --- toasts ----------------------------------------------------------------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind === 'error' ? svg('warning') : kind === 'good' ? svg('check') : ''}<span>${esc(message)}</span>`;
  els.toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s ease, transform .2s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

// --- modal sheets ----------------------------------------------------------

function finishSheetClose() {
  if (sheetCloseTimer) {
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = null;
  }
  if (!els.modalRoot || !els.modalRoot.classList.contains('closing')) return;
  els.modalRoot.className = 'modal-root';
  els.modalRoot.innerHTML = '';
  syncScrollLock();
}

function closeSheet() {
  const root = els.modalRoot;
  document.removeEventListener('keydown', onSheetKey);
  deactivateTrap();
  if (!root || !root.classList.contains('open')) {
    if (root) {
      root.className = 'modal-root';
      root.innerHTML = '';
    }
    syncScrollLock();
    return;
  }
  root.classList.remove('open');
  root.classList.add('closing');
  const sheet = root.querySelector('.sheet');
  if (sheet) sheet.addEventListener('animationend', finishSheetClose, { once: true });
  sheetCloseTimer = setTimeout(finishSheetClose, 260);
  syncScrollLock();
}

function onSheetKey(event) {
  if (event.key === 'Escape') closeSheet();
}

function describeTarget(meta, params) {
  if (params.model) return params.model;
  if (params.label) return params.label;
  if (params.path) return baseName(params.path);
  if (params.target) return meta.label;
  return '';
}

function confirmSheet(meta, params, triggerEl) {
  return new Promise((resolve) => {
    const target = describeTarget(meta, params);
    const dangerous = meta.danger === 'high';
    const impact = triggerEl && triggerEl.dataset ? triggerEl.dataset.impact : null;
    const needType = meta.typeToConfirm || null;
    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = null;
    }
    els.modalRoot.className = 'modal-root open';
    syncScrollLock();
    els.modalRoot.innerHTML = `
      <div class="overlay">
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="sheet-body">
            <div class="sheet-icon ${dangerous ? 'danger' : ''}">${svg(dangerous ? 'warning' : 'bolt')}</div>
            <h2>${esc(meta.label)}${target ? `: ${esc(target)}` : ''}</h2>
            <p>${esc(meta.description || '')}</p>
            ${impact ? `<p class="sheet-note">${esc(impact)}</p>` : ''}
            ${dangerous && !needType ? `<p class="sheet-note">This cannot be undone from here.</p>` : ''}
            ${needType ? `<div class="field"><input type="text" data-confirm-input data-autofocus placeholder="Type “${esc(needType)}” to confirm" autocomplete="off" spellcheck="false" /></div>` : ''}
          </div>
          <div class="sheet-actions">
            <button class="btn" data-sheet-cancel>Cancel</button>
            <button class="btn ${dangerous ? 'danger' : 'primary'}" data-sheet-confirm ${needType ? 'disabled' : ''}>${esc(meta.label)}</button>
          </div>
        </div>
      </div>`;
    document.addEventListener('keydown', onSheetKey);
    const confirmBtn = els.modalRoot.querySelector('[data-sheet-confirm]');
    const input = els.modalRoot.querySelector('[data-confirm-input]');
    if (input) {
      input.addEventListener('input', () => {
        confirmBtn.disabled = input.value.trim().toLowerCase() !== needType.toLowerCase();
      });
    }
    els.modalRoot.querySelector('[data-sheet-cancel]').addEventListener('click', () => { closeSheet(); resolve(false); });
    els.modalRoot.querySelector('.overlay').addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) { closeSheet(); resolve(false); } });
    confirmBtn.addEventListener('click', () => { closeSheet(); resolve(true); });
    activateTrap(els.modalRoot.querySelector('.sheet'));
  });
}

async function startCleanup() {
  let report;
  try {
    report = await fetch('/api/reclaim', { cache: 'no-store' }).then((r) => r.json());
  } catch (error) {
    toast(`Could not scan disk: ${error.message}`, 'error');
    return;
  }
  const items = await cleanupSheet(report);
  if (!items || !items.length) return;
  runAction('system.cleanAll', { items });
}

function cleanupSheet(report) {
  return new Promise((resolve) => {
    const byId = new Map((report.items || []).map((item) => [item.id, item]));
    const partialBytes = (report.partials || []).reduce((sum, p) => sum + (p.bytes || 0), 0);
    const rows = [
      ['ollama-orphans', 'Orphaned Ollama blobs'],
      ['trash', 'Trash'],
      ['brew-cache', 'Homebrew cache'],
      ['npm-cache', 'npm cache'],
      ['pip-cache', 'pip cache'],
      ['partials', 'Partial downloads'],
      ['old-outputs', 'ComfyUI outputs older than 30 days'],
    ]
      .map(([id, label]) => ({ id, label, bytes: id === 'partials' ? partialBytes : byId.get(id)?.bytes || 0 }))
      .filter((row) => row.bytes > 0);

    if (!rows.length) {
      toast('Nothing to clean up, already tidy', 'good');
      resolve(null);
      return;
    }

    const total = rows.reduce((sum, row) => sum + row.bytes, 0);
    const list = rows
      .map(
        (row) => `<label class="clean-item"><input type="checkbox" data-clean="${esc(row.id)}" checked /><span class="clean-name">${esc(row.label)}</span><span class="clean-size">${fmtBytes(row.bytes)}</span></label>`,
      )
      .join('');

    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = null;
    }
    els.modalRoot.className = 'modal-root open';
    els.modalRoot.innerHTML = `
      <div class="overlay">
        <div class="sheet clean-sheet" role="dialog" aria-modal="true">
          <div class="sheet-body">
            <div class="sheet-icon danger">${svg('trash')}</div>
            <h2>Clean up</h2>
            <p>Frees about <strong>${fmtBytes(total)}</strong>. Trashed files stay recoverable.</p>
            <div class="clean-list">${list}</div>
          </div>
          <div class="sheet-actions">
            <button class="btn" data-sheet-cancel>Cancel</button>
            <button class="btn danger" data-sheet-confirm>Clean up</button>
          </div>
        </div>
      </div>`;
    document.addEventListener('keydown', onSheetKey);
    els.modalRoot.querySelector('[data-sheet-cancel]').addEventListener('click', () => { closeSheet(); resolve(null); });
    els.modalRoot.querySelector('.overlay').addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) { closeSheet(); resolve(null); } });
    els.modalRoot.querySelector('[data-sheet-confirm]').addEventListener('click', () => {
      const picked = [...els.modalRoot.querySelectorAll('[data-clean]')].filter((el) => el.checked).map((el) => el.getAttribute('data-clean'));
      closeSheet();
      resolve(picked);
    });
    activateTrap(els.modalRoot.querySelector('.sheet'));
    syncScrollLock();
  });
}

function formSheet(meta) {
  return new Promise((resolve) => {
    const fields = (meta.params || []).filter((p) => p.type === 'text');
    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = null;
    }
    els.modalRoot.className = 'modal-root open';
    syncScrollLock();
    els.modalRoot.innerHTML = `
      <div class="overlay">
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="sheet-body">
            <div class="sheet-icon">${svg('download')}</div>
            <h2>${esc(meta.label)}</h2>
            <p>${esc(meta.description || '')}</p>
            ${fields.map((f) => `<div class="field field-paste"><input type="text" data-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}" />${CAPS.clipboardRead ? '<button type="button" class="btn small plain" data-paste-field title="Paste from clipboard">Paste</button>' : ''}</div>`).join('')}
          </div>
          <div class="sheet-actions">
            <button class="btn" data-sheet-cancel>Cancel</button>
            <button class="btn primary" data-sheet-confirm>${esc(meta.label)}</button>
          </div>
        </div>
      </div>`;
    document.addEventListener('keydown', onSheetKey);
    const first = els.modalRoot.querySelector('input');
    if (first) setTimeout(() => first.focus(), 40);
    const cancel = () => { closeSheet(); resolve(null); };
    els.modalRoot.querySelector('[data-sheet-cancel]').addEventListener('click', cancel);
    els.modalRoot.querySelector('.overlay').addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) cancel(); });
    els.modalRoot.querySelector('[data-sheet-confirm]').addEventListener('click', () => {
      const values = {};
      for (const input of els.modalRoot.querySelectorAll('input[data-field]')) values[input.dataset.field] = input.value.trim();
      closeSheet();
      resolve(values);
    });
  });
}

// --- jobs ------------------------------------------------------------------

const JOB_TITLES = {
  'ollama.pull': (p) => `Pulling ${p.model}`,
  'ollama.remove': (p) => `Deleting ${p.model}`,
  'ollama.removeMany': (p) => `Deleting ${p.count} models`,
  'ollama.benchmark': (p) => `Benchmarking ${p.model}`,
  'cache.prune': (p) => `Pruning ${p.target} cache`,
  'hf.download': (p) => `Downloading ${p.file}`,
  'llama.quantize': (p) => `Quantizing ${String(p.input || '').split('/').pop()}`,
  'brew.install': (p) => `Installing ${p.name}`,
  'brew.uninstall': (p) => `Uninstalling ${p.name}`,
  'brew.upgrade': (p) => `Upgrading ${p.name}`,
  'brew.upgradeAll': () => 'Upgrading all packages',
  'npm.uninstall': (p) => `Uninstalling ${p.name}`,
  'npm.update': (p) => `Updating ${p.name}`,
  'pip.upgrade': (p) => `Updating ${p.name}`,
  'pip.upgradeAll': (p) => `Updating ${p.count} Python packages`,
  'npm.updateAll': () => 'Updating all npm packages',
};

function jobTitle(id, params) {
  const fn = JOB_TITLES[id];
  return fn ? fn(params || {}) : id;
}

function dismissJob(el) {
  if (!el || el.classList.contains('closing')) return;
  el.classList.add('closing');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 240);
}

function addJob(jobId, actionId, params) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `
    <div class="job-head">
      <span class="spinner"></span>
      <span class="job-name">${esc(jobTitle(actionId, params))}</span>
      <button class="btn small plain" data-job-log>Log</button>
      <button class="btn small plain" data-job-close>${svg('xmark')}</button>
    </div>
    <div class="job-log" style="display:none"></div>`;
  els.jobDock.prepend(el);

  const entry = { id: jobId, actionId, params, cursor: 0, status: 'running', el, logEl: el.querySelector('.job-log'), spinner: el.querySelector('.spinner') };
  state.jobs.set(jobId, entry);
  syncWakeLock();
  syncBadge();

  el.querySelector('[data-job-close]').addEventListener('click', () => { state.jobs.delete(jobId); dismissJob(el); syncWakeLock(); syncBadge(); });
  el.querySelector('[data-job-log]').addEventListener('click', () => {
    const open = entry.logEl.style.display !== 'none';
    entry.logEl.style.display = open ? 'none' : 'block';
  });

  pollJob(jobId);
}

async function pollJob(jobId) {
  const entry = state.jobs.get(jobId);
  if (!entry) return;
  let payload;
  try {
    payload = await api(`/api/jobs/${jobId}?cursor=${entry.cursor}`);
  } catch {
    setTimeout(() => pollJob(jobId), 2000);
    return;
  }
  if (payload.output?.length) {
    entry.logEl.textContent += payload.output.join('\n') + '\n';
    entry.logEl.scrollTop = entry.logEl.scrollHeight;
    entry.cursor = payload.cursor;
  }
  entry.status = payload.status;
  if (payload.status === 'running') {
    setTimeout(() => pollJob(jobId), 1200);
    return;
  }
  // finished
  if (entry.spinner) entry.spinner.replaceWith(Object.assign(document.createElement('span'), { className: `pill ${payload.status === 'done' ? 'good' : 'bad'}`, textContent: payload.status === 'done' ? 'Done' : 'Failed' }));
  const triggerEl = pendingActionButtons.get(jobId);
  if (triggerEl) {
    if (payload.status === 'done') markSuccess(triggerEl);
    else markError(triggerEl, payload.error);
    pendingActionButtons.delete(jobId);
  }
  if (payload.status === 'done') {
    toast(`${jobTitle(entry.actionId, entry.params)} finished`, 'good');
    scheduleScan(600);
    refreshAfterAction();
    loadOpenclawStatus();
  } else {
    toast(payload.error || 'Action failed', 'error');
  }
  onJobFinished(entry, payload);
}

// --- action flow -----------------------------------------------------------

// --- inline button state ---------------------------------------------------

const pendingActionButtons = new Map(); // jobId -> button element
const pendingScanButtons = new Set();

function markBusy(el) {
  if (!el || !el.classList || el.dataset.busy === '1') return;
  el.dataset.busy = '1';
  el.dataset.orig = el.innerHTML;
  el.dataset.label = (el.textContent || '').trim();
  el.classList.remove('state-success', 'state-error');
  el.classList.add('state-busy');
  el.disabled = true;
  el.innerHTML = `<span class="spinner"></span>${el.dataset.label ? ` <span>${esc(el.dataset.label)}</span>` : ''}`;
  el.dataset.stateHtml = el.innerHTML;
}

function markSuccess(el, label) {
  if (!el || !el.classList) return;
  el.dataset.busy = '0';
  el.classList.remove('state-busy', 'state-error');
  el.classList.add('state-success');
  el.disabled = false;
  const text = label != null ? label : el.dataset.label;
  el.innerHTML = `${svg('check')}${text ? ` <span>${esc(text)}</span>` : ''}`;
  el.dataset.stateHtml = el.innerHTML;
  setTimeout(() => restoreButton(el), 2500);
}

function markError(el, message) {
  if (!el || !el.classList) return;
  el.dataset.busy = '0';
  el.classList.remove('state-busy', 'state-success');
  el.classList.add('state-error');
  el.disabled = false;
  el.innerHTML = `${svg('warning')}${el.dataset.label ? ` <span>${esc(el.dataset.label)}</span>` : ''}`;
  el.dataset.stateHtml = el.innerHTML;
  if (message) el.title = message;
  setTimeout(() => restoreButton(el), 4000);
}

function restoreButton(el) {
  if (!el || !el.classList) return;
  if (typeof el.isConnected === 'boolean' && !el.isConnected) return; // view re-rendered
  // If the app re-rendered this element while the state was showing, don't
  // clobber its new content with the stale pre-click HTML.
  const unchanged = el.dataset.stateHtml == null || el.innerHTML === el.dataset.stateHtml;
  el.classList.remove('state-busy', 'state-success', 'state-error');
  if (el.dataset.orig != null && unchanged) el.innerHTML = el.dataset.orig;
  el.disabled = false;
  delete el.dataset.busy;
  delete el.dataset.stateHtml;
}

// Wrap any async button handler: busy -> success / error, inline.
async function withButtonState(el, task, options = {}) {
  markBusy(el);
  try {
    const result = await task();
    if (!options.keepBusy) markSuccess(el);
    return result;
  } catch (error) {
    markError(el, error.message);
    if (options.toast !== false) toast(error.message, 'error');
    return undefined;
  }
}

async function runAction(id, params, triggerEl) {
  const meta = state.actions[id];
  if (!meta) return;
  if (state.session.readOnly) return toast('Dashboard is in read-only mode', 'error');

  if (meta.confirm) {
    const ok = await confirmSheet(meta, params, triggerEl);
    if (!ok) return;
  }

  let webauthnGrant;
  if (state.webauthn && state.webauthn.enabled && meta.danger === 'high') {
    try {
      webauthnGrant = await obtainGrant();
    } catch (error) {
      toast(error.name === 'NotAllowedError' ? 'Touch ID cancelled, action not run' : error.message, 'error');
      return;
    }
    if (!webauthnGrant) return;
  } else if (meta.danger === 'high' && !touchIdNudged && touchIdUsable()) {
    touchIdNudged = true;
    toast('Tip: enable “Touch ID for destructive actions” in Profile → Behaviour', '');
  }

  markBusy(triggerEl);
  try {
    const result = await api(`/api/actions/${id}`, { method: 'POST', body: webauthnGrant ? { ...params, webauthnGrant } : params });
    if (triggerEl && triggerEl.hasAttribute && triggerEl.hasAttribute('data-close-panel')) closePanel();
    if (result.jobId) {
      if (triggerEl) pendingActionButtons.set(result.jobId, triggerEl);
      addJob(result.jobId, id, params);
    } else {
      markSuccess(triggerEl);
      toast(result.message || 'Done', 'good');
      scheduleScan(500);
      refreshAfterAction();
      loadOpenclawStatus();
    }
  } catch (error) {
    markError(triggerEl, error.message);
    toast(error.message, 'error');
  }
}

async function openForm(id, triggerEl) {
  const meta = state.actions[id];
  if (!meta) return;
  const values = await formSheet(meta);
  if (!values) return;
  for (const param of meta.params || []) {
    if (param.required && !values[param.name]) return toast(`${param.placeholder || param.name} is required`, 'error');
  }
  runAction(id, values, triggerEl);
}

// --- scan lifecycle --------------------------------------------------------

let scanTimer = null;
function scheduleScan(delay = 800) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(triggerScan, delay);
}

async function triggerScan() {
  try {
    await api('/api/scan', { method: 'POST' });
  } catch {
    /* poll surfaces errors */
  }
  loadInventory();
}

async function loadInventory() {
  try {
    const payload = await fetch('/api/inventory', { cache: 'no-store' }).then((r) => r.json());
    if (payload.error && !payload.data) {
      els.view.innerHTML = `<div class="card"><div class="pad"><strong>Scan failed</strong><pre class="mono" style="white-space:pre-wrap">${esc(payload.error)}</pre></div></div>`;
    }
    if (payload.data && payload.data.generatedAt !== state.renderedAt) {
      state.data = payload.data;
      state.renderedAt = payload.data.generatedAt;
      render();
    }
    if (payload.scanning) {
      setScanStatus(payload.progress ? `${payload.progress}…` : 'Scanning…', true);
      els.refresh.disabled = true;
      setTimeout(loadInventory, 1500);
    } else {
      els.refresh.disabled = false;
      setScanStatus(payload.generatedAt ? `Updated ${relativeTime(payload.generatedAt)}` : 'Idle', false);
      if (pendingScanButtons.size) {
        for (const el of pendingScanButtons) (payload.error ? markError(el, payload.error) : markSuccess(el));
        pendingScanButtons.clear();
      }
    }
  } catch {
    setScanStatus('Offline', false);
  }
}

// --- command palette -------------------------------------------------------

const palette = { open: false, query: '', index: 0, results: [], asyncResults: [], token: 0 };

function paletteBase(query) {
  const commands = VIEWS.map((v) => ({
    group: 'Navigate',
    id: `view:${v.id}`,
    label: v.label,
    icon: v.icon,
    hint: 'Go to',
    run: () => setView(v.id),
  }));
  if (!state.session.readOnly) {
    commands.push({ group: 'Actions', id: 'action:pull', label: 'Pull Ollama model', icon: 'download', run: () => openForm('ollama.pull') });
    commands.push({ group: 'Actions', id: 'action:unloadAll', label: 'Unload all models', icon: 'stop', run: () => runAction('ollama.unloadAll', {}) });
    commands.push({ group: 'Actions', id: 'action:scan', label: 'Rescan machine', icon: 'restart', run: () => triggerScan() });
    commands.push({ group: 'Actions', id: 'action:cleanup', label: 'Clean up everything safe', icon: 'trash', run: () => startCleanup() });
    commands.push({ group: 'Actions', id: 'action:native', label: 'Open as native app', icon: 'app', run: () => runAction('native.launch', {}) });
    commands.push({ group: 'Developer', id: 'action:preview', label: 'Preview states (fresh install)', icon: 'eye', run: () => { devOpen = true; renderDevPanel(); if (!devActive()) { for (const k of DEV_SIM_KEYS) devSim[k] = true; applyDevSim(); } } });
    commands.push({ group: 'Actions', id: 'action:hf', label: 'Download from HuggingFace', icon: 'box', run: () => setView('comfy') });
    commands.push({ group: 'Actions', id: 'action:quantize', label: 'Quantize GGUF file', icon: 'cube', run: () => openForm('llama.quantize') });
    commands.push({ group: 'Actions', id: 'action:openclaw', label: openclawInfo && openclawInfo.paused ? 'Resume OpenClaw' : 'Pause OpenClaw', icon: 'bot', run: () => toggleOpenclaw() });
  }
  commands.push({ group: 'Actions', id: 'action:shortcuts', label: 'Keyboard shortcuts', icon: 'bolt', run: () => showShortcuts() });
  commands.push({ group: 'Actions', id: 'action:settings', label: 'Open settings', icon: 'gears', run: () => openSettings('general') });
  commands.push({ group: 'Capabilities', id: 'cap:install', label: 'Install Vantage as an app', icon: 'app', run: () => promptInstall() });
  commands.push({ group: 'Capabilities', id: 'cap:notify', label: 'Enable browser notifications', icon: 'bell', run: () => enableBrowserNotifications() });
  commands.push({ group: 'Capabilities', id: 'cap:export', label: 'Export inventory (JSON)', icon: 'download', run: () => exportInventory() });
  commands.push({ group: 'Capabilities', id: 'cap:share', label: 'Share this view', icon: 'link', run: () => shareView() });
  commands.push({ group: 'Capabilities', id: 'cap:fullscreen', label: 'Toggle full screen', icon: 'eye', run: () => toggleKiosk() });
  commands.push({ group: 'Capabilities', id: 'cap:screenshot', label: 'Capture a screenshot', icon: 'photo', run: () => captureScreen() });
  commands.push({ group: 'Capabilities', id: 'cap:paste', label: 'Paste clipboard into filter', icon: 'copy', run: () => pasteIntoFilter() });
  commands.push({ group: 'Capabilities', id: 'cap:push', label: state.push && state.push.subscriptions ? 'Disable push notifications' : 'Enable push notifications', icon: 'bell', run: () => togglePush() });
  commands.push({ group: 'Capabilities', id: 'cap:pushtest', label: 'Send a test push', icon: 'bell', run: () => testPush() });

  for (const app of state.data?.apps?.apps || []) {
    commands.push({ group: 'Applications', id: `app:${app.path}`, label: app.name, icon: 'grid', hint: 'App', run: () => showAppDetail(app.path) });
  }
  for (const model of state.data?.ollama?.models || []) {
    commands.push({ group: 'Models', id: `model:${model.name}`, label: model.name, icon: 'brain', hint: 'Model', run: () => setView('ollama') });
  }

  const needle = query.trim().toLowerCase();
  return needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
}

function paletteResults() {
  const query = palette.query.trim().toLowerCase();
  const base = paletteBase(palette.query);
  return query ? base.concat(palette.asyncResults) : base;
}

let paletteSearchTimer = null;
function schedulePaletteSearch(query) {
  clearTimeout(paletteSearchTimer);
  const token = ++palette.token;
  if (query.trim().length < 3) {
    if (palette.asyncResults.length) {
      palette.asyncResults = [];
      renderPalette();
    }
    return;
  }
  paletteSearchTimer = setTimeout(async () => {
    try {
      const data = await fetch(`/api/store/search?q=${encodeURIComponent(query)}&kind=formula`, { cache: 'no-store' }).then((r) => r.json());
      if (token !== palette.token) return;
      palette.asyncResults = (data.results || []).slice(0, 6).map((r) => ({
        group: 'Homebrew',
        id: `brew:${r.name}`,
        label: r.name,
        icon: 'mug',
        hint: r.installed ? 'installed' : 'install',
        run: () => showStoreDetail(r.name, 'formula'),
      }));
      renderPalette();
    } catch {
      /* ignore */
    }
  }, 350);
}

const SHORTCUTS = [
  ['⌘K', 'Open the command palette'],
  ['⌘1–⌘9', 'Jump to a view'],
  ['↑ / ↓', 'Move through rows'],
  ['↵', 'Open the highlighted row'],
  ['right-click', 'Row actions'],
  ['/', 'Focus the filter field'],
  ['r', 'Rescan the machine'],
  ['g then o', 'Go to Overview'],
  ['g then m', 'Go to Models'],
  ['g then d', 'Go to Disk'],
  ['g then s', 'Go to Services'],
  ['g then a', 'Go to Activity'],
  ['?', 'Show this list'],
  ['Esc', 'Close panels and dialogs'],
];

function showShortcuts() {
  const body = `<div class="rows">${SHORTCUTS.map(([keys, desc]) => row({ title: esc(desc), size: `<kbd class="kbd">${esc(keys)}</kbd>`, search: desc })).join('')}</div>`;
  openPanel({ title: 'Keyboard shortcuts', subtitle: 'Getting around', body });
}

function renderPalette() {
  const list = els.paletteRoot.querySelector('#palette-list');
  if (!list) return;
  const results = paletteResults();
  palette.results = results;
  if (palette.index >= results.length) palette.index = Math.max(0, results.length - 1);
  if (!results.length) {
    list.innerHTML = '<div class="palette-empty">No matching commands</div>';
    return;
  }
  let html = '';
  let lastGroup = null;
  results.forEach((cmd, i) => {
    if (cmd.group !== lastGroup) {
      html += `<div class="palette-group-label">${esc(cmd.group)}</div>`;
      lastGroup = cmd.group;
    }
    html += `<div class="palette-item${i === palette.index ? ' selected' : ''}" data-index="${i}">
      <span class="ico">${svg(cmd.icon)}</span><span>${esc(cmd.label)}</span>${cmd.hint ? `<span class="kbd-hint">${esc(cmd.hint)}</span>` : ''}
    </div>`;
  });
  list.innerHTML = html;
  list.querySelectorAll('.palette-item').forEach((el) => {
    el.addEventListener('click', () => runPaletteIndex(Number(el.dataset.index)));
    el.addEventListener('mousemove', () => {
      const idx = Number(el.dataset.index);
      if (idx !== palette.index) {
        palette.index = idx;
        highlightPalette();
      }
    });
  });
}

function highlightPalette() {
  const list = els.paletteRoot.querySelector('#palette-list');
  if (!list) return;
  list.querySelectorAll('.palette-item').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.index) === palette.index);
  });
  const selected = list.querySelector('.palette-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function runPaletteIndex(index) {
  const cmd = palette.results[index];
  if (!cmd) return;
  closePalette();
  cmd.run();
}

function openPalette() {
  if (paletteCloseTimer) {
    clearTimeout(paletteCloseTimer);
    paletteCloseTimer = null;
  }
  palette.open = true;
  palette.query = '';
  palette.index = 0;
  palette.asyncResults = [];
  palette.token += 1;
  els.paletteRoot.className = 'palette-root open';
  els.paletteRoot.innerHTML = `
    <div class="palette-overlay">
      <div class="palette">
        <div class="palette-input">${svg('search')}<input id="palette-input" data-autofocus placeholder="Type a command or search…" autocomplete="off" spellcheck="false" /></div>
        <div class="palette-list" id="palette-list"></div>
      </div>
    </div>`;
  const input = els.paletteRoot.querySelector('#palette-input');
  input.addEventListener('input', () => {
    palette.query = input.value;
    palette.index = 0;
    renderPalette();
    schedulePaletteSearch(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      palette.index = Math.min(palette.index + 1, Math.max(0, palette.results.length - 1));
      highlightPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      palette.index = Math.max(palette.index - 1, 0);
      highlightPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteIndex(palette.index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });
  els.paletteRoot.querySelector('.palette-overlay').addEventListener('click', (event) => {
    if (event.target.classList.contains('palette-overlay')) closePalette();
  });
  renderPalette();
  activateTrap(els.paletteRoot.querySelector('.palette'));
  syncScrollLock();
}

function finishPaletteClose() {
  if (paletteCloseTimer) {
    clearTimeout(paletteCloseTimer);
    paletteCloseTimer = null;
  }
  if (!els.paletteRoot || !els.paletteRoot.classList.contains('closing')) return;
  els.paletteRoot.className = 'palette-root';
  els.paletteRoot.innerHTML = '';
  syncScrollLock();
}

function closePalette() {
  palette.open = false;
  const root = els.paletteRoot;
  deactivateTrap();
  if (!root || !root.classList.contains('open')) {
    if (root) {
      root.className = 'palette-root';
      root.innerHTML = '';
    }
    syncScrollLock();
    return;
  }
  root.classList.remove('open');
  root.classList.add('closing');
  const el = root.querySelector('.palette');
  if (el) el.addEventListener('animationend', finishPaletteClose, { once: true });
  paletteCloseTimer = setTimeout(finishPaletteClose, 240);
  syncScrollLock();
}

// --- events ----------------------------------------------------------------

function openNav() {
  document.body.classList.add('nav-open');
}
function closeNav() {
  document.body.classList.remove('nav-open');
}
function toggleNav() {
  document.body.classList.toggle('nav-open');
}

els.menuBtn.addEventListener('click', toggleNav);
els.navScrim.addEventListener('click', closeNav);

const devRoot = document.getElementById('dev-root');
if (devRoot) {
  devRoot.addEventListener('click', (event) => {
    if (event.target.closest('[data-dev-open]')) {
      devOpen = true;
      renderDevPanel();
      return;
    }
    if (event.target.closest('[data-dev-close]')) {
      devOpen = false;
      renderDevPanel();
      return;
    }
    if (event.target.closest('[data-dev-reset]')) {
      devSim = {};
      applyDevSim();
    }
  });
  devRoot.addEventListener('change', (event) => {
    const el = event.target.closest('[data-dev-key]');
    if (!el) return;
    const key = el.getAttribute('data-dev-key');
    if (key === 'fresh') {
      devSim = {};
      if (el.checked) for (const k of DEV_SIM_KEYS) devSim[k] = true;
    } else {
      devSim[key] = el.checked;
    }
    applyDevSim();
  });
}
if (els.workspaceBtn) els.workspaceBtn.addEventListener('click', () => openSettings('general'));

els.nav.addEventListener('click', (event) => {
  const pin = event.target.closest('[data-pin]');
  if (pin) {
    togglePin(pin.dataset.pin);
    return;
  }
  const item = event.target.closest('[data-view]');
  if (!item) return;
  setView(item.dataset.view);
  closeNav();
});

els.searchTrigger.addEventListener('click', openPalette);

const sidebarToggleBtn = document.getElementById('sidebar-toggle');
if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', toggleSidebar);

// --- keyboard row cursor + native-style context menus ----------------------

const ROW_SELECTOR = '.pkg-row, .model-row.clickable, .row.clickable, tbody tr.clickable, .store-card.clickable';
let rowCursor = null;

function viewRows() {
  if (!els.view) return [];
  return [...els.view.querySelectorAll(ROW_SELECTOR)].filter((el) => el.offsetParent !== null);
}

function setRowCursor(el) {
  if (rowCursor && rowCursor.classList) rowCursor.classList.remove('kb-focus');
  rowCursor = el || null;
  if (rowCursor) {
    rowCursor.classList.add('kb-focus');
    if (rowCursor.scrollIntoView) rowCursor.scrollIntoView({ block: 'nearest' });
  }
}

function moveRowCursor(delta) {
  const rows = viewRows();
  if (!rows.length) return;
  let index;
  if (rowCursor) index = Math.max(0, Math.min(rows.length - 1, rows.indexOf(rowCursor) + delta));
  else index = delta > 0 ? 0 : rows.length - 1;
  setRowCursor(rows[index]);
}

function resetRowCursor() {
  if (rowCursor && rowCursor.classList) rowCursor.classList.remove('kb-focus');
  rowCursor = null;
}

function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'good'), () => toast('Copy failed', 'error'));
  else toast(text);
}

let contextMenuEl = null;
function closeContextMenu() {
  if (!contextMenuEl) return;
  contextMenuEl.remove();
  contextMenuEl = null;
  document.removeEventListener('click', closeContextMenu, true);
  document.removeEventListener('keydown', contextMenuEsc, true);
}
function contextMenuEsc(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeContextMenu();
  }
}
function openContextMenu(x, y, items) {
  closeContextMenu();
  if (!items || !items.length) return;
  const el = document.createElement('div');
  el.className = 'context-menu';
  el.innerHTML = items
    .map((item, i) => `<button class="context-item${item.danger ? ' danger' : ''}" data-ctx="${i}"><span class="ctx-ico">${item.icon ? svg(item.icon) : ''}</span><span>${esc(item.label)}</span></button>`)
    .join('');
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  el.querySelectorAll('[data-ctx]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const item = items[Number(btn.dataset.ctx)];
      closeContextMenu();
      if (item && item.run) item.run();
    }),
  );
  contextMenuEl = el;
  setTimeout(() => document.addEventListener('click', closeContextMenu, true), 0);
  document.addEventListener('keydown', contextMenuEsc, true);
}

function rowContextMenu(target) {
  const at = (sel) => target.closest(sel);
  const copyItem = (label, value) => ({ label, icon: 'copy', run: () => copyText(value) });

  const app = at('[data-app]');
  if (app) {
    const p = app.getAttribute('data-app');
    return [
      { label: 'Open details', icon: 'grid', run: () => selectApp(p) },
      { label: 'Reveal in Finder', icon: 'eye', run: () => runAction('file.reveal', { path: p }) },
      copyItem('Copy path', p),
      !state.session.readOnly ? { label: 'Move to Trash…', icon: 'trash', danger: true, run: () => runAction('app.trash', { path: p }) } : null,
    ].filter(Boolean);
  }
  const brewPkg = at('[data-brew-pkg]');
  if (brewPkg) {
    const name = brewPkg.getAttribute('data-brew-pkg');
    const pkg = (brewState.data?.packages || []).find((p) => p.name === name);
    return [
      { label: 'Open details', icon: 'cube', run: () => selectBrewPkg(name) },
      copyItem('Copy uninstall command', `brew uninstall --${pkg && pkg.kind === 'cask' ? 'cask' : 'formula'} ${name}`),
      pkg && pkg.outdated && !state.session.readOnly ? { label: 'Upgrade', icon: 'upload', run: () => runAction('brew.upgrade', { name }) } : null,
    ].filter(Boolean);
  }
  const pkgRow = at('[data-pkg-name]');
  if (pkgRow) {
    const name = pkgRow.getAttribute('data-pkg-name');
    return [{ label: 'Open details', icon: 'cube', run: () => selectPackage(name) }, copyItem('Copy name', name)];
  }
  const model = at('[data-model]');
  if (model) {
    const name = model.getAttribute('data-model');
    return [{ label: 'Open details', icon: 'brain', run: () => showModelDetail(name) }, copyItem('Copy run command', `ollama run ${name}`)];
  }
  const dir = at('[data-dir]');
  if (dir) {
    const p = dir.getAttribute('data-dir');
    return [
      { label: 'Open folder', icon: 'folder', run: () => loadDisk(p) },
      { label: 'Reveal in Finder', icon: 'eye', run: () => runAction('file.reveal', { path: p }) },
      copyItem('Copy path', p),
    ];
  }
  const storeItem = at('[data-store-item]');
  if (storeItem) {
    const name = storeItem.getAttribute('data-store-item');
    return [{ label: 'Open details', icon: 'box', run: () => showStoreDetail(name, storeItem.getAttribute('data-store-kind') || 'formula') }];
  }
  const service = at('[data-service]');
  if (service) {
    const label = service.getAttribute('data-service');
    return [
      { label: 'Open details', icon: 'gears', run: () => showServiceDetail(label) },
      { label: 'Restart', icon: 'restart', run: () => runAction('service.restart', { label }) },
    ];
  }
  const port = at('[data-port]');
  if (port) {
    const value = port.getAttribute('data-port');
    return [{ label: 'Test connection', icon: 'pulse', run: () => probePort(value) }, copyItem('Copy endpoint', `127.0.0.1:${value}`)];
  }
  const iface = at('[data-iface]');
  if (iface) return [{ label: 'Interface details', icon: 'network', run: () => showInterfaceDetail(iface.getAttribute('data-iface')) }];

  const file = at('[data-file], [data-path]');
  if (file) {
    const p = file.getAttribute('data-file') || file.getAttribute('data-path');
    if (p) {
      return [
        { label: 'Reveal in Finder', icon: 'eye', run: () => runAction('file.reveal', { path: p }) },
        copyItem('Copy path', p),
        !state.session.readOnly ? { label: 'Move to Trash…', icon: 'trash', danger: true, run: () => runAction('file.trash', { path: p }) } : null,
      ].filter(Boolean);
    }
  }
  const generic = at('.row[data-search], tbody tr[data-search], .pkg-row[data-search]');
  if (generic) {
    const title = (generic.querySelector('.row-title, .pkg-name') || {}).textContent || generic.dataset.search || '';
    return [copyItem('Copy name', title.trim())];
  }
  return null;
}

const GOTO = { o: 'overview', m: 'ollama', d: 'storage', s: 'services', a: 'activity', c: 'comfy', b: 'brew', t: 'store', l: 'apps', p: 'packages', g: 'agent', e: 'security', n: 'notify', r: 'runtimes' };
let awaitingG = false;
let gTimer = null;

document.addEventListener('keydown', (event) => {
  const tag = (event.target && event.target.tagName ? event.target.tagName : '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (event.target && event.target.isContentEditable);

  if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
    event.preventDefault();
    palette.open ? closePalette() : openPalette();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
    const view = VIEWS[Number(event.key) - 1];
    if (view) {
      event.preventDefault();
      setView(view.id);
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && String(event.key).toLowerCase() === 'd') {
    event.preventDefault();
    toggleDevPanel();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (event.key === 'Escape') {
    if (palette.open) closePalette();
    else if (document.body.classList.contains('nav-open')) closeNav();
    return;
  }
  if (typing || palette.open || event.metaKey || event.ctrlKey || event.altKey) {
    awaitingG = false;
    clearTimeout(gTimer);
    return;
  }
  if (awaitingG) {
    awaitingG = false;
    clearTimeout(gTimer);
    const destination = GOTO[String(event.key).toLowerCase()];
    if (destination) {
      event.preventDefault();
      setView(destination);
    }
    return;
  }
  if (event.key === 'g') {
    awaitingG = true;
    clearTimeout(gTimer);
    gTimer = setTimeout(() => {
      awaitingG = false;
    }, 1400);
    return;
  }
  if (event.key === '/') {
    event.preventDefault();
    if (els.filter) els.filter.focus();
    return;
  }
  if (event.key === '?') {
    event.preventDefault();
    showShortcuts();
    return;
  }
  if (String(event.key).toLowerCase() === 'r') {
    event.preventDefault();
    triggerScan();
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveRowCursor(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveRowCursor(-1);
    return;
  }
  if (event.key === 'Enter' && rowCursor) {
    event.preventDefault();
    rowCursor.click();
    return;
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 820 && document.body.classList.contains('nav-open')) closeNav();
});

// Heal a stale token when the tab regains focus (e.g. after a server restart).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshSession();
    loadOpenclawStatus();
  }
});

els.view.addEventListener('contextmenu', (event) => {
  const items = rowContextMenu(event.target);
  if (!items) return;
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY, items);
});

els.view.addEventListener('click', (event) => {
  if (event.target.closest('#openclaw-toggle')) {
    toggleOpenclaw();
    return;
  }
  const rangeBtn = event.target.closest('[data-range]');
  if (rangeBtn) {
    monitorRange = Number(rangeBtn.dataset.range) || monitorRange;
    loadMonitor();
    return;
  }
  const netRangeBtn = event.target.closest('[data-net-range]');
  if (netRangeBtn) {
    netRange = Number(netRangeBtn.getAttribute('data-net-range')) || netRange;
    loadNetwork();
    return;
  }
  const pingBtn = event.target.closest('[data-ping]');
  if (pingBtn) {
    withButtonState(pingBtn, () => runPing(pingBtn.getAttribute('data-ping')), { toast: false });
    return;
  }
  const portBtn = event.target.closest('[data-port-check]');
  if (portBtn) {
    withButtonState(portBtn, () => runPortCheck(), { toast: false });
    return;
  }
  const tile = event.target.closest('[data-tm-path]');
  if (tile) {
    const target = tile.getAttribute('data-tm-path');
    if (tile.getAttribute('data-tm-dir') === '1') loadDisk(target);
    else runAction('file.reveal', { path: target });
    return;
  }
  const up = event.target.closest('[data-disk-up]');
  if (up) {
    loadDisk(up.getAttribute('data-disk-up'));
    return;
  }
  const healthBtn = event.target.closest('[data-health-refresh]');
  if (healthBtn) {
    withButtonState(healthBtn, () => loadHealth());
    return;
  }
  const securityBtn = event.target.closest('[data-security-refresh]');
  if (securityBtn) {
    withButtonState(securityBtn, () => loadSecurity());
    return;
  }
  const logJump = event.target.closest('[data-log-jump]');
  if (logJump) {
    jumpToLog(logJump.getAttribute('data-log-jump'));
    return;
  }
  const logSource = event.target.closest('[data-log]');
  if (logSource) {
    logState.path = logSource.getAttribute('data-log');
    logState.lines = [];
    loadLogs();
    return;
  }
  const logRefresh = event.target.closest('[data-log-refresh]');
  if (logRefresh) {
    withButtonState(logRefresh, () => loadLogs());
    return;
  }
  if (event.target.closest('[data-log-follow]')) {
    logState.follow = !logState.follow;
    if (logState.follow) startLogFollow();
    else stopLogFollow();
    loadLogs();
    return;
  }
  const notifySave = event.target.closest('[data-notify-save]');
  if (notifySave) {
    withButtonState(notifySave, () => saveNotify());
    return;
  }
  const notifyTest = event.target.closest('[data-notify-test]');
  if (notifyTest) {
    withButtonState(notifyTest, () => testNotify(notifyTest.getAttribute('data-notify-test')));
    return;
  }
  const hfSearchBtn = event.target.closest('[data-hf-search]');
  if (hfSearchBtn) {
    withButtonState(hfSearchBtn, () => hfSearch());
    return;
  }
  const hfRepo = event.target.closest('[data-hf-repo]');
  if (hfRepo) {
    hfOpenRepo(hfRepo.getAttribute('data-hf-repo'));
    return;
  }
  const hfDownloadBtn = event.target.closest('[data-hf-download]');
  if (hfDownloadBtn) {
    hfDownload(hfDownloadBtn.getAttribute('data-hf-download'), hfDownloadBtn);
    return;
  }
  const comfyInterruptBtn = event.target.closest('[data-comfy-interrupt]');
  if (comfyInterruptBtn) {
    withButtonState(comfyInterruptBtn, () => comfyInterrupt());
    return;
  }
  const comfyClearBtn = event.target.closest('[data-comfy-clear]');
  if (comfyClearBtn) {
    withButtonState(comfyClearBtn, () => comfyClearQueue());
    return;
  }
  const undoBtn = event.target.closest('[data-undo]');
  if (undoBtn) {
    withButtonState(undoBtn, () => api(`/api/undo/${undoBtn.getAttribute('data-undo')}`, { method: 'POST', body: {} })).then(() => loadHistory());
    return;
  }
  const copyBtn = event.target.closest('[data-copy]');
  if (copyBtn) {
    handleCopyButton(copyBtn);
    return;
  }
  const cleanupBtn = event.target.closest('[data-cleanup]');
  if (cleanupBtn) {
    startCleanup();
    return;
  }
  const ollamaProfile = event.target.closest('[data-ollama-profile]');
  if (ollamaProfile) {
    runAction('maintenance.ollamaProfile', { profile: ollamaProfile.getAttribute('data-ollama-profile') });
    return;
  }
  if (event.target.closest('[data-add-rule]')) {
    addRule();
    return;
  }
  if (event.target.closest('[data-seed-rules]')) {
    api('/api/rules', { method: 'POST', body: { seed: true } })
      .then((data) => toast(data.seeded ? `Added ${data.seeded} common rule${data.seeded === 1 ? '' : 's'}` : 'Common rules already present', 'good'), (error) => toast(error.message, 'error'))
      .then(() => loadMaintenance());
    return;
  }
  const ruleToggle = event.target.closest('[data-rule-toggle]');
  if (ruleToggle) {
    api('/api/rules', { method: 'POST', body: { id: ruleToggle.getAttribute('data-rule-toggle'), enabled: ruleToggle.getAttribute('data-enabled') === '1' } }).then(() => loadMaintenance(), (error) => toast(error.message, 'error'));
    return;
  }
  const ruleDelete = event.target.closest('[data-rule-delete]');
  if (ruleDelete) {
    api('/api/rules', { method: 'POST', body: { delete: ruleDelete.getAttribute('data-rule-delete') } }).then(() => loadMaintenance(), (error) => toast(error.message, 'error'));
    return;
  }
  const schedulePresetBtn = event.target.closest('[data-schedule-preset]');
  if (schedulePresetBtn) {
    schedulePreset(schedulePresetBtn.getAttribute('data-schedule-preset'));
    return;
  }
  const taskToggle = event.target.closest('[data-task-toggle]');
  if (taskToggle) {
    api('/api/schedule', { method: 'POST', body: { id: taskToggle.getAttribute('data-task-toggle'), enabled: taskToggle.getAttribute('data-enabled') === '1' } }).then(() => loadMaintenance(), (error) => toast(error.message, 'error'));
    return;
  }
  const taskDelete = event.target.closest('[data-task-delete]');
  if (taskDelete) {
    api('/api/schedule', { method: 'POST', body: { delete: taskDelete.getAttribute('data-task-delete') } }).then(() => loadMaintenance(), (error) => toast(error.message, 'error'));
    return;
  }
  const scanBtn = event.target.closest('[data-scan]');
  if (scanBtn) {
    markBusy(scanBtn);
    pendingScanButtons.add(scanBtn);
    triggerScan();
    return;
  }
  const formBtn = event.target.closest('[data-form]');
  if (formBtn) {
    openForm(formBtn.dataset.form, formBtn);
    return;
  }
  const act = event.target.closest('[data-act]');
  if (act) {
    handleActButton(act);
    return;
  }
  const appRow = event.target.closest('[data-app]');
  if (appRow) {
    selectApp(appRow.getAttribute('data-app'));
    return;
  }
  const appsFilter = event.target.closest('[data-apps-filter]');
  if (appsFilter) {
    appsState.filter = appsFilter.getAttribute('data-apps-filter');
    renderAppsList();
    return;
  }
  const brewPkg = event.target.closest('[data-brew-pkg]');
  if (brewPkg) {
    selectBrewPkg(brewPkg.getAttribute('data-brew-pkg'));
    return;
  }
  const brewFilter = event.target.closest('[data-brew-filter]');
  if (brewFilter) {
    brewState.filter = brewFilter.getAttribute('data-brew-filter');
    renderBrew();
    return;
  }
  const pkgRow = event.target.closest('[data-pkg-name]');
  if (pkgRow) {
    selectPackage(pkgRow.getAttribute('data-pkg-name'));
    return;
  }
  const packagesSource = event.target.closest('[data-packages-source]');
  if (packagesSource) {
    packagesState.source = packagesSource.getAttribute('data-packages-source');
    ensurePackageSelection();
    renderPackages();
    return;
  }
  const storeItem = event.target.closest('[data-store-item]');
  if (storeItem) {
    showStoreDetail(storeItem.getAttribute('data-store-item'), storeItem.getAttribute('data-store-kind') || 'formula');
    return;
  }
  const procBtn = event.target.closest('[data-proc]');
  if (procBtn) {
    try {
      showProcessDetail(JSON.parse(procBtn.getAttribute('data-proc')));
    } catch {
      /* ignore */
    }
    return;
  }
  const largest = event.target.closest('[data-largest]');
  if (largest) {
    withButtonState(largest, () => showLargestFiles(largest.getAttribute('data-largest')));
    return;
  }
  if (event.target.closest('[data-store-open]')) {
    setView('store');
    return;
  }
  const goto = event.target.closest('[data-goto]');
  if (goto) {
    setView(goto.getAttribute('data-goto'));
    return;
  }
  const kindBtn = event.target.closest('[data-store-kind-btn]');
  if (kindBtn) {
    setStoreKind(kindBtn.getAttribute('data-store-kind-btn'));
    return;
  }
  const storeSearchBtn = event.target.closest('[data-store-search]');
  if (storeSearchBtn) {
    withButtonState(storeSearchBtn, () => storeSearch());
    return;
  }

  if (openRowDetail(event)) return;
});

// --- side panel ------------------------------------------------------------

function onPanelKey(event) {
  if (event.key === 'Escape') closePanel();
}

// --- focus management ------------------------------------------------------

let trapContainer = null;
let trapPrevious = null;
let trapBound = false;

function focusables(container) {
  return [...container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

function onTrapKey(event) {
  if (!trapContainer || event.key !== 'Tab') return;
  const list = focusables(trapContainer);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function activateTrap(container) {
  if (!container) return;
  trapPrevious = document.activeElement;
  trapContainer = container;
  if (!trapBound) {
    document.addEventListener('keydown', onTrapKey, true);
    trapBound = true;
  }
  const target = container.querySelector('[data-autofocus]') || focusables(container)[0] || container;
  if (target === container && !container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => target.focus({ preventScroll: true }));
}

function deactivateTrap() {
  trapContainer = null;
  const previous = trapPrevious;
  trapPrevious = null;
  if (previous && previous.isConnected && previous.focus) requestAnimationFrame(() => previous.focus({ preventScroll: true }));
}

const panelStack = [];

let panelCloseTimer = null;
let sheetCloseTimer = null;
let paletteCloseTimer = null;

// Lock background scrolling while any overlay (sheet, palette, side panel) is up.
function syncScrollLock() {
  const isOpen = (el) => Boolean(el && (el.classList.contains('open') || el.classList.contains('closing')));
  if (document.body) document.body.classList.toggle('modal-open', isOpen(els.panelRoot) || isOpen(els.modalRoot) || isOpen(els.paletteRoot));
}

function cancelPanelClose() {
  if (panelCloseTimer) {
    clearTimeout(panelCloseTimer);
    panelCloseTimer = null;
  }
  if (els.panelRoot && els.panelRoot.classList.contains('closing')) {
    els.panelRoot.className = 'panel-root';
    els.panelRoot.innerHTML = '';
  }
}

function finishPanelClose() {
  if (panelCloseTimer) {
    clearTimeout(panelCloseTimer);
    panelCloseTimer = null;
  }
  if (!els.panelRoot || !els.panelRoot.classList.contains('closing')) return;
  els.panelRoot.className = 'panel-root';
  els.panelRoot.innerHTML = '';
  syncScrollLock();
}

function openPanel(descriptor) {
  if (!els.panelRoot) return;
  cancelPanelClose();
  const key = (descriptor.key || descriptor.title || '').toLowerCase();
  const top = panelStack[panelStack.length - 1];
  // Refreshing the current panel (e.g. skeleton → content) replaces it instead
  // of stacking a duplicate.
  if (top && (top.key || top.title || '').toLowerCase() === key) {
    panelStack[panelStack.length - 1] = { ...descriptor, key };
    renderPanel();
    return;
  }
  const isRoot = panelStack.length === 0;
  if (isRoot) document.addEventListener('keydown', onPanelKey);
  panelStack.push({ ...descriptor, key });
  renderPanel();
  if (isRoot) activateTrap(els.panelRoot.querySelector('.panel'));
  syncScrollLock();
}

function renderPanel() {
  const descriptor = panelStack[panelStack.length - 1];
  if (!descriptor) return closePanel();
  const { title, subtitle, body, actions } = descriptor;
  const hadFocus = Boolean(els.panelRoot.querySelector('.panel')?.contains(document.activeElement));

  // Create the sliding shell only once; later renders update it in place so the
  // open animation doesn't replay on every content refresh.
  let panel = els.panelRoot.querySelector('.panel');
  if (!panel) {
    els.panelRoot.className = 'panel-root open';
    els.panelRoot.innerHTML = `
      <div class="panel-scrim" data-panel-close></div>
      <aside class="panel" role="dialog" aria-modal="true" tabindex="-1">
        <div class="panel-head"></div>
        <div class="panel-body"></div>
        <div class="panel-foot"></div>
      </aside>`;
    panel = els.panelRoot.querySelector('.panel');
  }
  panel.setAttribute('aria-label', title);
  panel.querySelector('.panel-head').innerHTML = `
    ${panelStack.length > 1 ? `<button class="panel-back" data-panel-back aria-label="Back">${svg('back')}</button>` : ''}
    <div class="panel-title"><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
    <button class="panel-close" data-panel-close aria-label="Close" data-autofocus>${svg('xmark')}</button>`;
  panel.querySelector('.panel-body').innerHTML = body;
  panel.querySelector('.panel-foot').innerHTML = actions || '';
  if (trapContainer) trapContainer = panel;
  if (hadFocus) {
    const target = panel.querySelector('[data-autofocus]') || focusables(panel)[0];
    if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }
}

function closePanel() {
  const root = els.panelRoot;
  panelStack.length = 0;
  document.removeEventListener('keydown', onPanelKey);
  deactivateTrap();
  if (!root || !root.classList.contains('open')) {
    if (root) {
      root.className = 'panel-root';
      root.innerHTML = '';
    }
    syncScrollLock();
    return;
  }
  root.classList.remove('open');
  root.classList.add('closing');
  const panel = root.querySelector('.panel');
  if (panel) panel.addEventListener('animationend', finishPanelClose, { once: true });
  panelCloseTimer = setTimeout(finishPanelClose, 280);
  syncScrollLock();
}

function handleActButton(el) {
  let params = {};
  try {
    params = JSON.parse(el.dataset.params || '{}');
  } catch {
    /* ignore */
  }
  runAction(el.dataset.act, params, el);
}

function handleCopyButton(btn) {
  const text = btn.getAttribute('data-copy');
  const original = btn.innerHTML;
  const finish = (ok) => {
    if (!ok) {
      toast('Copy failed', 'error');
      return;
    }
    btn.innerHTML = svg('check');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('copied');
    }, 1200);
    toast('Copied to clipboard', 'good');
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => finish(true), () => finish(false));
  else toast(text);
}

function panelActions(path, extra = []) {
  return [
    `<button class="btn small primary" data-act="app.open" data-params='${esc(JSON.stringify({ path }))}'>Open</button>`,
    `<button class="btn small" data-act="file.reveal" data-params='${esc(JSON.stringify({ path }))}'>Reveal</button>`,
    ...extra,
  ].join('');
}

async function showAppDetail(appPath) {
  openPanel({ title: baseName(appPath).replace(/\.app$/, ''), subtitle: 'Loading…', body: skeletonRows(5) });
  try {
    const info = await fetchAppDetail(appPath);
    openPanel({ title: info.name || baseName(appPath), subtitle: info.bundleId || info.path, body: appDetailBody(info), actions: panelActions(info.path, appDetailActions(info)) });
  } catch (error) {
    openPanel({ title: baseName(appPath).replace(/\.app$/, ''), subtitle: 'Error', body: `<div class="empty-note">${esc(error.message)}</div>` });
  }
}

els.panelRoot.addEventListener('click', (event) => {
  if (event.target.closest('[data-panel-close]')) {
    closePanel();
    return;
  }
  if (event.target.closest('[data-panel-back]')) {
    panelStack.pop();
    renderPanel();
    const panel = els.panelRoot.querySelector('.panel');
    if (panel) requestAnimationFrame(() => panel.focus());
    return;
  }
  const accent = event.target.closest('[data-pref-accent]');
  if (accent) {
    setPref('accent', accent.getAttribute('data-pref-accent'));
    for (const swatch of els.panelRoot.querySelectorAll('[data-pref-accent]')) swatch.classList.toggle('active', swatch === accent);
    return;
  }
  const toggle = event.target.closest('[data-pref-toggle]');
  if (toggle) {
    const key = toggle.getAttribute('data-pref-toggle');
    if (['notifyBrowser', 'wakeLock', 'idlePause', 'touchId'].includes(key)) {
      handleBoolPref(toggle, key, toggle.checked);
      return;
    }
    const value = key === 'density' ? (toggle.checked ? 'compact' : 'comfortable') : key === 'material' ? (toggle.checked ? 'glass' : 'solid') : toggle.checked ? 'reduce' : 'auto';
    setPref(key, value);
    return;
  }
  const logJump = event.target.closest('[data-log-jump]');
  if (logJump) {
    closePanel();
    jumpToLog(logJump.getAttribute('data-log-jump'));
    return;
  }
  const openUrl = event.target.closest('[data-open-url]');
  if (openUrl) {
    window.open(openUrl.getAttribute('data-open-url'));
    return;
  }
  const revealPath = event.target.closest('[data-reveal-path]');
  if (revealPath) {
    runAction('file.reveal', { path: revealPath.getAttribute('data-reveal-path') });
    return;
  }
  const probe = event.target.closest('[data-port-probe]');
  if (probe) {
    probePort(probe.getAttribute('data-port-probe'));
    return;
  }
  const hfOpen = event.target.closest('[data-hf-open-repo]');
  if (hfOpen) {
    closePanel();
    setView('comfy');
    hfOpenRepo(hfOpen.getAttribute('data-hf-open-repo'));
    return;
  }
  const pingHost = event.target.closest('[data-ping-host]');
  if (pingHost) {
    closePanel();
    setView('network');
    setTimeout(() => runPing(pingHost.getAttribute('data-ping-host')), 350);
    return;
  }
  const diskExplore = event.target.closest('[data-disk-explore]');
  if (diskExplore) {
    closePanel();
    setView('storage');
    loadDisk(diskExplore.getAttribute('data-disk-explore'));
    return;
  }
  const largestBtn = event.target.closest('[data-largest]');
  if (largestBtn) {
    closePanel();
    withButtonState(largestBtn, () => showLargestFiles(largestBtn.getAttribute('data-largest')));
    return;
  }
  if (openRowDetail(event)) return;
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    handleCopyButton(copy);
    return;
  }
  const act = event.target.closest('[data-act]');
  if (act) handleActButton(act);
});

els.refresh.addEventListener('click', () => {
  if (!state.session.readOnly) {
    markBusy(els.refresh);
    pendingScanButtons.add(els.refresh);
    triggerScan();
  } else {
    loadInventory();
  }
});

if (els.updateChip) {
  els.updateChip.addEventListener('click', (event) => {
    if (event.target.closest('[data-update-apply]')) applyUpdate();
  });
}

if (els.footVersion) {
  els.footVersion.addEventListener('click', (event) => {
    if (event.target.closest('[data-update-open]')) openSettings('about');
  });
}

els.modalRoot.addEventListener('click', (event) => {
  if (event.target.closest('[data-update-dismiss]')) closeUpdateOverlay();
  if (event.target.closest('[data-update-reload]')) location.reload();
});

els.filter.addEventListener('input', () => {
  state.filter = els.filter.value;
  applyFilter();
});

els.view.addEventListener('change', (event) => {
  if (event.target.id === 'hf-dir') hfState.dir = event.target.value;
  if (event.target.closest('[data-brew-hidedeps]')) {
    brewState.hideDeps = event.target.checked;
    renderBrew();
  }
  const loginItem = event.target.closest('[data-login-item]');
  if (loginItem) {
    runAction('maintenance.loginItem', { name: loginItem.getAttribute('data-login-item'), enabled: loginItem.checked }).then(() => loadMaintenance(), () => loadMaintenance());
  }
});

els.view.addEventListener('input', (event) => {
  if (event.target.id === 'brew-search') {
    brewState.query = event.target.value;
    renderBrew();
  }
  if (event.target.id === 'apps-search') {
    appsState.query = event.target.value;
    renderAppsList();
  }
  if (event.target.id === 'packages-search') {
    packagesState.query = event.target.value;
    renderPackagesList();
  }
});

els.view.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.target.id === 'hf-query') {
    event.preventDefault();
    hfSearch();
  } else if (event.target.id === 'store-query') {
    event.preventDefault();
    storeSearch();
  }
});

// App icons fall back to a neutral glyph if a bundle has no extractable icon.
els.view.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img && img.tagName === 'IMG' && (img.classList.contains('app-icon') || img.classList.contains('app-icon-lg')) && img.src !== APP_ICON_FALLBACK) {
      img.src = APP_ICON_FALLBACK;
    }
  },
  true,
);

// Device photos fall back to the drawn illustration when offline / unavailable.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('device-img') && img.parentElement) {
      img.parentElement.innerHTML = `<div class="device-art-wrap">${deviceArt(img.getAttribute('data-device') || '')}</div>`;
    } else if (img && img.tagName === 'IMG' && img.classList.contains('folder-ico') && img.parentElement) {
      img.parentElement.innerHTML = svg(FOLDER_ICONS[img.getAttribute('data-folder')] || 'folder');
    } else if (img && img.tagName === 'IMG' && img.classList.contains('file-ico') && img.parentElement) {
      img.parentElement.innerHTML = svg(img.getAttribute('data-fallback') || 'file');
    }
  },
  true,
);

window.addEventListener('hashchange', () => {
  const next = location.hash.replace(/^#/, '');
  if (next && next !== state.view) {
    state.view = next;
    renderNav();
    navigate(renderView);
  }
});

// --- browser capabilities --------------------------------------------------
//
// Progressive enhancement layered on top of the (server-side) privileged work:
// PWA offline shell, browser notifications + app badge, screen wake lock while
// jobs run, clipboard read, File System Access exports, Web Share, kiosk mode,
// idle-pause, screen capture, and an optional Touch ID gate for destructive
// actions. All are feature-detected; nothing here is required for the app to run.

const NATIVE = typeof window !== 'undefined' && window.vantageNative && window.vantageNative.available ? window.vantageNative : null;
let nativeTouchIdAvailable = false;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

const CAPS = {
  serviceWorker: 'serviceWorker' in navigator,
  native: Boolean(NATIVE),
  notifications: NATIVE ? true : typeof Notification !== 'undefined',
  badge: NATIVE ? true : 'setAppBadge' in navigator,
  wakeLock: NATIVE ? true : 'wakeLock' in navigator,
  fileSystemAccess: NATIVE ? true : typeof window.showSaveFilePicker === 'function',
  webShare: NATIVE ? true : typeof navigator.share === 'function',
  clipboardRead: NATIVE ? true : Boolean(navigator.clipboard && navigator.clipboard.readText),
  credentials: typeof window.PublicKeyCredential !== 'undefined',
  idleDetection: NATIVE ? true : 'IdleDetector' in window,
  capture: Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
  persistentStorage: Boolean(navigator.storage && navigator.storage.persist),
  push: NATIVE ? false : 'serviceWorker' in navigator && 'PushManager' in window,
};

// True when already running as an installed app (Dock/PWA window).
function isStandalone() {
  return Boolean((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
}

state.idle = false;
let persistentState = null; // null until probed
let installPrompt = null;
let wakeLock = null;

// Ask the browser to keep Vantage's shell in persistent storage. Called only
// from an explained onboarding/Settings action, never automatically on load.
async function ensurePersistentStorage() {
  if (!CAPS.persistentStorage) return false;
  try {
    persistentState = await navigator.storage.persisted();
    if (!persistentState) persistentState = await navigator.storage.persist();
    return persistentState === true;
  } catch {
    return false;
  }
}
let jobFailures = 0;
let touchIdNudged = false;

const dateStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// --- clipboard -------------------------------------------------------------

async function readClipboard() {
  if (NATIVE) {
    try { return await NATIVE.readClipboard(); } catch { return null; }
  }
  if (!CAPS.clipboardRead) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

async function pasteInto(input) {
  const text = await readClipboard();
  if (text == null) {
    toast('Clipboard read blocked, allow it in the browser prompt', 'error');
    return;
  }
  input.value = text.trim();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function pasteIntoFilter() {
  const text = await readClipboard();
  if (text == null) return toast('Clipboard read blocked', 'error');
  els.filter.value = text.trim();
  state.filter = els.filter.value;
  applyFilter();
  els.filter.focus();
}

// --- file exports (File System Access → download fallback) ------------------

async function saveFile(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (NATIVE) {
    try {
      const result = await NATIVE.saveFile(name, arrayBufferToBase64(await blob.arrayBuffer()));
      if (result && result.cancelled) return false;
      toast(`Saved ${name}`, 'good');
      return true;
    } catch (error) {
      toast(error.message, 'error');
      return false;
    }
  }
  if (CAPS.fileSystemAccess) {
    try {
      const ext = `.${name.split('.').pop()}`;
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.slice(1).toUpperCase(), accept: { [type]: [ext] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast(`Saved ${handle.name}`, 'good');
      return true;
    } catch (error) {
      if (error && error.name === 'AbortError') return false;
      /* fall through to a plain download */
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Downloaded ${name}`, 'good');
  return true;
}

async function exportInventory() {
  const source = state.data || (await api('/api/inventory')).data;
  await saveFile(`vantage-inventory-${dateStamp()}.json`, JSON.stringify(source, null, 2), 'application/json');
}

// --- notifications + badge -------------------------------------------------

async function ensureNotifyPermission() {
  if (NATIVE) return true;
  if (!CAPS.notifications) {
    toast('Notifications are not supported here', 'error');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    showNotifyHelp();
    return false;
  }
  const result = await Notification.requestPermission();
  if (result !== 'granted') showNotifyHelp();
  return result === 'granted';
}

function browserNotify(title, body) {
  if (!prefs.notifyBrowser) return;
  if (NATIVE) {
    NATIVE.notify(title, body).catch(() => {});
    return;
  }
  if (!CAPS.notifications || Notification.permission !== 'granted') return;
  if (!document.hidden) return; // you're already looking at it
  try {
    const note = new Notification(title, { body, tag: 'vantage-job' });
    note.onclick = () => { window.focus(); note.close(); };
  } catch {
    /* some browsers require a service worker for constructor notifications */
  }
}

async function enableBrowserNotifications() {
  const ok = await ensureNotifyPermission();
  if (!ok) return;
  await patchSettings({ 'behavior.notifyBrowser': true });
  toast('Browser notifications enabled', 'good');
}

// Show a notification from the page itself, immediate visual confirmation that
// browser notifications render, independent of the push service.
function swReady(timeoutMs = 4000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('service worker not ready')), timeoutMs)),
  ]);
}

// Returns true when the browser accepted the notification. It cannot detect an
// OS-level mute (System Settings → Notifications / Focus), so callers should
// word success as "sent" rather than a guarantee it was seen.
async function previewBrowserNotification() {
  if (NATIVE) {
    await NATIVE.notify('Vantage test', 'If you can see this, notifications work.');
    return true;
  }
  if (!CAPS.notifications) throw new Error('Notifications are not supported here');
  const ok = await ensureNotifyPermission();
  if (!ok) throw new Error('Notification permission denied');
  const title = 'Vantage test';
  const options = {
    body: 'If you can see this, this browser can display notifications.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Unique tag so repeated tests re-alert instead of replacing silently.
    tag: `vantage-test-${Date.now()}`,
  };
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      const registration = await swReady();
      await registration.showNotification(title, options);
      const live = await registration.getNotifications({ tag: options.tag }).catch(() => null);
      return !live || live.length > 0;
    }
  } catch {
    /* fall through to the constructor */
  }
  new Notification(title, options);
  return true;
}

function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Safari/')) return 'Safari';
  return 'your browser';
}

// Browsers only ask once; after a "Block" the user must change it themselves.
function showNotifyHelp() {
  const name = browserName();
  const steps = name === 'Safari'
    ? ['Open Safari → Settings → Websites → Notifications.', 'Find “localhost:8790” and set it to “Allow”.', 'Reload this page.']
    : [`In ${name}, click the site-controls icon in the address bar (lock / tune).`, 'Set Notifications to “Allow”.', 'Reload this page.'];
  openPanel({
    title: 'Allow notifications',
    subtitle: `${name} has notifications blocked for Vantage`,
    body: `<div class="rows">${steps.map((s, i) => row({ title: `${i + 1}. ${s}`, search: s })).join('')}</div><p class="settings-note">Browsers prompt only once, after a “Block” it has to be re-enabled here. In the native Mac app, notifications work without this step.</p>`,
  });
}

function syncBadge() {
  let running = 0;
  for (const entry of state.jobs.values()) if (entry.status === 'running') running += 1;
  const total = running + jobFailures;
  if (NATIVE) {
    try { NATIVE.setBadge(total).catch(() => {}); } catch { /* ignore */ }
    return;
  }
  if (!CAPS.badge) return;
  try {
    if (total) navigator.setAppBadge(total);
    else navigator.clearAppBadge();
  } catch {
    /* ignore */
  }
}

window.addEventListener('focus', () => {
  if (jobFailures) {
    jobFailures = 0;
    syncBadge();
  }
});

function onJobFinished(entry, payload) {
  const label = jobTitle(entry.actionId, entry.params);
  if (payload.status === 'done') {
    browserNotify('Vantage, job finished', label);
  } else {
    jobFailures += 1;
    browserNotify('Vantage, job failed', `${label}: ${payload.error || 'failed'}`);
  }
  syncWakeLock();
  syncBadge();
}

// --- screen wake lock ------------------------------------------------------

async function acquireWakeLock() {
  if (NATIVE) {
    if (prefs.wakeLock) NATIVE.wakeLock(true).catch(() => {});
    return;
  }
  if (!CAPS.wakeLock || !prefs.wakeLock || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (NATIVE) {
    NATIVE.wakeLock(false).catch(() => {});
    return;
  }
  if (!wakeLock) return;
  try {
    wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function syncWakeLock() {
  const running = [...state.jobs.values()].some((entry) => entry.status === 'running');
  if (running) acquireWakeLock();
  else releaseWakeLock();
}

// --- share / kiosk ---------------------------------------------------------

async function shareView() {
  const title = els.viewTitle ? els.viewTitle.textContent.trim() : 'Vantage';
  if (NATIVE) {
    try { await NATIVE.share(`${title} · ${location.origin}`); } catch { /* cancelled */ }
    return;
  }
  if (!CAPS.webShare) return toast('Sharing is not available in this browser', 'error');
  try {
    await navigator.share({ title: `Vantage, ${title}`, text: `${title} · ${location.origin}` });
  } catch {
    /* user cancelled */
  }
}

function toggleKiosk() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => toast('Full screen was blocked', 'error'));
  } else toast('Full screen is not available here', 'error');
}

// --- idle pause ------------------------------------------------------------

let idleGranted = false;
let idlePermissionState = 'not asked'; // 'not asked' | 'granted' | 'denied' | 'unsupported'
let idleDetectorReady = false;
let idleFallbackAttached = false;
let idleNativeTimer = null;

async function refreshIdlePermission() {
  if (NATIVE) {
    idleGranted = true;
    idlePermissionState = 'granted';
    return;
  }
  if (!CAPS.idleDetection || typeof IdleDetector === 'undefined') {
    idlePermissionState = 'unsupported';
    return;
  }
  try {
    const status = await navigator.permissions.query({ name: 'idle-detection' });
    idlePermissionState = status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'not asked';
    idleGranted = idlePermissionState === 'granted';
  } catch {
    idlePermissionState = 'not asked';
  }
}

async function idlePermissionGranted() {
  await refreshIdlePermission();
  return idleGranted;
}

// Request the idle-detection permission. Only ever called from an explicit,
// explained action (the onboarding permissions step, or Settings), never on
// load, so the browser prompt always arrives with context.
async function enableIdleDetection() {
  if (NATIVE) return true;
  if (!CAPS.idleDetection || typeof IdleDetector === 'undefined') {
    idlePermissionState = 'unsupported';
    return false;
  }
  try {
    const result = await IdleDetector.requestPermission();
    idlePermissionState = result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'not asked';
    if (result !== 'granted') return false;
    idleGranted = true;
    await initIdle();
    return true;
  } catch {
    idlePermissionState = 'denied';
    return false;
  }
}

async function initIdle() {
  if (!prefs.idlePause) return;
  if (NATIVE) {
    idlePermissionState = 'granted';
    if (idleNativeTimer) return;
    idleNativeTimer = setInterval(() => {
      NATIVE.idleSeconds()
        .then((seconds) => {
          state.idle = seconds > 120;
          document.body.classList.toggle('idle', state.idle);
        })
        .catch(() => {});
    }, 30_000);
    return;
  }
  // Only use the OS detector when the permission is already granted, otherwise
  // fall back to tab visibility. We never prompt here.
  await refreshIdlePermission();
  if (idleGranted) {
    if (idleDetectorReady) return;
    try {
      const detector = new IdleDetector();
      detector.addEventListener('change', () => {
        state.idle = detector.userState === 'idle';
        document.body.classList.toggle('idle', state.idle);
        if (!state.idle) renderView();
      });
      await detector.start({ threshold: 120_000 });
      idleDetectorReady = true;
      return;
    } catch {
      /* fall through to visibility heuristic */
    }
  }
  if (idleFallbackAttached) return;
  idleFallbackAttached = true;
  document.addEventListener('visibilitychange', () => {
    state.idle = document.hidden;
    document.body.classList.toggle('idle', state.idle);
  });
}

// --- Touch ID / passkeys ---------------------------------------------------

function touchIdUsable() {
  return nativeTouchIdAvailable || (CAPS.credentials && location.hostname === 'localhost');
}

const TOUCHID_HINT = 'Open Vantage via http://localhost to use Touch ID (passkeys do not work on IP addresses)';

function b64url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// The server (lib/webauthn.js) verifies registration and every assertion; the
// client only brokers the platform-authenticator prompt and carries the grant.
async function registerTouchId() {
  if (nativeTouchIdAvailable) {
    const enrolled = await NATIVE.touchIdEnroll();
    await api('/api/webauthn/native/register', { method: 'POST', body: { name: 'Touch ID', publicKey: b64url(fromB64url(enrolled.publicKey)) } });
    state.webauthn = { enabled: true, credentialCount: 1 };
    return;
  }
  const options = await api('/api/webauthn/register/options', { method: 'POST', body: {} });
  const pk = options.publicKey;
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: fromB64url(pk.challenge),
      rp: pk.rp,
      user: { id: fromB64url(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      pubKeyCredParams: pk.pubKeyCredParams,
      authenticatorSelection: pk.authenticatorSelection,
      timeout: pk.timeout,
      attestation: pk.attestation,
    },
  });
  if (!credential) throw new Error('no credential returned');
  const transports = credential.response.getTransports ? credential.response.getTransports() : [];
  await api('/api/webauthn/register/verify', {
    method: 'POST',
    body: {
      challengeId: options.challengeId,
      attestationObject: b64url(credential.response.attestationObject),
      clientDataJSON: b64url(credential.response.clientDataJSON),
      transports,
    },
  });
  state.webauthn = { enabled: true, credentialCount: 1 };
}

async function disableTouchId(grant) {
  await api('/api/webauthn/disable', { method: 'POST', body: grant ? { webauthnGrant: grant } : {} });
  state.webauthn = { enabled: false, credentialCount: 0 };
}

async function obtainGrant() {
  if (nativeTouchIdAvailable) {
    let options;
    try {
      options = await api('/api/webauthn/native/options', { method: 'POST', body: {} });
    } catch {
      // No native key enrolled yet: enroll (Touch ID), then retry once.
      await registerTouchId();
      options = await api('/api/webauthn/native/options', { method: 'POST', body: {} });
    }
    const signed = await NATIVE.touchIdSign(options.challenge);
    const result = await api('/api/webauthn/native/verify', { method: 'POST', body: { challengeId: options.challengeId, credentialId: options.credentialId, signature: b64url(fromB64url(signed.signature)) } });
    return result && result.grant ? result.grant : null;
  }
  const options = await api('/api/webauthn/auth/options', { method: 'POST', body: {} });
  const pk = options.publicKey;
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: fromB64url(pk.challenge),
      allowCredentials: (pk.allowCredentials || []).map((c) => ({ id: fromB64url(c.id), type: 'public-key', transports: c.transports })),
      userVerification: pk.userVerification || 'required',
      timeout: pk.timeout || 60_000,
    },
  });
  if (!assertion) return null;
  const result = await api('/api/webauthn/auth/verify', {
    method: 'POST',
    body: {
      challengeId: options.challengeId,
      credentialId: b64url(assertion.rawId),
      authenticatorData: b64url(assertion.response.authenticatorData),
      clientDataJSON: b64url(assertion.response.clientDataJSON),
      signature: b64url(assertion.response.signature),
    },
  });
  return result && result.grant ? result.grant : null;
}

async function handleBoolPref(toggle, key, checked) {
  if (key === 'notifyBrowser' && checked) {
    const ok = await ensureNotifyPermission();
    if (!ok) {
      toggle.checked = false;
      return;
    }
  }
  if (key === 'touchId') {
    if (checked) {
      if (!touchIdUsable()) {
        toggle.checked = false;
        return toast(TOUCHID_HINT, 'error');
      }
      try {
        await registerTouchId();
        toast('Touch ID registered, destructive actions now require it', 'good');
      } catch (error) {
        toggle.checked = false;
        if (error.name !== 'NotAllowedError') toast(`Touch ID setup failed: ${error.message}`, 'error');
        return;
      }
    } else {
      try {
        await disableTouchId();
        toast('Touch ID gating disabled', 'good');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  }
  if (key === 'wakeLock') {
    if (checked) acquireWakeLock();
    else releaseWakeLock();
  }
  if (key === 'idlePause' && checked) enableIdleDetection().catch(() => {});
  setPref(key, checked);
}

// --- screen capture --------------------------------------------------------

async function captureScreen() {
  if (!CAPS.capture) return toast('Screen capture is not supported here', 'error');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
  } catch {
    return;
  }
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) await saveFile(`vantage-screen-${dateStamp()}.png`, blob, 'image/png');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

// --- PWA install + service worker ------------------------------------------

async function promptInstall() {
  if (!installPrompt) {
    const safari = /^((?!chrome|android|crios|edg).)*safari/i.test(navigator.userAgent);
    toast(safari ? 'Safari: choose File → Add to Dock' : 'Use your browser’s “Install app” option', '');
    return;
  }
  installPrompt.prompt();
  const choice = await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  if (choice && choice.outcome === 'accepted') toast('Installing Vantage…', 'good');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  try { localStorage.setItem('vantage.pwa-installed', '1'); } catch { /* ignore */ }
  api('/api/installed', { method: 'POST', body: {} }).catch(() => {});
  toast('Vantage installed', 'good');
  if (els.onboardingRoot && els.onboardingRoot.classList.contains('open')) renderOnboarding('none');
});

// Native shell: no WebKit context menu (Reload/Inspect…) on chrome. Text fields
// keep it so paste/spell-check still work, and the app's own row menus still fire.
if (NATIVE) {
  document.addEventListener('contextmenu', (event) => {
    const el = event.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    event.preventDefault();
  });
}

async function registerServiceWorker() {
  if (!CAPS.serviceWorker) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    /* offline shell unavailable; the app still works */
  }
}

// --- capability inventory (shown in the profile panel) ---------------------

function capabilityRows() {
  const rows = [
    ['Offline / service worker', CAPS.serviceWorker],
    ['Native bridge', CAPS.native],
    ['Installable app (PWA)', CAPS.serviceWorker],
    ['Browser notifications', CAPS.notifications],
    ['App badge', CAPS.badge],
    ['Web Push', CAPS.push],
    ['Push subscriptions', Boolean(state.push && state.push.subscriptions)],
    ['Screen wake lock', CAPS.wakeLock],
    ['File System Access exports', CAPS.fileSystemAccess],
    ['Web Share', CAPS.webShare],
    ['Clipboard read', CAPS.clipboardRead],
    ['Touch ID / passkeys', touchIdUsable()],
    ['Touch ID enforced', Boolean(state.webauthn && state.webauthn.enabled)],
    ['Idle detection', CAPS.idleDetection],
    ['Persistent storage', persistentState === true],
    ['Screen capture', CAPS.capture],
  ];
  return rows
    .map(([label, ok]) => row({ title: esc(label), badge: ok ? pill('available', 'good') : pill('n/a', ''), search: label }))
    .join('');
}

// --- Web Push (client) -----------------------------------------------------

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// Subscribing with a key that differs from an existing subscription throws in
// Firefox ("A subscription with a different application server key already
// exists"). If the server's VAPID key rotated, drop the stale one and re-subscribe.
// Every await is time-boxed so the wizard can never spin forever waiting on the
// service worker or a slow push service.
async function subscribePush() {
  const status = await withTimeout(api('/api/push/status'), 8000, 'Could not reach the Vantage server');
  await registerServiceWorker();
  const registration = await swReady(8000);
  const desired = fromB64url(status.publicKey);
  let subscription = await withTimeout(registration.pushManager.getSubscription(), 5000, 'Push manager did not respond').catch(() => null);
  if (subscription) {
    const existing = subscription.options && subscription.options.applicationServerKey
      ? new Uint8Array(subscription.options.applicationServerKey)
      : null;
    // Rotate when the server key changed, or when the browser hides the old key.
    if (!existing || !sameBytes(existing, desired)) {
      await withTimeout(subscription.unsubscribe(), 5000, 'Could not reset the old subscription').catch(() => {});
      subscription = null;
    }
  }
  if (!subscription) {
    subscription = await withTimeout(
      registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: desired }),
      20000,
      'Timed out contacting the push service. Check your connection and try again.',
    );
  }
  await withTimeout(api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() }), 8000, 'Could not save the subscription');
  state.push = { subscriptions: 1, publicKey: status.publicKey };
  return subscription;
}

async function enablePush() {
  if (!CAPS.push) return toast('Push is not supported here', 'error');
  try {
    await subscribePush();
    toast('Push notifications enabled', 'good');
  } catch (error) {
    toast(`Could not enable push: ${error.message}`, 'error');
  }
}

async function disablePush() {
  try {
    const registration = await swReady(8000);
    const subscription = await withTimeout(registration.pushManager.getSubscription(), 5000, 'Push manager did not respond').catch(() => null);
    if (subscription) {
      await withTimeout(api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } }), 8000, 'Could not reach the Vantage server').catch(() => {});
      await withTimeout(subscription.unsubscribe(), 5000, 'Could not remove the subscription').catch(() => {});
    }
    state.push = { subscriptions: 0, publicKey: state.push && state.push.publicKey };
    toast('Push notifications disabled', 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function togglePush() {
  if (state.push && state.push.subscriptions > 0) await disablePush();
  else await enablePush();
}

async function testPush() {
  const result = await api('/api/push/test', { method: 'POST', body: {} });
  const sent = Array.isArray(result.results) ? result.results.length : 0;
  toast(sent ? `Push sent to ${sent} subscription(s)` : 'No push subscriptions yet', sent ? 'good' : '');
}

// --- drag & drop ingest ----------------------------------------------------

function hasFiles(event) {
  return Boolean(event.dataTransfer && [...(event.dataTransfer.types || [])].includes('Files'));
}

function initDragDrop() {
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `<div class="drop-card">${svg('upload')}<div><strong>Drop to ingest</strong><span>Files are copied into data/uploads</span></div></div>`;
  document.body.appendChild(overlay);
  let depth = 0;
  const show = (on) => overlay.classList.toggle('active', on);
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    show(true);
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    show(false);
    handleDroppedFiles([...event.dataTransfer.files]);
  });
}

async function handleDroppedFiles(files) {
  const list = files.filter(Boolean).slice(0, 20);
  if (!list.length) return;
  if (state.session.readOnly) return toast('Dashboard is in read-only mode', 'error');
  const results = [];
  for (const file of list) {
    if (file.size > 48 * 1024 * 1024) {
      results.push({ name: file.name, error: 'too large (max 48 MB)' });
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      const data = await api('/api/upload', { method: 'POST', body: { name: file.name, dataB64: b64url(buffer) } });
      results.push({ name: file.name, path: data.path, size: data.size, detail: data.detail });
    } catch (error) {
      results.push({ name: file.name, error: error.message });
    }
  }
  showIngestResults(results);
}

function showIngestResults(results) {
  const body = `<div class="rows">${results
    .map((r) =>
      r.error
        ? row({ title: esc(r.name), sub: esc(r.error), badge: pill('skipped', 'bad'), search: r.name })
        : row({
            title: esc(r.name),
            sub: `${fmtBytes(r.size)} · ${esc((r.detail && (r.detail.type || r.detail.kind)) || 'file')}`,
            size: fmtBytes(r.size),
            actions: `<button class="btn small" data-act="file.reveal" data-params='${esc(JSON.stringify({ path: r.path }))}'>Reveal</button>`,
            search: r.name,
          }),
    )
    .join('')}</div>`;
  const stored = results.filter((r) => !r.error).length;
  openPanel({ title: 'Ingested files', subtitle: `${stored} stored in data/uploads`, body });
}

async function initCapabilities() {
  registerServiceWorker();
  if (CAPS.persistentStorage) {
    try {
      persistentState = await navigator.storage.persisted();
    } catch {
      persistentState = false;
    }
  }
  try {
    await syncSettings();
  } catch {
    state.webauthn = { enabled: false, credentialCount: 0 };
    state.push = { subscriptions: 0, publicKey: null };
  }
  if (NATIVE && typeof NATIVE.touchIdAvailable === 'function') {
    try { const info = await NATIVE.touchIdAvailable(); nativeTouchIdAvailable = Boolean(info && info.available); } catch { nativeTouchIdAvailable = false; }
  }
  if (prefs.idlePause) initIdle();
  else refreshIdlePermission().catch(() => {});
  initDragDrop();
  syncWakeLock();
  syncBadge();
  try {
    const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
    state.boot = h.boot || null;
    if (h.version) state.update = { ...(state.update || {}), version: h.version };
  } catch {
    /* server not up yet */
  }
  renderVersion();
  checkForUpdate();
  setInterval(() => { if (!document.hidden) checkForUpdate(); }, 6 * 60 * 60 * 1000);
}

els.modalRoot.addEventListener('click', (event) => {
  const paste = event.target.closest('[data-paste-field]');
  if (!paste) return;
  const input = paste.parentElement.querySelector('input[data-field]');
  if (input) pasteInto(input);
});

// --- settings surface ------------------------------------------------------

const settingsState = { data: null, section: 'general', profile: null, loading: false, error: null, notify: null, notifyLoading: false, notifyTried: false, dataInfo: null, dataInfoLoading: false, dataInfoTried: false };
const onboardingState = { server: null, step: 0, profile: null };
const setupState = { data: null, loading: false, folders: {} };

async function loadSetup(reRender = true) {
  if (setupState.loading) return;
  setupState.loading = true;
  try { setupState.data = await api('/api/setup'); } catch { /* keep prior */ }
  setupState.loading = false;
  if (reRender && els.onboardingRoot && els.onboardingRoot.classList.contains('open')) renderOnboarding('none');
}

// Probing Full Disk Access reads ~/Library/Mail, which makes macOS show its
// "access data from other apps" prompt. Only ever called from an explicit
// Re-check click, never while a step renders.
async function loadSetupFda() {
  try {
    const { fullDiskAccess } = await api('/api/setup/full-disk-access');
    setupState.data = { ...(setupState.data || {}), fullDiskAccess };
  } catch { /* keep prior */ }
  if (els.onboardingRoot && els.onboardingRoot.classList.contains('open')) renderOnboarding('none');
}

function settingsCaps() {
  return { notifications: CAPS.notifications, push: CAPS.push, wakeLock: CAPS.wakeLock };
}

function settingsReason(key) {
  if (key === 'push') return 'needs an installed PWA with Push support';
  if (key === 'notifications') return 'browser notifications are unavailable here';
  if (key === 'wakeLock') return 'screen wake lock is unavailable here';
  return 'not supported in this browser';
}

function sectionLabel(id) {
  const section = settingsState.data && settingsState.data.sections.find((s) => s.id === id);
  return section ? section.label : id;
}

function registryFor(section) {
  return (settingsState.data ? settingsState.data.registry : []).filter((e) => e.section === section);
}

function registryEntry(id) {
  return (settingsState.data ? settingsState.data.registry : []).find((e) => e.id === id);
}

function touchIdControl() {
  if (!touchIdUsable()) return '<span class="sr-help">Open via localhost</span>';
  const enabled = settingsState.data.capabilityState.webauthn.enabled;
  return enabled
    ? '<button class="btn small" data-touchid="disable">Disable</button>'
    : '<button class="btn small primary" data-touchid="enable">Enable</button>';
}

const prettyOption = (value) => esc(String(value).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));

function settingControl(entry, value, caps) {
  if (entry.type === 'boolean') {
    const disabled = entry.requires && !caps[entry.requires];
    return `<label class="switch"><input type="checkbox" data-setting-toggle="${esc(entry.id)}" ${value ? 'checked' : ''}${disabled ? ' disabled' : ''}><span class="switch-track"></span></label>`;
  }
  if (entry.id === 'appearance.accent') {
    const names = ['system', ...Object.keys(ACCENTS)];
    return `<div class="settings-swatches">${names.map((name) => `<button class="accent-swatch${value === name ? ' active' : ''}" type="button" data-setting-accent="${esc(name)}" title="${esc(name)}" aria-label="${esc(name)}" style="background:${name === 'system' ? systemAccentColor() : ACCENTS[name][0]}"></button>`).join('')}</div>`;
  }
  if (entry.type === 'select') {
    if (entry.options.length <= 5) {
      return `<div class="segmented">${entry.options.map((o) => `<button type="button" class="seg${o === value ? ' active' : ''}" data-setting-seg="${esc(entry.id)}" data-value="${esc(o)}">${prettyOption(o)}</button>`).join('')}</div>`;
    }
    return `<select class="settings-select" data-setting-select="${esc(entry.id)}">${entry.options.map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${prettyOption(o)}</option>`).join('')}</select>`;
  }
  if (entry.type === 'number') return `<input class="settings-input" type="number" data-setting-input="${esc(entry.id)}" value="${esc(value)}">`;
  if (entry.type === 'text') return `<input class="settings-input" type="text" data-setting-input="${esc(entry.id)}" value="${esc(value == null ? '' : value)}">`;
  if (entry.type === 'status') return touchIdControl();
  return '';
}

function settingRow(entry, caps) {
  const value = settingsState.data.values[entry.id];
  const disabled = entry.requires && !caps[entry.requires];
  const help = disabled ? `Unavailable here, ${settingsReason(entry.requires)}` : entry.help;
  return `<div class="settings-row">${entry.icon ? `<span class="sr-ico">${svg(entry.icon)}</span>` : ''}<div class="sr-main"><div class="sr-title">${esc(entry.label)}</div>${help ? `<div class="sr-help">${esc(help)}</div>` : ''}</div><div class="sr-control">${settingControl(entry, value, caps)}</div></div>`;
}

function settingsRows(section) {
  const caps = settingsCaps();
  return registryFor(section).map((entry) => settingRow(entry, caps)).join('');
}

async function loadNotifyInfo() {
  if (settingsState.notifyLoading || settingsState.notifyTried) return;
  settingsState.notifyLoading = true;
  settingsState.notifyTried = true;
  try { settingsState.notify = await api('/api/notify'); } catch { /* keep */ }
  settingsState.notifyLoading = false;
  if (state.view === 'settings' && settingsState.section === 'notifications') renderSettingsSection();
}

async function loadDataInfo() {
  if (settingsState.dataInfoLoading || settingsState.dataInfoTried) return;
  settingsState.dataInfoLoading = true;
  settingsState.dataInfoTried = true;
  try { settingsState.dataInfo = await api('/api/settings/data'); } catch { /* keep */ }
  settingsState.dataInfoLoading = false;
  if (state.view === 'settings' && settingsState.section === 'data') renderSettingsSection();
}

function setTestStatus(button, text, ok) {
  const row = button.closest('.settings-test-row');
  const el = row && row.querySelector('[data-test-status]');
  if (!el) return;
  el.textContent = text || '';
  el.className = `settings-test-status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
}

async function checkForUpdate(manual = false) {
  try {
    const data = await api('/api/update');
    const wasAvailable = state.update && state.update.available;
    state.update = { ...data, checked: true };
    renderUpdateChip();
    renderVersion();
    if (state.view === 'settings' && settingsState.section === 'about') renderSettingsSection();
    if (manual) {
      if (!data.supported) toast('This install is not a git checkout, so it cannot self-update.', '');
      else if (data.available) toast(`Update available: ${data.behind} commit${data.behind === 1 ? '' : 's'} behind.`, '');
      else toast(`Vantage is up to date (${data.current || 'local'}).`, 'good');
    } else if (data.available && !wasAvailable) {
      toast(`A Vantage update is available (${data.behind} commit${data.behind === 1 ? '' : 's'}).`, '');
    }
  } catch (error) {
    if (manual) toast(`Update check failed: ${error.message}`, 'error');
  }
  renderVersion();
}

function versionLabel(u = state.update || {}) {
  const raw = u.version || '0.9.0-beta';
  return `v${raw.replace(/-beta$/, '')} beta`;
}

function renderVersion() {
  if (!els.footVersion) return;
  const u = state.update || {};
  const build = u.current ? ` · ${u.current}` : '';
  const hint = u.available ? `${u.behind} update${u.behind === 1 ? '' : 's'} available` : 'up to date';
  els.footVersion.innerHTML = `<button class="foot-version-btn" type="button" data-update-open title="Vantage ${esc(versionLabel(u))}${build} · ${hint}">${esc(versionLabel(u))}${esc(build)}</button>`;
}

function renderUpdateChip() {
  if (!els.updateChip) return;
  const u = state.update || {};
  if (!u.available) { els.updateChip.innerHTML = ''; return; }
  els.updateChip.innerHTML = `<button class="update-chip" data-update-apply title="Update available: ${esc(u.subject || '')}">${svg('download')}<span>Update</span></button>`;
}

const UPDATE_STEPS = [
  ['pull', 'Pull the latest changes', 'download'],
  ['deps', 'Refresh dependencies', 'box'],
  ['native', 'Rebuild the native app', 'app'],
  ['restart', 'Restart the service', 'restart'],
  ['reconnect', 'Reconnect', 'pulse'],
];

function showUpdateOverlay() {
  if (!els.modalRoot) return;
  if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
  els.modalRoot.className = 'modal-root open';
  syncScrollLock();
  els.modalRoot.innerHTML = `
    <div class="overlay">
      <div class="update-card" role="alertdialog" aria-modal="true" aria-live="polite">
        <div class="update-glyph"><span class="update-spinner"></span>${svg('download')}</div>
        <h2 class="update-title">Updating Vantage</h2>
        <p class="update-sub">Pulling changes, refreshing dependencies and rebuilding the native app when needed.</p>
        <ul class="update-steps">
          ${UPDATE_STEPS.map(([id, label, icon]) => `<li class="update-step" data-step="${id}" data-state="pending"><span class="us-mark">${svg(icon)}</span><span class="us-label">${label}</span></li>`).join('')}
        </ul>
        <div class="update-changes" data-update-changes hidden></div>
        <p class="update-note" data-update-note hidden></p>
      </div>
    </div>`;
}

function setUpdateStep(id, stepState) {
  const el = els.modalRoot && els.modalRoot.querySelector(`.update-step[data-step="${id}"]`);
  if (!el) return;
  el.dataset.state = stepState;
  const mark = el.querySelector('.us-mark');
  if (!mark) return;
  if (!mark.dataset.icon) mark.dataset.icon = mark.innerHTML;
  if (stepState === 'done') mark.innerHTML = svg('check');
  else if (stepState === 'failed') mark.innerHTML = svg('warning');
  else mark.innerHTML = mark.dataset.icon;
}

function setUpdateTitle(title, sub) {
  const t = els.modalRoot && els.modalRoot.querySelector('.update-title');
  const s = els.modalRoot && els.modalRoot.querySelector('.update-sub');
  if (t && title) t.textContent = title;
  if (s && sub) s.textContent = sub;
}

function showUpdateError(message) {
  const card = els.modalRoot && els.modalRoot.querySelector('.update-card');
  if (card) card.classList.add('failed');
  const note = els.modalRoot && els.modalRoot.querySelector('[data-update-note]');
  if (note) {
    note.hidden = false;
    note.innerHTML = `${esc(message)} <span class="update-error-actions"><button class="btn small primary" type="button" data-update-reload>Reload</button><button class="btn small" type="button" data-update-dismiss>Close</button></span>`;
  }
}

function closeUpdateOverlay() {
  if (!els.modalRoot) return;
  els.modalRoot.className = 'modal-root';
  els.modalRoot.innerHTML = '';
  syncScrollLock();
}

// Waits until the server reports a new boot id, which means the update restarted it.
async function waitForRestart(previousBoot, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (!previousBoot || (data.boot && data.boot !== previousBoot)) return data;
      }
    } catch {
      /* server is restarting */
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return null;
}

async function applyUpdate() {
  const u = state.update || {};
  const ok = await confirmSheet({
    label: 'Update Vantage',
    description: `Pull ${u.behind || 'the latest'} new commit${u.behind === 1 ? '' : 's'} and restart. The dashboard reconnects automatically.`,
    danger: 'medium',
  }, {}, null);
  if (!ok) return;

  if (!state.boot) {
    try { state.boot = (await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json())).boot || null; } catch {}
  }
  const previousBoot = state.boot;

  showUpdateOverlay();
  setUpdateStep('pull', 'active');

  let result;
  try {
    result = await api('/api/update/apply', { method: 'POST', body: {} });
  } catch (error) {
    setUpdateStep('pull', 'failed');
    showUpdateError(`Update failed: ${error.message}`);
    return;
  }

  setUpdateStep('pull', 'done');
  setUpdateStep('deps', result.depsChanged ? 'done' : 'skip');
  setUpdateStep('native', result.nativeBuilt ? 'done' : (result.nativeChanged ? 'failed' : 'skip'));
  if (result.commits && result.commits.length) {
    const box = els.modalRoot && els.modalRoot.querySelector('[data-update-changes]');
    if (box) {
      const shown = result.commits.slice(0, 6);
      const more = result.commits.length - shown.length;
      box.hidden = false;
      box.innerHTML = `<div class="uc-title">What's new</div><ul>${shown.map((c) => `<li><span>${esc(c.subject)}</span><code class="mono">${esc(c.hash)}</code></li>`).join('')}</ul>${more > 0 ? `<div class="uc-more">+${more} more</div>` : ''}`;
    }
  }
  setUpdateStep('restart', 'active');
  setUpdateTitle('Restarting Vantage', 'Bringing the new version back online.');

  const slowTimer = setTimeout(() => {
    setUpdateTitle('Still restarting…', 'The server is taking longer than usual to come back.');
  }, 8000);

  const health = await waitForRestart(previousBoot, 30_000);
  clearTimeout(slowTimer);
  if (!health) {
    setUpdateStep('restart', 'failed');
    showUpdateError('Could not confirm the restart. Reload the page to continue.');
    return;
  }
  state.boot = health.boot || null;

  setUpdateStep('restart', 'done');
  setUpdateStep('reconnect', 'active');
  setUpdateTitle('Updated', 'Reloading the dashboard…');
  setUpdateStep('reconnect', 'done');
  await new Promise((resolve) => setTimeout(resolve, 900));
  location.reload();
}

function changelogBody(data) {
  const sections = (data && data.sections) || [];
  if (!sections.length) return `<div class="empty-note">No changes recorded yet.</div>`;
  return `<div class="changelog">${sections.map((section) => `
    <div class="changelog-section">
      <div class="changelog-head">
        <span class="changelog-version">${esc(section.version)}</span>
        ${section.unreleased ? '<span class="pill accent">unreleased</span>' : ''}
        ${section.date ? `<span class="changelog-date">${esc(section.date)}</span>` : ''}
      </div>
      ${section.groups.map((group) => `
        <div class="changelog-group">
          <div class="changelog-group-title">${svg(group.icon)}<span>${esc(group.label)}</span><span class="changelog-count">${group.entries.length}</span></div>
          <ul class="changelog-list">
            ${group.entries.map((entry) => `<li>${entry.scope ? `<span class="changelog-scope">${esc(entry.scope)}</span>` : ''}<span>${esc(entry.text)}</span><a class="changelog-hash mono" href="${esc(data.repoUrl || '')}/commit/${esc(entry.hash)}" target="_blank" rel="noopener">${esc(entry.hash)}</a></li>`).join('')}
          </ul>
        </div>`).join('')}
    </div>`).join('')}</div>`;
}

async function openChangelog() {
  openPanel({ title: "What's new", subtitle: 'Changes to Vantage', body: skeletonRows(5) });
  try {
    const data = await api('/api/changelog');
    openPanel({ title: "What's new", subtitle: `${versionLabel()} · generated from git history`, body: changelogBody(data) });
  } catch (error) {
    openPanel({ title: "What's new", subtitle: 'Error', body: `<div class="empty-note">${esc(error.message)}</div>` });
  }
}

async function openDiagnostics() {
  openPanel({ title: 'Diagnostics', subtitle: 'Server internals', body: skeletonRows(5) });
  try {
    const data = await api('/api/diagnostics');
    openPanel({ title: 'Diagnostics', subtitle: 'Server internals', body: `<pre class="mono" style="white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0;padding:0 18px 18px">${esc(JSON.stringify(data, null, 2))}</pre>` });
  } catch (error) {
    openPanel({ title: 'Diagnostics', subtitle: 'Error', body: `<div class="empty-note">${esc(error.message)}</div>` });
  }
}

function settingsGroup(title, inner) {
  return `<div class="settings-group">${title ? `<div class="settings-group-title">${esc(title)}</div>` : ''}<div class="settings-rows">${inner}</div></div>`;
}

function sInfoRow(icon, title, sub, control) {
  return `<div class="settings-row"><span class="sr-ico">${svg(icon)}</span><div class="sr-main"><div class="sr-title">${esc(title)}</div>${sub ? `<div class="sr-help">${esc(sub)}</div>` : ''}</div><div class="sr-control">${control || ''}</div></div>`;
}

function settingsGeneral() {
  const d = settingsState.data;
  const p = settingsState.profile || {};
  const system = (state.data && state.data.system) || {};
  const setup = setupState.data || {};
  const disk = system.disk || {};
  const meta = d.meta || {};
  const caps = d.capabilityState || {};
  const copy = (text, label) => `<button class="btn small icon" data-copy="${esc(text)}" title="Copy ${esc(label)}">${svg('copy')}</button>`;
  const serverHost = `${location.hostname || '127.0.0.1'}:${location.port || '8790'}`;
  const diskValue = disk.totalBytes ? `${fmtBytes(disk.freeBytes)} free <span class="faint">of ${fmtBytes(disk.totalBytes)} · ${disk.usedPercent}% used</span>` : '–';
  return `
    <div class="settings-hero">
      <div class="settings-hero-art">${deviceBadge(system.model)}</div>
      <div class="settings-hero-copy"><strong>${esc(system.model || 'Mac')}</strong><span>${esc([system.chip, system.physicalMemoryLabel, system.macos].filter(Boolean).join(' · '))}</span></div>
    </div>
    ${settingsGroup('This Mac', [
      sInfoRow('cpu', 'Chip', null, esc(system.chip || '–')),
      sInfoRow('memory', 'Memory', null, esc(system.physicalMemoryLabel || (system.memoryBytes ? fmtBytes(system.memoryBytes) : '–'))),
      sInfoRow('disk', 'Disk', null, diskValue),
      sInfoRow('app', 'macOS', null, esc(system.macos || p.macos || '–')),
      sInfoRow('key', 'Serial number', null, `<span class="mono">${esc(system.serialNumber || '–')}</span>${system.serialNumber ? copy(system.serialNumber, 'serial number') : ''}`),
    ].join(''))}
    ${settingsGroup('User', [
      sInfoRow('user', 'Name', null, esc(p.fullName || p.username || '–')),
      sInfoRow('user', 'Username', null, `${esc(p.username || '–')} ${p.admin ? pill('admin', 'accent') : ''}`),
      sInfoRow('folder', 'Home', null, `<span class="mono">${esc(p.home || '–')}</span>${p.home ? copy(p.home, 'home path') : ''}`),
      sInfoRow('terminal', 'Shell', null, `<span class="mono">${esc(p.shell || '–')}</span>`),
    ].join(''))}
    ${settingsGroup('Vantage', [
      sInfoRow('bolt', 'Mode', meta.readOnly ? 'Management actions are disabled.' : 'Full management is enabled.', meta.readOnly ? pill('read-only', 'warn') : pill('management enabled', 'good')),
      sInfoRow('network', 'Local server', `Serving this dashboard at ${serverHost}.`, `${pill('running', 'good')}${copy('http://' + serverHost, 'dashboard URL')}`),
      sInfoRow('app', 'Launch at login', setup.launchdLoaded ? 'Starts automatically with your Mac.' : 'Not installed, Vantage may not start automatically.', setup.launchdLoaded ? pill('on', 'good') : '<button class="btn small" data-setup-open="login">Open Login Items</button>'),
      sInfoRow('shield', 'Full Disk Access', setup.fullDiskAccess === true ? 'Granted, disk totals are complete.' : 'Optional, for complete disk totals.', setup.fullDiskAccess === true ? pill('granted', 'good') : '<button class="btn small" data-setup-open="fda">Open settings</button>'),
      sInfoRow('grid', 'Native app', caps.native && caps.native.built ? 'Built, open it from the Dock.' : 'Not built yet.', caps.native && caps.native.built ? pill('built', 'good') : pill('not built', '')),
      sInfoRow('grid', 'Installed web app', setup.pwaInstalled ? 'Installed to the Dock.' : 'Running in the browser.', setup.pwaInstalled ? pill('installed', 'good') : pill('not installed', '')),
    ].join(''))}
    <div class="settings-inline">
      <button class="btn small" data-settings-rescan>Rescan machine</button>
      <button class="btn small" data-settings-rerun>Run setup again</button>
    </div>`;
}

function settingsAppearance() {
  const caps = settingsCaps();
  const r = (id) => settingRow(registryEntry(id), caps);
  const v = settingsState.data.values;
  const cls = `${v['appearance.density']} ${v['appearance.sidebar']} ${v['appearance.material']}`;
  return `<div class="settings-preview">
      <div class="preview-app ${esc(cls)}">
        <div class="preview-side"><span class="preview-logo"></span><span class="preview-nav"></span><span class="preview-nav"></span><span class="preview-nav short"></span></div>
        <div class="preview-main"><span class="preview-chip"></span><div class="preview-rows"><span class="preview-row"></span><span class="preview-row"></span><span class="preview-row short"></span></div></div>
      </div>
      <div class="pv-copy"><strong>Live preview</strong><p>Every option below is reflected here instantly, accent, material, density and sidebar.</p></div>
    </div>
    ${settingsGroup('Theme', r('appearance.accent') + r('appearance.material'))}
    ${settingsGroup('Layout', r('appearance.density') + r('appearance.sidebar'))}
    ${settingsGroup('Motion', r('appearance.motion'))}`;
}

function settingsNotifications() {
  const caps = settingsCaps();
  const r = (id) => settingRow(registryEntry(id), caps);
  const info = settingsState.notify || {};
  if (!settingsState.notify && !settingsState.notifyTried) loadNotifyInfo();
  const subs = info.pushSubscriptions || 0;
  const test = (id, html) => `<div class="settings-test-row">${html}<span class="settings-test-status" data-test-status="${id}"></span></div>`;
  return `
    ${settingsGroup('Channels',
      r('notifications.enabled') +
      r('notifications.macos') +
      test('macos', `<button class="btn small" data-notify-test="macos">Send test banner</button><span class="settings-test-hint">${info.macNotifier === 'terminal-notifier' ? 'helper ready' : 'helper may be blocked in System Settings'}</span>`) +
      r('notifications.telegram') +
      r('notifications.telegramChatId') +
      test('telegram', `<button class="btn small" data-notify-test="telegram">Send test message</button><span class="settings-test-hint">${info.telegramAvailable ? 'bot token found' : 'no bot token detected'}</span>`) +
      r('notifications.push') +
      r('behavior.notifyBrowser') +
      test('push', `<button class="btn small" data-test-browser>Test desktop</button><button class="btn small" data-notify-test="push">Test push</button><span class="settings-test-hint">${subs} push subscription${subs === 1 ? '' : 's'}</span>`)
    )}
    ${settingsGroup('When to notify',
      r('notifications.notifyJobDone') + r('notifications.notifyJobFailed') +
      r('notifications.notifyServiceDown') + r('notifications.diskFreePctThreshold') + r('notifications.cooldownMinutes')
    )}
    <div class="settings-inline"><button class="btn small" data-act="system.openNotificationSettings">Open macOS Notification settings…</button></div>
    <p class="settings-note">Desktop &amp; Web Push banners come from your browser. macOS banners are posted by the server helper and must be allowed in System Settings → Notifications. Telegram needs a bot token in your OpenClaw env.</p>`;
}

function settingsSecurity() {
  const caps = settingsCaps();
  const w = settingsState.data.capabilityState.webauthn || {};
  const enabled = Boolean(w.enabled);
  const since = w.latest && w.latest.createdAt ? relativeTime(w.latest.createdAt) : null;
  const appState = !nativeTouchIdAvailable
    ? { help: 'Touch ID prompts need the native Mac app or http://localhost.', control: pill('not available', '') }
    : (w.native
      ? { help: 'A Touch ID-gated key is enrolled for this app.', control: pill('ready', 'good') }
      : { help: 'Not set up for this app yet. Testing or running an action enrolls it.', control: pill('setup needed', 'warn') });
  return `${settingsGroup('Touch ID',
    settingRow(registryEntry('security.touchId'), caps) +
    sInfoRow('fingerprint', 'Status', enabled ? `Enrolled${since ? ` · added ${since}` : ''} · ${w.credentialCount || 1} credential${(w.credentialCount || 1) === 1 ? '' : 's'}` : 'Not enrolled, irreversible actions fall back to the typed confirmation.', enabled ? pill('on', 'good') : pill('off', '')) +
    sInfoRow('key', 'This app', appState.help, appState.control) +
    (enabled ? sInfoRow('shield', 'Test fingerprint', 'Prompts for Touch ID and verifies a signed challenge with the server.', '<button class="btn small" data-security-test>Test</button>') : '')
  )}
  <p class="settings-note">Touch ID assertions are verified on the server. In the browser they use WebAuthn via <span class="mono">http://localhost</span>; in the native app they use a Touch ID-gated key. If the authenticator is ever lost, delete <span class="mono">data/webauthn.json</span> to reset.</p>`;
}

function settingsCapabilities() {
  const rows = [
    { icon: 'bell', title: 'Notifications', ok: CAPS.notifications, help: 'Show alerts as banners while Vantage is open.', action: '<button class="btn small" data-test-browser>Test</button>' },
    { icon: 'globe', title: 'Web Push', ok: Boolean(state.push && state.push.subscriptions), help: 'Background alerts delivered to this browser.', action: '<button class="btn small" data-notify-test="push">Test</button>' },
    { icon: 'fingerprint', title: 'Touch ID', ok: Boolean(state.webauthn && state.webauthn.enabled), help: 'Fingerprint gate for destructive actions (server-verified).' },
    { icon: 'download', title: 'Save to file', ok: CAPS.fileSystemAccess, help: 'Choose where exports and screenshots are saved.' },
    { icon: 'copy', title: 'Clipboard read', ok: CAPS.clipboardRead, help: 'Paste from the clipboard into Vantage.' },
    { icon: 'bolt', title: 'Screen wake lock', ok: CAPS.wakeLock, help: 'Keep the display awake during long jobs.' },
    { icon: 'clock', title: 'Idle detection', ok: CAPS.idleDetection, help: 'Pause polling while you are away.' },
    { icon: 'bell', title: 'App badge', ok: CAPS.badge, help: 'Show a count on the app/Dock icon.' },
    { icon: 'app', title: 'Installable app', ok: CAPS.serviceWorker, help: 'Install Vantage to the Dock (PWA).' },
    { icon: 'bolt', title: 'Native bridge', ok: CAPS.native, help: 'Running inside the native Mac app.' },
    { icon: 'photo', title: 'Screen capture', ok: CAPS.capture, help: 'Capture the screen from ⌘K.' },
  ];
  const ok = rows.filter((r) => r.ok).length;
  return `${settingsGroup(`Capabilities · ${ok} of ${rows.length} available`,
    rows.map((row) => `<div class="settings-row"><span class="sr-ico">${svg(row.icon)}</span><div class="sr-main"><div class="sr-title">${esc(row.title)}</div><div class="sr-help">${esc(row.help)}</div></div><div class="sr-control">${row.ok ? pill('available', 'good') : pill('not available', '')}${row.action || ''}</div></div>`).join('')
  )}
  <p class="settings-note">Availability is detected per browser and context. “Not available” means the current browser or origin can’t do it, try the native app or <span class="mono">http://localhost</span>.</p>`;
}

function settingsData() {
  const info = settingsState.dataInfo || {};
  if (!settingsState.dataInfo && !settingsState.dataInfoTried) loadDataInfo();
  const up = info.uploads || { count: 0, bytes: 0 };
  const m = info.metrics || {};
  return `${settingsGroup('Storage',
    sInfoRow('upload', 'Uploads', 'Files you drag onto the window are copied here. Safe to browse or delete, Vantage never reads them back automatically.', `<span class="sr-value">${up.count} file${up.count === 1 ? '' : 's'} · ${fmtBytes(up.bytes)}</span>`) +
    sInfoRow('database', 'Metrics history', 'CPU, memory, disk and network samples that power the Monitor charts, kept for 14 days, then pruned.', `<span class="sr-value">${fmtNum(m.samples || 0)} samples</span>`)
  )}
  ${settingsGroup('Backup',
    sInfoRow('download', 'Export & import', 'Save every setting to a JSON file, or restore it on another Mac.', '<button class="btn small" data-settings-export>Export</button><button class="btn small" data-settings-import>Import…</button>') +
    sInfoRow('warning', 'Reset', 'Restore every setting to its default.', '<button class="btn small" data-settings-reset="all">Reset to defaults</button>')
  )}`;
}

function settingsAdvanced() {
  const port = location.port || '8790';
  return `${settingsGroup('Behaviour', settingsRows('advanced'))}
    ${settingsGroup('Server',
      sInfoRow('restart', 'Restart server', 'Reloads the launchd service local.vantage, the dashboard reconnects in a moment.', '<button class="btn small" data-act="system.restartService">Restart</button>') +
      sInfoRow('pulse', 'Diagnostics', 'Recent server diagnostics and cache stats.', '<button class="btn small" data-settings-diagnostics>Open</button>') +
      sInfoRow('terminal', 'Restart command', 'Copy the launchctl command instead.', '<button class="btn small" data-copy="launchctl kickstart -k gui/$(id -u)/local.vantage">Copy</button>')
    )}
    <p class="settings-note">Bound to <span class="mono">${esc(location.hostname || '127.0.0.1')}:${esc(port)}</span>${settingsState.data.meta.readOnly ? ' · read-only mode' : ''}.</p>`;
}

function settingsAbout() {
  const u = state.update || {};
  let statusControl;
  if (!u.supported) statusControl = pill('source install', 'warn');
  else if (!u.checked) statusControl = '<button class="btn small" data-settings-check>Check for updates</button>';
  else if (u.available) statusControl = `${pill(`${u.behind} behind`, 'warn')}<button class="btn small primary" data-settings-update>Update now</button>`;
  else statusControl = `${pill('up to date', 'good')}<button class="btn small" data-settings-check>Check</button>`;
  const updateSub = u.available
    ? `New commits available: ${u.subject || 'update ready'}.`
    : (u.error ? `Last check failed: ${u.error}` : 'Vantage keeps itself current from its git checkout.');
  return `${settingsGroup('Vantage',
    sInfoRow('sparkle', 'Version', u.current ? `Total management for your Mac. Built from ${u.current}.` : 'Total management for your Mac.', `<span class="mono">${esc(u.version || '0.9.0-beta')}</span> ${pill('beta', 'accent')}`) +
    sInfoRow('app', 'License', 'Open source under the MIT license.', '<span class="mono">MIT</span>') +
    sInfoRow('bolt', 'Setup', 'Re-run the onboarding wizard.', '<button class="btn small" data-settings-rerun>Run setup</button>')
  )}
  ${settingsGroup('Updates',
    sInfoRow('download', 'Vantage updates', updateSub, statusControl) +
    sInfoRow('sparkle', "What's new", 'Auto-generated changelog from the git history.', '<button class="btn small" data-settings-changelog>View</button>')
  )}
  ${settingsGroup('Links',
    sInfoRow('link', 'Repository', 'jesse-chelin/vantage', '<button class="btn small" data-settings-repo>Open</button>') +
    sInfoRow('download', 'Releases', 'Download the signed native app.', '<button class="btn small" data-settings-releases>Open</button>')
  )}
  <p class="settings-note">Settings are stored locally under <span class="mono">data/</span> on this Mac.</p>`;
}

function settingsSection(section) {
  if (section === 'general') return settingsGeneral();
  if (section === 'appearance') return settingsAppearance();
  if (section === 'notifications') return settingsNotifications();
  if (section === 'security') return settingsSecurity();
  if (section === 'capabilities') return settingsCapabilities();
  if (section === 'data') return settingsData();
  if (section === 'advanced') return settingsAdvanced();
  if (section === 'about') return settingsAbout();
  return '';
}

function renderSettingsView() {
  els.viewTitle.textContent = 'Settings';
  els.viewSub.textContent = 'Preferences for Vantage';
  if (!settingsState.data) {
    if (settingsState.error) {
      els.view.innerHTML = `<div class="empty-note">Could not load settings: ${esc(settingsState.error)}</div>`;
      return;
    }
    els.view.innerHTML = skeletonRows(6);
    loadSettingsData();
    return;
  }
  const items = settingsState.data.sections
    .map((s) => `<button class="settings-nav-item${s.id === settingsState.section ? ' active' : ''}" data-settings-nav="${s.id}">${svg(s.icon)}<span>${esc(s.label)}</span></button>`)
    .join('');
  els.view.innerHTML = `<div class="settings-layout">
    <nav class="settings-subnav"><div class="settings-subnav-items">${items}</div></nav>
    <div class="settings-pane">
      <div class="settings-head"><h2>${esc(sectionLabel(settingsState.section))}</h2></div>
      <div id="settings-content"></div>
    </div>
  </div>`;
  renderSettingsSection('none');
  if (!settingsState.profile || !setupState.data) loadSettingsData();
}

function renderSettingsSection(direction = 'none') {
  const host = document.getElementById('settings-content');
  if (!host || !settingsState.data) return;
  const heading = els.view.querySelector('.settings-head h2');
  if (heading) heading.textContent = sectionLabel(settingsState.section);
  for (const btn of els.view.querySelectorAll('[data-settings-nav]')) btn.classList.toggle('active', btn.getAttribute('data-settings-nav') === settingsState.section);
  const dirClass = direction === 'forward' ? ' from-right' : direction === 'back' ? ' from-left' : '';
  const wrap = document.createElement('div');
  wrap.className = `settings-section${dirClass}`;
  wrap.innerHTML = settingsSection(settingsState.section);
  host.replaceChildren(wrap);
  const scroller = contentScroller();
  if (direction !== 'none' && scroller) scroller.scrollTop = 0;
}

function openSettings(section = settingsState.section || 'general') {
  if (state.view !== 'settings') settingsState.returnView = state.view;
  settingsState.section = section;
  if (state.view !== 'settings') setView('settings');
  else renderSettingsView();
  if (!settingsState.data || !settingsState.profile) loadSettingsData();
}

function closeSettings() {
  setView(settingsState.returnView && settingsState.returnView !== 'settings' ? settingsState.returnView : 'overview');
}

async function loadSettingsData() {
  if (settingsState.loading) return;
  settingsState.loading = true;
  try {
    if (!settingsState.data) {
      settingsState.data = await api('/api/settings');
      settingsState.error = null;
      applyServerValues();
    }
    if (!settingsState.profile) {
      settingsState.profile = await api('/api/profile').catch(() => settingsState.profile);
    }
    if (!setupState.data) {
      setupState.data = await api('/api/setup').catch(() => setupState.data);
    }
  } catch (error) {
    settingsState.error = error.message;
  } finally {
    settingsState.loading = false;
  }
  if (state.view === 'settings') renderSettingsView();
}

function applyServerValues() {
  const values = settingsState.data && settingsState.data.values;
  if (!values) return;
  prefs = {
    ...prefs,
    accent: values['appearance.accent'],
    density: values['appearance.density'],
    motion: values['appearance.motion'],
    material: values['appearance.material'],
    sidebar: values['appearance.sidebar'],
    notifyBrowser: values['behavior.notifyBrowser'],
    wakeLock: values['behavior.wakeLock'],
    idlePause: values['behavior.idlePause'],
  };
  savePrefs();
  applyPrefs();
}

async function syncSettings() {
  const data = await api('/api/settings');
  settingsState.data = data;
  state.webauthn = data.capabilityState.webauthn;
  state.push = data.capabilityState.push;
  prefs = { ...prefs, touchId: Boolean(state.webauthn.enabled) };
  if (!data.meta.prefsInitialized) {
    const seed = {
      'appearance.accent': prefs.accent,
      'appearance.density': prefs.density,
      'appearance.motion': prefs.motion,
      'appearance.material': prefs.material,
      'appearance.sidebar': prefs.sidebar,
      'behavior.notifyBrowser': prefs.notifyBrowser,
      'behavior.wakeLock': prefs.wakeLock,
      'behavior.idlePause': prefs.idlePause,
    };
    try {
      settingsState.data.values = await api('/api/settings', { method: 'PATCH', body: { patch: seed } });
    } catch {
      /* keep defaults */
    }
  }
  applyServerValues();
}

async function patchSettings(patch) {
  try {
    const values = await api('/api/settings', { method: 'PATCH', body: { patch } });
    settingsState.data.values = values;
    applyServerValues();
    if (state.view === 'settings') {
      const texty = Object.keys(patch || {}).some((id) => { const entry = registryEntry(id); return entry && (entry.type === 'text' || entry.type === 'number'); });
      if (!texty) renderSettingsSection();
    }
    if (els.onboardingRoot && els.onboardingRoot.classList.contains('open')) renderOnboarding();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleSettingToggle(toggle) {
  const id = toggle.getAttribute('data-setting-toggle');
  if (id === 'behavior.notifyBrowser' && toggle.checked) {
    const ok = await ensureNotifyPermission();
    if (!ok) {
      toggle.checked = false;
      return;
    }
  }
  if (id === 'behavior.idlePause' && toggle.checked) {
    // Prompt for idle detection here, where the toggle explains what it's for.
    await enableIdleDetection().catch(() => {});
  }
  patchSettings({ [id]: toggle.checked });
}

async function refreshSettingsState() {
  try {
    const data = await api('/api/settings');
    settingsState.data = data;
    state.webauthn = data.capabilityState.webauthn;
    state.push = data.capabilityState.push;
    prefs = { ...prefs, touchId: Boolean(state.webauthn.enabled) };
  } catch {
    /* ignore */
  }
  if (state.view === 'settings') renderSettingsSection();
}

async function enableTouchIdFromSettings() {
  if (!touchIdUsable()) throw new Error('Open Vantage via http://localhost to use Touch ID');
  await registerTouchId();
  toast('Touch ID registered, destructive actions now require it', 'good');
  await refreshSettingsState();
}

async function disableTouchIdFromSettings() {
  let grant;
  if (state.webauthn && state.webauthn.enabled && touchIdUsable()) {
    try {
      grant = await obtainGrant();
    } catch {
      grant = null;
    }
    if (!grant) throw new Error('Touch ID required to disable');
  }
  await disableTouchId(grant);
  toast('Touch ID gating disabled', 'good');
  await refreshSettingsState();
}

async function exportSettings() {
  try {
    const data = await api('/api/settings/export', { method: 'POST', body: {} });
    await saveFile(`vantage-settings-${dateStamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function importSettings() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const result = await api('/api/settings/import', { method: 'POST', body: data });
      settingsState.data.values = result.values || settingsState.data.values;
      applyServerValues();
      await refreshSettingsState();
      toast('Settings imported', 'good');
    } catch (error) {
      toast(`Import failed: ${error.message}`, 'error');
    }
  };
  input.click();
}

async function resetSettings(section) {
  const ok = await confirmSheet(
    { label: 'Reset settings', description: section === 'all' ? 'Restore every setting to its default.' : `Restore ${section} settings to defaults.`, danger: 'medium' },
    {},
    null,
  );
  if (!ok) return;
  try {
    const result = await api('/api/settings/reset', { method: 'POST', body: section === 'all' ? {} : { section } });
    settingsState.data.values = result.values;
    applyServerValues();
    await refreshSettingsState();
    toast('Settings reset', 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
}

els.view.addEventListener('click', (event) => {
  if (state.view !== 'settings') return;
  const accent = event.target.closest('[data-setting-accent]');
  if (accent) {
    const name = accent.getAttribute('data-setting-accent');
    patchSettings({ 'appearance.accent': name });
    for (const swatch of els.view.querySelectorAll('[data-setting-accent]')) swatch.classList.toggle('active', swatch === accent);
    return;
  }
  const seg = event.target.closest('[data-setting-seg]');
  if (seg) {
    patchSettings({ [seg.getAttribute('data-setting-seg')]: seg.getAttribute('data-value') });
    for (const b of seg.parentElement.querySelectorAll('[data-setting-seg]')) b.classList.toggle('active', b === seg);
    return;
  }
  const openSetup = event.target.closest('[data-setup-open]');
  if (openSetup) {
    const target = { notifications: 'system.openNotificationSettings', fda: 'system.openFullDiskAccess', login: 'system.openLoginItems' }[openSetup.getAttribute('data-setup-open')] || 'system.openNotificationSettings';
    runAction(target, {});
    return;
  }
  const nav = event.target.closest('[data-settings-nav]');
  if (nav) {
    const ids = (settingsState.data.sections || []).map((s) => s.id);
    const from = ids.indexOf(settingsState.section);
    settingsState.section = nav.getAttribute('data-settings-nav');
    renderSettingsSection(ids.indexOf(settingsState.section) >= from ? 'forward' : 'back');
    return;
  }
  const touch = event.target.closest('[data-touchid]');
  if (touch) {
    withButtonState(touch, () => (touch.getAttribute('data-touchid') === 'enable' ? enableTouchIdFromSettings() : disableTouchIdFromSettings()), { toast: false });
    return;
  }
  const test = event.target.closest('[data-notify-test]');
  if (test) {
    withButtonState(test, async () => {
      const result = await testNotify(test.getAttribute('data-notify-test'));
      setTestStatus(test, (result && result.message) || 'sent', true);
    }, { toast: false });
    return;
  }
  const browserTest = event.target.closest('[data-test-browser]');
  if (browserTest) {
    withButtonState(browserTest, async () => { await previewBrowserNotification(); setTestStatus(browserTest, 'shown ✓', true); }, { toast: false });
    return;
  }
  const secTest = event.target.closest('[data-security-test]');
  if (secTest) {
    withButtonState(secTest, async () => {
      try {
        const grant = await obtainGrant();
        await refreshSettingsState();
        toast(grant ? 'Touch ID verified, assertions work' : 'Touch ID was not verified', grant ? 'good' : 'error');
      } catch (error) {
        await refreshSettingsState();
        toast(`Touch ID test failed: ${error.message}`, 'error');
        throw error;
      }
    }, { toast: false });
    return;
  }
  if (event.target.closest('[data-settings-diagnostics]')) { openDiagnostics(); return; }
  if (event.target.closest('[data-settings-releases]')) { window.open('https://github.com/jesse-chelin/vantage/releases'); return; }
  if (event.target.closest('[data-settings-check]')) { checkForUpdate(true); return; }
  if (event.target.closest('[data-settings-update]')) { applyUpdate(); return; }
  if (event.target.closest('[data-settings-changelog]')) { openChangelog(); return; }
  if (event.target.closest('[data-settings-export]')) return exportSettings();
  if (event.target.closest('[data-settings-import]')) return importSettings();
  const reset = event.target.closest('[data-settings-reset]');
  if (reset) return resetSettings(reset.getAttribute('data-settings-reset'));
  if (event.target.closest('[data-settings-rescan]')) return triggerScan();
  if (event.target.closest('[data-settings-rerun]')) {
    closeSettings();
    startOnboarding(0);
    return;
  }
  if (event.target.closest('[data-settings-repo]')) {
    window.open('https://github.com/jesse-chelin/vantage');
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) handleCopyButton(copy);
});

els.view.addEventListener('change', (event) => {
  if (state.view !== 'settings') return;
  const toggle = event.target.closest('[data-setting-toggle]');
  if (toggle) return handleSettingToggle(toggle);
  const select = event.target.closest('[data-setting-select]');
  if (select) return patchSettings({ [select.getAttribute('data-setting-select')]: select.value });
  const input = event.target.closest('[data-setting-input]');
  if (input) return patchSettings({ [input.getAttribute('data-setting-input')]: input.value });
});

// --- onboarding wizard -----------------------------------------------------

const ONBOARDING_SEQUENCE = ['welcome', 'appearance', 'permissions', 'alerts', 'system', 'security', 'app', 'finish'];
const ONBOARDING_META = {
  welcome: { icon: 'sparkle', title: 'Welcome to Vantage', lede: 'Manage everything on your Mac, apps, storage, services, network, security and AI, from one local console. Nothing leaves this machine.' },
  appearance: { icon: 'sparkle', title: 'Make it yours', lede: 'Pick an accent and density. You can change these anytime in Settings.' },
  permissions: { icon: 'shield', title: 'Browser permissions', lede: 'Grant what you’re comfortable with, one at a time. Every choice is reversible.' },
  alerts: { icon: 'bell', title: 'Stay in the loop', lede: 'Choose how Vantage tells you when a job finishes, fails, or disk runs low.' },
  system: { icon: 'gears', title: 'macOS access', lede: 'A few System Settings toggles let Vantage do its best work on this Mac.' },
  security: { icon: 'shield', title: 'Protect destructive actions', lede: 'Require your fingerprint before deleting a model, pruning disk, or uninstalling.' },
  app: { icon: 'grid', title: 'Run it as an app', lede: 'The native Mac app is the fullest way to run Vantage, or install it as a lightweight web app.' },
  finish: { icon: 'disk', title: 'Measure your disk', lede: 'Grant the folders macOS protects and Vantage reads them once to finish setup.' },
};

function wizardToggle(id, label, help) {
  const value = settingsState.data ? settingsState.data.values[id] : false;
  return `<div class="wizard-card"><div class="wc-main"><div class="wc-title">${esc(label)}</div><div class="wc-help">${esc(help)}</div></div><label class="switch"><input type="checkbox" data-setting-toggle="${esc(id)}" ${value ? 'checked' : ''}><span class="switch-track"></span></label></div>`;
}

function setStatusEl(el, text, kind = '') {
  if (!el) return;
  el.textContent = text || '';
  el.className = `wc-status ${kind}`;
}

// Shared layout for every wizard card: a header row (icon, title, trailing
// control), a body of explanation lines, and a footer row (transient status on
// the left, actions on the right) so nothing ever collides.
function wizardInfoCard({ id, icon, title, titleExtra = '', body = '', trailing = '', action = '' }) {
  return `<div class="wizard-card col">
    <div class="wc-head">
      ${icon ? `<span class="wc-ico">${svg(icon)}</span>` : ''}
      <div class="wc-title">${esc(title)}${titleExtra}</div>
      ${trailing}
    </div>
    ${body ? `<div class="wc-body">${body}</div>` : ''}
    ${action ? `<div class="wc-foot"><span class="wc-status" data-ob-status="${esc(id || '')}"></span><div class="wc-actions">${action}</div></div>` : ''}
  </div>`;
}

function wizardAlertRow(id, label, help, actionHtml) {
  const value = settingsState.data ? settingsState.data.values[id] : false;
  const toggle = `<label class="switch"><input type="checkbox" data-setting-toggle="${esc(id)}" ${value ? 'checked' : ''}><span class="switch-track"></span></label>`;
  return wizardInfoCard({ id, title: label, body: `<div class="wc-help">${esc(help)}</div>`, trailing: toggle, action: actionHtml || '' });
}

async function wizardTest(channel, statusEl) {
  setStatusEl(statusEl, 'sending…');
  try {
    let previewed = false;
    if (channel === 'push' || channel === 'all') {
      try { previewed = await previewBrowserNotification(); } catch { /* preview is best-effort */ }
    }
    const result = await api('/api/notify/test', { method: 'POST', body: { channel } });
    const pushFailed = channel === 'push' && result.failed > 0;
    const kind = pushFailed ? 'bad' : 'ok';
    setStatusEl(statusEl, `${previewed ? 'browser banner sent · ' : ''}${result.message || 'Sent'}`, kind);
    return result;
  } catch (error) {
    setStatusEl(statusEl, error.message, 'bad');
    throw error;
  }
}

async function wizardEnablePush(statusEl) {
  setStatusEl(statusEl, 'enabling…');
  try {
    if (!CAPS.push) throw new Error('Push is not supported here');
    await subscribePush();
    setStatusEl(statusEl, 'enabled', 'ok');
    setTimeout(() => { if (els.onboardingRoot.classList.contains('open')) renderOnboarding(); }, 700);
  } catch (error) {
    setStatusEl(statusEl, error.message, 'bad');
    throw error;
  }
}

async function wizardAllowBrowser(statusEl) {
  setStatusEl(statusEl, 'requesting…');
  const ok = await ensureNotifyPermission();
  if (ok) {
    setStatusEl(statusEl, 'allowed', 'ok');
    if (!prefs.notifyBrowser) patchSettings({ 'behavior.notifyBrowser': true });
    setTimeout(() => { if (els.onboardingRoot.classList.contains('open')) renderOnboarding(); }, 700);
  } else {
    setStatusEl(statusEl, 'blocked in browser settings', 'bad');
  }
}

function onboardingStackChips() {
  const d = state.data || {};
  const ollama = d.ollama || {};
  const modelCount = ollama.modelCount != null ? ollama.modelCount : (ollama.models || []).length;
  const comfy = d.comfyui || {};
  const runtimes = Array.isArray(d.runtimes) ? d.runtimes : [];
  const serviceCount = d.services && Array.isArray(d.services.services) ? d.services.services.length : 0;
  const chips = [
    { label: `${modelCount} Ollama model${modelCount === 1 ? '' : 's'}`, ok: modelCount > 0 },
    { label: 'ComfyUI', ok: Boolean(comfy.installed || comfy.running) },
    { label: `${runtimes.length} runtime${runtimes.length === 1 ? '' : 's'}`, ok: runtimes.length > 0 },
    { label: `${serviceCount} service${serviceCount === 1 ? '' : 's'}`, ok: serviceCount > 0 },
  ];
  return `<div class="wizard-stack">${chips.map((c) => `<span class="wizard-chip${c.ok ? '' : ' muted'}">${svg(c.ok ? 'check' : 'xmark')}${esc(c.label)}</span>`).join('')}</div>`;
}

function onboardingSetupRow(ok, title, help, action) {
  return `<div class="wizard-card"><div class="wc-main"><div class="wc-title">${esc(title)}</div><div class="wc-help">${esc(help)}</div></div><div class="wc-actions"><span class="wc-status ${ok ? 'ok' : ''}">${ok ? 'ready' : 'needs setup'}</span>${action || ''}</div></div>`;
}

// A permission request is only shown alongside why Vantage wants it, why it is
// safe, its current state, and a button that requests just that one thing.
const PERM_STATE = {
  granted: ['granted', 'good'],
  subscribed: ['subscribed', 'good'],
  ready: ['ready', 'good'],
  'not asked': ['not asked', ''],
  denied: ['blocked', 'bad'],
  missing: ['not found', ''],
  unsupported: ['not available', ''],
  unknown: ['not checked', ''],
};

const FOLDER_ICONS = { desktop: 'monitor', documents: 'file', downloads: 'download', movies: 'film', music: 'music', pictures: 'photo', photos: 'camera' };

function permissionCard(def) {
  const [label, kind] = PERM_STATE[def.state] || [def.state, ''];
  const body = `<div class="wc-help">${esc(def.why)}</div>
    <div class="wc-help dim">Safe to grant: ${esc(def.safe)}</div>
    ${def.hint ? `<div class="wc-help dim">${esc(def.hint)}</div>` : ''}`;
  return wizardInfoCard({
    id: def.id,
    icon: def.icon,
    title: def.title,
    body,
    trailing: pill(label, kind),
    action: def.action || '',
  });
}

// Browser-side permissions, each with its exact state and a single-purpose
// action. Nothing here fires on its own.
function browserPermissionDefs() {
  const defs = [];
  const rawNotif = NATIVE ? 'granted' : !CAPS.notifications ? 'unsupported' : Notification.permission;
  const notifState = rawNotif === 'default' ? 'not asked' : rawNotif;
  defs.push({
    id: 'notifications',
    icon: 'bell',
    title: 'Desktop notifications',
    why: 'Tell you the moment a long job finishes, fails, or disk runs low.',
    safe: 'your browser draws a local banner on this Mac. Nothing is sent anywhere.',
    hint: 'No banner on a test? Allow your browser in System Settings → Notifications, and turn off Focus.',
    state: notifState,
    action: notifState === 'granted'
      ? '<button class="btn small" data-perm="notifications-test">Test</button>'
      : notifState === 'denied'
        ? '<button class="btn small" data-perm="notifications-help">How to allow</button>'
        : notifState === 'unsupported'
          ? ''
          : '<button class="btn small primary" data-perm="notifications">Grant</button>',
  });

  if (CAPS.push) {
    const subs = state.push ? state.push.subscriptions : 0;
    defs.push({
      id: 'push',
      icon: 'globe',
      title: 'Web Push',
      why: 'Deliver alerts even when the Vantage tab is closed.',
      safe: 'alerts are encrypted to this browser and sent via your browser’s push service.',
      state: subs > 0 ? 'subscribed' : 'not asked',
      action: subs > 0
        ? '<button class="btn small" data-perm="push-test">Test</button>'
        : '<button class="btn small primary" data-perm="push">Grant</button>',
    });
  }

  if (CAPS.idleDetection) {
    defs.push({
      id: 'idle',
      icon: 'clock',
      title: 'Pause when you’re away',
      why: 'Stop background polling while you step away, so Vantage stays quiet.',
      safe: 'only macOS idle state is read, on-device. It is never stored or sent.',
      state: idleGranted ? 'granted' : idlePermissionState,
      action: idleGranted
        ? ''
        : idlePermissionState === 'denied'
          ? '<button class="btn small" data-perm="idle-help">Blocked</button>'
          : '<button class="btn small primary" data-perm="idle">Grant</button>',
    });
  }

  if (CAPS.persistentStorage) {
    defs.push({
      id: 'storage',
      icon: 'download',
      title: 'Reliable offline storage',
      why: 'Keep the app shell cached so Vantage still opens without a network.',
      safe: 'only Vantage’s own app files live in your browser cache.',
      state: persistentState === true ? 'granted' : 'not asked',
      action: persistentState === true ? '' : '<button class="btn small primary" data-perm="storage">Grant</button>',
    });
  }

  return defs;
}

// macOS-side access, grouped on its own step so the list stays short. These
// can't be granted from a web API, so each opens the exact System Settings pane.
function macosPermissionDefs() {
  const s = setupState.data || {};
  const defs = [];

  defs.push({
    id: 'macos',
    icon: 'app',
    title: 'Background macOS banners',
    why: 'Let a small Vantage helper post System banners even when no tab is open.',
    safe: 'the helper posts banners locally; nothing leaves this Mac.',
    hint: 'After installing, allow “terminal-notifier” (or “Script Editor”) in System Settings → Notifications.',
    state: s.notifier === 'terminal-notifier' ? 'ready' : 'not asked',
    action: s.notifier === 'terminal-notifier'
      ? '<button class="btn small" data-perm="macos-test">Test</button>'
      : '<button class="btn small primary" data-perm="helper">Install helper</button><button class="btn small" data-setup-open="notifications">Settings</button>',
  });

  defs.push({
    id: 'fda',
    icon: 'shield',
    title: 'Full Disk Access',
    why: `Measure where your disk space went, including folders macOS protects. In Full Disk Access, add your Node binary${s.nodePath ? ` (${s.nodePath})` : ''}.`,
    safe: 'only totals are read, on this Mac. File contents are never uploaded.',
    hint: s.nodePath ? 'If it’s hidden in the file picker, press ⌘⇧G and paste the path.' : '',
    state: s.fullDiskAccess === true ? 'granted' : s.fullDiskAccess === false ? 'denied' : 'unknown',
    action: s.fullDiskAccess === true
      ? ''
      : '<button class="btn small" data-perm="fda-open">Open Settings</button><button class="btn small" data-perm="fda-recheck">Re-check</button>',
  });

  defs.push({
    id: 'login',
    icon: 'bolt',
    title: 'Launch at login',
    why: 'Keep Vantage running after a restart so alerts and schedules keep working.',
    safe: 'it starts a local process on this Mac only.',
    state: s.launchdLoaded ? 'granted' : 'not asked',
    action: s.launchdLoaded ? '' : '<button class="btn small" data-perm="login">Open Login Items</button>',
  });

  return defs;
}

// Fulfils a single permission card's action. Each branch requests exactly one
// thing; a throw is surfaced on the card by the caller.
async function handlePermissionAction(action, statusEl) {
  switch (action) {
    case 'notifications': {
      const ok = await ensureNotifyPermission();
      if (!ok) throw new Error('Notification permission was not granted');
      await patchSettings({ 'behavior.notifyBrowser': true });
      break;
    }
    case 'notifications-test':
      await previewBrowserNotification();
      return;
    case 'notifications-help':
    case 'idle-help':
      showNotifyHelp();
      return;
    case 'push':
      await wizardEnablePush(statusEl);
      return;
    case 'push-test':
      await wizardTest('push', statusEl);
      return;
    case 'idle': {
      const ok = await enableIdleDetection();
      if (!ok) throw new Error(idlePermissionState === 'denied' ? 'Blocked in this browser' : 'Not available here');
      break;
    }
    case 'storage': {
      const ok = await ensurePersistentStorage();
      if (!ok) throw new Error('Not available in this browser');
      break;
    }
    case 'helper':
      runAction('brew.install', { name: 'terminal-notifier', kind: 'formula' });
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await loadSetup(false);
        if (setupState.data && setupState.data.notifier === 'terminal-notifier') break;
      }
      break;
    case 'macos-test':
      await wizardTest('macos', statusEl);
      return;
    case 'fda-open':
      runAction('system.openFullDiskAccess', {});
      return;
    case 'fda-recheck':
      await loadSetupFda();
      return;
    case 'login':
      runAction('system.openLoginItems', {});
      return;
    default:
      return;
  }
  if (els.onboardingRoot && els.onboardingRoot.classList.contains('open')) renderOnboarding('none');
}

// The full inventory scan can still be running when the wizard first paints.
// Fall back to the lightweight profile probe (no disk walk) so the hero shows
// the actual Mac instead of defaulting to another model.
function wizardSystem() {
  const inventory = (state.data && state.data.system) || {};
  const profile = onboardingState.profile || {};
  return {
    model: inventory.model || profile.model || null,
    chip: inventory.chip || profile.chip || null,
    physicalMemoryLabel: inventory.physicalMemoryLabel || profile.physicalMemoryLabel || null,
    macos: inventory.macos || (profile.macos ? `macOS ${profile.macos}` : null),
    hostname: inventory.hostname || profile.hostname || null,
  };
}

function onboardingStepBody(step) {
  if (step === 'welcome') {
    return `<div class="wizard-hero">${deviceBadge(wizardSystem().model)}</div>`;
  }
  if (step === 'appearance') {
    const names = ['system', ...Object.keys(ACCENTS)];
    const swatches = names
      .map((name) => `<button class="accent-swatch${prefs.accent === name ? ' active' : ''}" data-ob-accent="${name}" title="${esc(name)}" style="background:${name === 'system' ? systemAccentColor() : ACCENTS[name][0]}"></button>`)
      .join('');
    const density = settingsState.data ? settingsState.data.values['appearance.density'] : 'comfortable';
    const densityControl = `<div class="wizard-card"><div class="wc-main"><div class="wc-title">Density</div><div class="wc-help">Comfortable spacing, or compact to fit more on screen.</div></div><div class="wc-actions"><div class="segmented">${['comfortable', 'compact'].map((o) => `<button class="seg${density === o ? ' active' : ''}" data-ob-density="${o}">${o === 'comfortable' ? 'Comfortable' : 'Compact'}</button>`).join('')}</div></div></div>`;
    return `<div class="wizard-swatches">${swatches}</div>
      <div class="wizard-cards" style="max-width:440px;margin-left:auto;margin-right:auto">${densityControl}</div>`;
  }
  if (step === 'alerts') {
    const notifPerm = NATIVE ? 'granted' : CAPS.notifications ? Notification.permission : 'unsupported';
    const pushSubs = state.push ? state.push.subscriptions : 0;
    const browserReady = notifPerm === 'granted';
    const browserAction = browserReady
      ? '<button class="btn small" data-ob-test-browser>Test</button>'
      : '<span class="wc-status">set up on the previous step</span>';
    const pushAction = !CAPS.push
      ? ''
      : pushSubs > 0
        ? '<button class="btn small" data-ob-test="push">Test</button>'
        : '<span class="wc-status">set up on the previous step</span>';
    return `<div class="wizard-cards">
      ${wizardAlertRow('behavior.notifyBrowser', 'Desktop notifications', browserReady ? 'Real banners while Vantage is open' : 'Granted permission needed, see the previous step', browserAction)}
      ${wizardAlertRow('notifications.push', 'Web Push', pushSubs > 0 ? 'Alerts even when the tab is closed' : 'Enable it on the previous step for background alerts', pushAction)}
      ${wizardAlertRow('notifications.macos', 'Server alerts (helper)', 'Posted by the Vantage helper, works with no tab open', '<button class="btn small" data-ob-test="macos">Test</button>')}
    </div>
    <p class="settings-note" style="text-align:center;margin-top:14px">If a test reports success but no banner appears, allow your browser in System Settings → Notifications and turn off Focus or Summarise notifications. The server helper path above is the most reliable on this Mac.</p>`;
  }
  if (step === 'permissions') {
    const defs = browserPermissionDefs();
    const pending = defs.filter((d) => d.state === 'not asked' || d.state === 'unknown').length;
    return `<div class="wizard-cards">${defs.map(permissionCard).join('')}</div>
    <p class="settings-note" style="text-align:center;margin-top:14px">${pending ? `${pending} still to decide. ` : ''}Nothing is requested until you click Grant, and you can change any of it later in Settings → Capabilities.</p>`;
  }
  if (step === 'system') {
    const defs = macosPermissionDefs();
    return `<div class="wizard-cards">${defs.map(permissionCard).join('')}</div>
    <p class="settings-note" style="text-align:center;margin-top:14px">These open the exact System Settings pane. Nothing is enabled until you toggle it there, and Vantage never reads more than these tasks need.</p>`;
  }
  if (step === 'security') {
    const enabled = settingsState.data && settingsState.data.capabilityState.webauthn.enabled;
    const note = touchIdUsable() ? 'Uses Touch ID on this Mac; the server verifies each request.' : 'Available when opened via http://localhost.';
    const action = `<button class="btn small ${enabled ? '' : 'primary'}" data-ob-touchid="${enabled ? 'disable' : 'enable'}">${enabled ? 'Disable' : 'Enable'}</button>`;
    return `<div class="wizard-cards">${wizardInfoCard({
      id: 'touchid',
      icon: 'fingerprint',
      title: 'Touch ID for destructive actions',
      body: `<div class="wc-help">${esc(note)}</div>`,
      trailing: pill(enabled ? 'on' : 'off', enabled ? 'good' : ''),
      action,
    })}</div>`;
  }
  if (step === 'app') {
    const nativeRunning = Boolean(NATIVE);
    const nativeBuilt = Boolean(settingsState.data && settingsState.data.capabilityState && settingsState.data.capabilityState.native && settingsState.data.capabilityState.native.built);
    const webInstalled = Boolean((setupState.data && setupState.data.pwaInstalled) || isStandalone());
    const nativeAction = nativeRunning ? '' : `<button class="btn small primary" data-ob-native>${nativeBuilt ? 'Open' : 'Build &amp; open'}</button>`;
    const webAction = webInstalled ? '' : '<button class="btn small" data-ob-install>Install</button>';
    return `<div class="wizard-cards">
      ${wizardInfoCard({
        id: 'native',
        icon: 'app',
        title: 'Native Mac app',
        titleExtra: ` ${pill('recommended', 'accent')}`,
        body: '<div class="wc-help">A real Mac window with a Dock icon, menu-bar quick actions, and native notifications, save dialogs, clipboard and wake lock.</div>',
        trailing: nativeRunning ? pill('installed', 'good') : '',
        action: nativeAction,
      })}
      ${wizardInfoCard({
        id: 'webapp',
        icon: 'grid',
        title: 'Install as a web app',
        body: '<div class="wc-help">Runs in your browser as an app window. Best if you prefer the browser, or want Web Push.</div>',
        trailing: webInstalled ? pill('installed', 'good') : '',
        action: webAction,
      })}
    </div>
    <p class="settings-note" style="text-align:center;margin-top:16px">Same dashboard and the same local server either way, the native app adds macOS integration.</p>`;
  }
  if (step === 'finish') {
    const folders = (setupState.data && setupState.data.folders) || [];
    const stateOf = (id) => (setupState.folders && setupState.folders[id]) || 'not asked';
    const rows = folders.map((f) => {
      const state = stateOf(f.id);
      const [label, kind] = PERM_STATE[state] || [state, ''];
      const done = state === 'granted' || state === 'missing';
      const actions = done ? '' : `<button class="btn small" data-ob-folder="${esc(f.id)}">Grant</button>`;
      const icon = `<img class="folder-ico" data-folder="${esc(f.id)}" loading="lazy" decoding="async" alt="" src="/api/folder/icon?id=${esc(f.id)}&size=64" />`;
      return row({ title: esc(f.label), icon, badge: pill(label, kind), actions, search: f.label });
    }).join('');
    const pending = folders.filter((f) => {
      const state = stateOf(f.id);
      return state !== 'granted' && state !== 'missing';
    }).length;
    return `<div class="wizard-cards">
      ${wizardInfoCard({
        id: 'folders',
        icon: 'disk',
        title: 'Folder access',
        body: `<div class="wc-help">macOS protects your home folders. Grant the ones you want measured, and Vantage reads each once for a complete disk breakdown.</div>
          <div class="wc-help dim">Safe to grant: the scan runs on this Mac and stays here. File contents are never uploaded.</div>`,
        action: pending > 1 ? '<button class="btn small" data-ob-folder-all>Grant all</button>' : '',
      })}
      ${card(`<div class="rows">${rows || '<div class="empty-note">Nothing to measure</div>'}</div>`)}
    </div>
    <p class="settings-note" style="text-align:center;margin-top:14px">Press <strong>Open dashboard</strong> when you’re ready; the full scan runs then. You can change any of this later in Settings → Capabilities.</p>`;
  }
  return '';
}

function ensureWizardShell() {
  let shell = els.onboardingRoot.querySelector('.wizard');
  if (shell) return shell;
  els.onboardingRoot.innerHTML = `
    <div class="wizard" role="dialog" aria-modal="true" aria-label="Vantage setup">
      <div class="wizard-progress"><div class="bar"></div></div>
      <div class="wizard-step-label"></div>
      <div class="wizard-cols">
        <aside class="wizard-head"></aside>
        <section class="wizard-main">
          <div class="wizard-body"></div>
          <div class="wizard-actions"><div class="left"></div><div class="right"></div></div>
        </section>
      </div>
    </div>`;
  return els.onboardingRoot.querySelector('.wizard');
}

function focusWizardPrimary() {
  const button = els.onboardingRoot && els.onboardingRoot.querySelector('[data-ob-next]');
  if (button) button.focus({ preventScroll: true });
}

function renderOnboarding(direction = 'none') {
  if (!els.onboardingRoot) return;
  const shell = ensureWizardShell();
  const sequence = ONBOARDING_SEQUENCE;
  const step = sequence[onboardingState.step];
  const meta = ONBOARDING_META[step];
  const pct = Math.round(((onboardingState.step + 1) / sequence.length) * 100);

  shell.querySelector('.wizard-progress .bar').style.width = `${pct}%`;
  shell.querySelector('.wizard-step-label').textContent = `Step ${onboardingState.step + 1} of ${sequence.length}`;

  // The icon/title/subtitle live in a fixed header so they never move between
  // steps; only the body below them changes and flows underneath.
  const head = shell.querySelector('.wizard-head');
  head.innerHTML = `<div class="wizard-icon">${svg(meta.icon)}</div><h2>${esc(meta.title)}</h2><p class="lede">${esc(meta.lede)}</p>`;
  head.classList.remove('enter-forward', 'enter-back');
  if (direction !== 'none') {
    void head.offsetWidth;
    head.classList.add(direction === 'forward' ? 'enter-forward' : 'enter-back');
  }

  const directionClass = direction === 'forward' ? ' from-right' : direction === 'back' ? ' from-left' : '';
  const stepEl = document.createElement('div');
  stepEl.className = `wizard-step${directionClass}`;
  stepEl.innerHTML = onboardingStepBody(step);
  shell.querySelector('.wizard-body').replaceChildren(stepEl);

  renderWizardActions(shell, step);

  if ((step === 'permissions' || step === 'alerts' || step === 'system' || step === 'finish' || step === 'app') && !setupState.data && !setupState.loading) loadSetup();
}

// The action bar updates in place (button elements are reused) so it never
// animates or flickers as steps change.
function renderWizardActions(shell, step) {
  const left = shell.querySelector('.wizard-actions .left');
  const right = shell.querySelector('.wizard-actions .right');
  const isLast = onboardingState.step >= ONBOARDING_SEQUENCE.length - 1;

  if (onboardingState.step > 0) {
    if (!left.querySelector('[data-ob-back]')) left.innerHTML = '<button class="btn small" data-ob-back>Back</button>';
  } else if (left.firstChild) {
    left.innerHTML = '';
  }

  const showSkip = !isLast;
  let skip = right.querySelector('[data-ob-skip]');
  if (showSkip && !skip) {
    skip = document.createElement('button');
    skip.className = 'wizard-skip';
    skip.setAttribute('data-ob-skip', '');
    skip.textContent = 'Skip setup';
    right.prepend(skip);
  } else if (!showSkip && skip) {
    skip.remove();
  }

  let next = right.querySelector('[data-ob-next]');
  if (!next) {
    next = document.createElement('button');
    next.className = 'btn primary';
    next.setAttribute('data-ob-next', '');
    right.appendChild(next);
  }
  next.textContent = isLast ? 'Open dashboard' : 'Continue';
}

async function loadOnboardingContext() {
  const tasks = [];
  if (!onboardingState.profile) tasks.push(api('/api/profile').then((p) => { onboardingState.profile = p; }).catch(() => {}));
  if (!settingsState.data) tasks.push(api('/api/settings').then((d) => { settingsState.data = d; applyServerValues(); }).catch(() => {}));
  if (tasks.length) {
    await Promise.all(tasks);
    renderOnboarding();
  }
  if (isStandalone()) api('/api/installed', { method: 'POST', body: {} }).catch(() => {});
}

function startOnboarding(step = 0) {
  onboardingState.step = Math.max(0, Math.min(step, ONBOARDING_SEQUENCE.length - 1));
  if (!els.onboardingRoot) return;
  // Opening the wizard means onboarding is in progress: clear a prior completion
  // so the native app (and any reload) resumes at the current step instead of
  // skipping straight to the dashboard.
  if (onboardingState.server && onboardingState.server.completedAt) {
    onboardingState.server = { ...onboardingState.server, completedAt: null };
    persistOnboarding({ completedAt: null, currentStep: onboardingState.step });
  }
  els.onboardingRoot.classList.remove('closing');
  els.onboardingRoot.classList.add('open');
  syncScrollLock();
  ensureWizardShell();
  renderOnboarding('none');
  requestAnimationFrame(focusWizardPrimary);
  loadOnboardingContext();
}

function closeOnboarding() {
  const root = els.onboardingRoot;
  if (!root || !root.classList.contains('open')) return;
  const wizard = root.querySelector('.wizard');
  const finish = () => {
    if (!root.classList.contains('closing')) return;
    root.classList.remove('open', 'closing');
    root.innerHTML = '';
    syncScrollLock();
  };
  root.classList.add('closing');
  if (wizard) {
    const onEnd = (event) => {
      if (event.target !== wizard) return;
      wizard.removeEventListener('animationend', onEnd);
      finish();
    };
    wizard.addEventListener('animationend', onEnd);
    setTimeout(() => { wizard.removeEventListener('animationend', onEnd); finish(); }, 320);
  } else {
    finish();
  }
}

async function persistOnboarding(patch) {
  try {
    return await api('/api/onboarding', { method: 'POST', body: patch });
  } catch {
    return null;
  }
}

async function onboardingNext() {
  if (onboardingState.step >= ONBOARDING_SEQUENCE.length - 1) {
    await persistOnboarding({ completedAt: new Date().toISOString(), currentStep: ONBOARDING_SEQUENCE.length - 1 });
    closeOnboarding();
    toast('Vantage is ready', 'good');
    // Completing setup kicks off a full scan server-side; poll so the dashboard
    // picks it up instead of showing the quick first-run numbers.
    loadInventory();
    return;
  }
  onboardingState.step += 1;
  persistOnboarding({ currentStep: onboardingState.step });
  renderOnboarding('forward');
  requestAnimationFrame(focusWizardPrimary);
}

function onboardingBack() {
  if (onboardingState.step > 0) {
    onboardingState.step -= 1;
    renderOnboarding('back');
    requestAnimationFrame(focusWizardPrimary);
  }
}

async function maybeStartOnboarding() {
  let server;
  try {
    server = await api('/api/onboarding');
  } catch {
    return;
  }
  onboardingState.server = server;
  if (server.completedAt) return;
  startOnboarding(Number(server.currentStep) || 0);
}

if (els.onboardingRoot) {
  els.onboardingRoot.addEventListener('click', (event) => {
    if (event.target.closest('[data-ob-next]')) return onboardingNext();
    if (event.target.closest('[data-setup-recheck]')) { loadSetup(); return; }
    const openSetup = event.target.closest('[data-setup-open]');
    if (openSetup) {
      const target = { notifications: 'system.openNotificationSettings', fda: 'system.openFullDiskAccess', login: 'system.openLoginItems' }[openSetup.getAttribute('data-setup-open')] || 'system.openNotificationSettings';
      runAction(target, {});
      return;
    }
    if (event.target.closest('[data-setup-install]')) {
      const installBtn = event.target.closest('[data-setup-install]');
      withButtonState(installBtn, async () => {
        runAction('brew.install', { name: 'terminal-notifier', kind: 'formula' });
        for (let i = 0; i < 40; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await loadSetup();
          if (setupState.data && setupState.data.notifier === 'terminal-notifier') return;
        }
      }, { toast: false });
      return;
    }
    if (event.target.closest('[data-ob-back]')) return onboardingBack();
    if (event.target.closest('[data-ob-skip]')) return onboardingNext();
    const accent = event.target.closest('[data-ob-accent]');
    if (accent) {
      patchSettings({ 'appearance.accent': accent.getAttribute('data-ob-accent') });
      return;
    }
    const density = event.target.closest('[data-ob-density]');
    if (density) {
      patchSettings({ 'appearance.density': density.getAttribute('data-ob-density') });
      return;
    }
    const statusFor = (el) => el.closest('.wizard-card') && el.closest('.wizard-card').querySelector('[data-ob-status]');
    const testBrowser = event.target.closest('[data-ob-test-browser]');
    if (testBrowser) {
      withButtonState(testBrowser, async () => {
        const shown = await previewBrowserNotification();
        setStatusEl(statusFor(testBrowser), shown ? 'browser banner sent' : 'sent, but the browser reported nothing', shown ? 'ok' : 'bad');
      }, { toast: false });
      return;
    }
    if (event.target.closest('[data-ob-notify-help]')) { showNotifyHelp(); return; }
    const permBtn = event.target.closest('[data-perm]');
    if (permBtn) {
      withButtonState(permBtn, () => handlePermissionAction(permBtn.getAttribute('data-perm'), statusFor(permBtn)), { toast: false });
      return;
    }
    const folderBtn = event.target.closest('[data-ob-folder]');
    if (folderBtn) {
      const id = folderBtn.getAttribute('data-ob-folder');
      withButtonState(folderBtn, async () => {
        const res = await api('/api/setup/folder-access', { method: 'POST', body: { id } });
        setupState.folders = setupState.folders || {};
        setupState.folders[id] = res.granted === true ? 'granted' : res.missing ? 'missing' : 'denied';
        if (els.onboardingRoot.classList.contains('open')) renderOnboarding('none');
      }, { toast: false });
      return;
    }
    const folderAll = event.target.closest('[data-ob-folder-all]');
    if (folderAll) {
      withButtonState(folderAll, async () => {
        setupState.folders = setupState.folders || {};
        for (const f of ((setupState.data && setupState.data.folders) || [])) {
          const current = setupState.folders[f.id];
          if (current === 'granted' || current === 'missing') continue;
          const res = await api('/api/setup/folder-access', { method: 'POST', body: { id: f.id } }).catch(() => null);
          if (res) setupState.folders[f.id] = res.granted === true ? 'granted' : res.missing ? 'missing' : 'denied';
          if (els.onboardingRoot.classList.contains('open')) renderOnboarding('none');
        }
      }, { toast: false });
      return;
    }
    const touch = event.target.closest('[data-ob-touchid]');
    if (touch) {
      const enabling = touch.getAttribute('data-ob-touchid') === 'enable';
      withButtonState(
        touch,
        async () => {
          try {
            if (enabling) await enableTouchIdFromSettings();
            else await disableTouchIdFromSettings();
            if (els.onboardingRoot.classList.contains('open')) { renderOnboarding('none'); setStatusEl(els.onboardingRoot.querySelector('[data-ob-status="touchid"]'), enabling ? 'on' : 'off', 'ok'); }
          } catch (error) {
            setStatusEl(statusFor(touch), error.message, 'bad');
            throw error;
          }
        },
        { toast: false },
      );
      return;
    }
    const test = event.target.closest('[data-ob-test]');
    if (test) {
      withButtonState(test, () => wizardTest(test.getAttribute('data-ob-test'), statusFor(test)), { toast: false });
      return;
    }
    const push = event.target.closest('[data-ob-push]');
    if (push) {
      withButtonState(push, () => wizardEnablePush(statusFor(push)), { toast: false });
      return;
    }
    const browser = event.target.closest('[data-ob-browser]');
    if (browser) {
      withButtonState(browser, () => wizardAllowBrowser(statusFor(browser)), { toast: false });
      return;
    }
    const install = event.target.closest('[data-ob-install]');
    if (install) {
      const statusEl = statusFor(install);
      const safari = /^((?!chrome|android|crios|edg).)*safari/i.test(navigator.userAgent);
      if (installPrompt) setStatusEl(statusEl, 'opening…', 'ok');
      else setStatusEl(statusEl, safari ? 'Safari: File → Add to Dock' : 'Use your browser’s Install app option', '');
      promptInstall();
      return;
    }
    if (event.target.closest('[data-ob-notif-help]')) { runAction('system.openNotificationSettings', {}); return; }
    if (event.target.closest('[data-ob-native]')) {
      const nativeBtn = event.target.closest('[data-ob-native]');
      setStatusEl(statusFor(nativeBtn), 'building…');
      // Persist progress first so the app we're about to open resumes the wizard
      // at this exact step (and isn't skipped as already-completed).
      persistOnboarding({ currentStep: onboardingState.step, completedAt: null });
      runAction('native.launch', {});
      return;
    }
  });

  els.onboardingRoot.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-setting-toggle]');
    if (toggle) handleSettingToggle(toggle);
  });
}

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    openSettings('general');
    return;
  }
  if (event.key !== 'Escape') return;
  if (state.view === 'settings') closeSettings();
});

// --- boot ------------------------------------------------------------------

// Asks the server which icon ids it has as real SF Symbols, then re-renders so
// the whole UI swaps from the built-in line icons to the system symbols.
async function loadSymbols() {
  try {
    const data = await fetch('/api/symbols', { cache: 'no-store' }).then((r) => r.json());
    const icons = Array.isArray(data.icons) ? data.icons : [];
    if (!icons.length) return;
    const next = new Set(icons);
    const version = data.version || '';
    if (sfIcons && version === sfVersion && next.size === sfIcons.size && [...next].every((n) => sfIcons.has(n))) return;
    sfIcons = next;
    sfVersion = version;
    sfMasks = data.masks || null;
    render();
  } catch {
    /* keep the built-in line icons */
  }
}

(async function init() {
  if (typeof location !== 'undefined' && location.search && location.search.includes('app=1') && document.body) document.body.classList.add('native-app');
  applyPrefs();
  loadSymbols();
  api('/api/system').then((s) => {
    if (s && s.accent) {
      systemAccent = s.accent;
      applyPrefs();
    }
  }).catch(() => {});
  loadOpenclawStatus();
  setInterval(loadOpenclawStatus, 60_000);
  try {
    state.session = await api('/api/session');
  } catch {
    state.session = { token: null, readOnly: true };
  }
  try {
    const meta = await api('/api/actions');
    state.actions = Object.fromEntries((meta.actions || []).map((a) => [a.id, a]));
  } catch {
    state.actions = {};
  }
  if (!VIEWS.some((v) => v.id === state.view)) state.view = 'overview';
  renderMachineCard();
  renderModeBadge();
  renderNav();
  await loadInventory();
  // Resume watching any jobs already running on the server.
  try {
    const { jobs } = await api('/api/jobs');
    for (const job of jobs || []) {
      if (job.status === 'running' && !state.jobs.has(job.id)) addJob(job.id, job.actionId, {});
    }
  } catch { /* ignore */ }
  await initCapabilities();
  maybeStartOnboarding();
})();
