/* dashboard.js — Besu EVM Benchmark Dashboard */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const DATA_BASE = 'data/runs';
const INDEX_URL = `${DATA_BASE}/index.json`;

const REGRESSION_THRESHOLD_PCT = 5;

// (1e9 ns/s ÷ ns/op) × gas/op ÷ 1e6 = MGas/s.
function computeMGasPerSec(scoreNsPerOp, gas) {
  if (gas == null || !isFinite(scoreNsPerOp) || scoreNsPerOp < 0.5) return null;
  return gas * 1000 / scoreNsPerOp;
}

// ── State ──────────────────────────────────────────────────────────────────

let globalIndex    = [];   // all run metadata, sorted oldest-first
let latestResults  = [];   // current run's JMH entries
let prevResults    = [];   // previous run's JMH entries (for delta column)
let prevIndex      = null; // metadata entry for previous run
let prevMap        = {};   // benchKey → entry, for O(1) delta lookup
let sortCol        = 'score';
let sortAsc        = true;
let activeTab      = 'latest';
let trendChart     = null; // Chart.js instance in latest tab
let trendTabChart  = null; // Chart.js instance in trend tab
let selectedKey    = null; // currently selected benchmark key
let trendMode        = 'line';
let trendTabMode     = 'line';
let lastTrendData    = null;
let lastTrendTabData = null;

// ── Utilities ──────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

function benchKey(entry) {
  const params = entry.params || {};
  return entry.benchmark + '|' + JSON.stringify(Object.entries(params).sort());
}

function shortName(entry) {
  const parts = entry.benchmark.split('.');
  // class name is second-to-last segment; method name is last
  return parts.length >= 2 ? parts[parts.length - 2] : entry.benchmark;
}

function paramsDisplay(entry) {
  const params = entry.params || {};
  const vals = Object.values(params);
  return vals.length ? vals.join(', ') : '—';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toUTCString().replace(' GMT', ' UTC').replace(/:\d\d /, ' ');
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function shortenSHA(sha) {
  return sha ? sha.slice(0, 7) : '—';
}

function el(id) { return document.getElementById(id); }

function showMsg(containerId, text, isError = false) {
  const c = el(containerId);
  if (c) c.innerHTML = `<div class="msg ${isError ? 'error' : ''}">${text}</div>`;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  try {
    globalIndex = await fetchJSON(INDEX_URL);
  } catch (e) {
    showMsg('bench-tbody', `<tr><td colspan="7" class="msg error">Could not load index.json: ${e.message}</td></tr>`);
    return;
  }

  // Sort oldest → newest
  globalIndex.sort((a, b) => new Date(a.date) - new Date(b.date));

  if (globalIndex.length === 0) {
    showMsg('bench-tbody', '<tr><td colspan="7" class="msg">No benchmark runs found.</td></tr>');
    return;
  }

  populateRunDropdowns();
  populateNoiseShaSelect();
  showTab('latest');
}

// ── Tab routing ────────────────────────────────────────────────────────────

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.style.display = c.id === `tab-${tab}` ? 'block' : 'none';
  });

  if (tab === 'latest' && latestResults.length === 0) renderLatestRun();
  if (tab === 'trend' && latestResults.length > 0) buildTrendSelect();
}

// ── Latest Run View ────────────────────────────────────────────────────────

async function renderLatestRun() {
  const latest = globalIndex[globalIndex.length - 1];
  const prev   = globalIndex.length >= 2 ? globalIndex[globalIndex.length - 2] : null;

  // Populate meta bar
  el('meta-bar').classList.remove('hidden');
  el('meta-ref').textContent     = latest.ref || '—';
  el('meta-sha').textContent     = shortenSHA(latest.sha);
  el('meta-date').textContent    = fmtDateShort(latest.date);
  el('meta-runner').textContent  = `${latest.runner_os || '?'} / ${latest.runner_arch || '?'}`;
  el('meta-count').textContent   = latest.benchmark_count || '—';

  // Load results
  el('bench-tbody').innerHTML = '<tr><td colspan="7" class="msg">Loading…</td></tr>';
  try {
    latestResults = await fetchJSON(`${DATA_BASE}/${latest.run_id}/results.json`);
  } catch (e) {
    el('bench-tbody').innerHTML = `<tr><td colspan="7" class="msg error">Failed to load results: ${e.message}</td></tr>`;
    return;
  }

  // Load previous results for delta column
  if (prev) {
    try {
      prevResults = await fetchJSON(`${DATA_BASE}/${prev.run_id}/results.json`);
      prevIndex   = prev;
    } catch (_) {
      prevResults = [];
      prevIndex   = null;
    }
  }
  prevMap = {};
  for (const e of prevResults) prevMap[benchKey(e)] = e;

  // Annotate entries with computed values
  latestResults.forEach(entry => {
    entry._key    = benchKey(entry);
    entry._name   = shortName(entry);
    entry._params = paramsDisplay(entry);
    entry._score  = entry.primaryMetric.score;
    entry._error  = entry.primaryMetric.scoreError;
    const gas     = entry.secondaryMetrics?.gas?.score ?? null;
    entry._mgas   = computeMGasPerSec(entry._score, gas);

    const prev = prevMap[entry._key];
    if (prev && prev.primaryMetric.score !== 0) {
      const bs = prev.primaryMetric.score;
      const be = prev.primaryMetric.scoreError;
      const cs = entry._score;
      const ce = entry._error;
      const delta = (cs - bs) / bs * 100;
      const overlap = (cs - ce) <= (bs + be) && (bs - be) <= (cs + ce);
      entry._delta  = delta;
      entry._noisy  = overlap;
      entry._hasPrev = true;
    } else {
      entry._delta   = null;
      entry._noisy   = false;
      entry._hasPrev = false;
    }
  });

  // Summary cards
  renderSummaryCards(latest, prev);

  // Render table
  renderTable();
}

function renderSummaryCards(latest, prev) {
  const scores = latestResults.map(e => e._score);
  const max    = Math.max(...scores);
  const min    = Math.min(...scores);
  const regressions = latestResults.filter(e => e._hasPrev && !e._noisy && e._delta > REGRESSION_THRESHOLD_PCT).length;
  const improvements = latestResults.filter(e => e._hasPrev && !e._noisy && e._delta < -REGRESSION_THRESHOLD_PCT).length;

  const maxEntry = latestResults.find(e => e._score === max);
  const minEntry = latestResults.find(e => e._score === min);

  el('summary-cards').innerHTML = `
    <div class="card">
      <div class="card-label">Benchmarks</div>
      <div class="card-value">${latestResults.length}</div>
      <div class="card-sub">${latest.benchmark_filter === 'all' ? 'full suite' : escapeHTML(latest.benchmark_filter)}</div>
    </div>
    <div class="card">
      <div class="card-label">Regressions</div>
      <div class="card-value" style="color:${regressions > 0 ? 'var(--red)' : 'var(--green)'}">${prev ? regressions : '—'}</div>
      <div class="card-sub">${prev ? `> ${REGRESSION_THRESHOLD_PCT}% vs previous` : 'no previous run'}</div>
    </div>
    <div class="card">
      <div class="card-label">Improvements</div>
      <div class="card-value" style="color:var(--green)">${prev ? improvements : '—'}</div>
      <div class="card-sub">${prev ? `> ${REGRESSION_THRESHOLD_PCT}% faster` : 'no previous run'}</div>
    </div>
    <div class="card">
      <div class="card-label">Fastest</div>
      <div class="card-value" style="font-size:14px; padding-top:6px;">${min.toFixed(2)} ns/op</div>
      <div class="card-sub">${minEntry ? escapeHTML(minEntry._name) : '—'}</div>
    </div>
    <div class="card">
      <div class="card-label">Slowest</div>
      <div class="card-value" style="font-size:14px; padding-top:6px;">${max.toFixed(0)} ns/op</div>
      <div class="card-sub">${maxEntry ? escapeHTML(maxEntry._name) : '—'}</div>
    </div>
    <div class="card">
      <div class="card-label">Runs stored</div>
      <div class="card-value">${globalIndex.length}</div>
      <div class="card-sub">in benchmark-results</div>
    </div>
  `;
}

// ── Table rendering + sorting ──────────────────────────────────────────────

function sortBy(col) {
  if (sortCol === col) {
    sortAsc = !sortAsc;
  } else {
    sortCol = col;
    sortAsc = col === 'name' || col === 'params'; // text cols default asc; numeric cols default asc too
  }
  renderTable();
}

function applyFilter() {
  renderTable();
}

function getFilteredSorted() {
  const query       = (el('search-input')?.value || '').toLowerCase().trim();
  const statusFilter = el('status-filter')?.value || 'all';

  let rows = latestResults.slice();

  // Text filter
  if (query) {
    rows = rows.filter(e =>
      e._name.toLowerCase().includes(query) ||
      e._params.toLowerCase().includes(query) ||
      e.benchmark.toLowerCase().includes(query)
    );
  }

  // Status filter
  if (statusFilter === 'regression') {
    rows = rows.filter(e => e._hasPrev && !e._noisy && e._delta > REGRESSION_THRESHOLD_PCT);
  } else if (statusFilter === 'improvement') {
    rows = rows.filter(e => e._hasPrev && !e._noisy && e._delta < -REGRESSION_THRESHOLD_PCT);
  } else if (statusFilter === 'noisy') {
    rows = rows.filter(e => e._hasPrev && e._noisy);
  }

  // Sort
  rows.sort((a, b) => {
    let va, vb;
    switch (sortCol) {
      case 'name':   va = a._name;   vb = b._name;   break;
      case 'params': va = a._params; vb = b._params; break;
      case 'error':  va = a._error;  vb = b._error;  break;
      case 'mgas':
        va = a._mgas ?? (sortAsc ? Infinity : -Infinity);
        vb = b._mgas ?? (sortAsc ? Infinity : -Infinity);
        break;
      case 'delta':
        va = a._delta ?? (sortAsc ? Infinity : -Infinity);
        vb = b._delta ?? (sortAsc ? Infinity : -Infinity);
        break;
      case 'status': va = statusOrder(a); vb = statusOrder(b); break;
      default:       va = a._score;  vb = b._score;  break;
    }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ?  1 : -1;
    return 0;
  });

  return rows;
}

function statusOrder(e) {
  if (e._hasPrev && !e._noisy && e._delta > REGRESSION_THRESHOLD_PCT)  return 0; // regression first
  if (e._hasPrev && !e._noisy && e._delta < -REGRESSION_THRESHOLD_PCT) return 1; // improvement
  if (e._hasPrev && e._noisy)                                          return 2; // noisy
  if (!e._hasPrev)                                                     return 3; // new/no baseline
  return 4; // ok
}

function statusLabel(e) {
  if (!e._hasPrev)                                    return '<span style="color:var(--muted)">—</span>';
  if (e._noisy)                                       return '<span style="color:var(--muted)" title="Confidence intervals overlap — measurement noise">⚠ noisy</span>';
  if (e._delta > REGRESSION_THRESHOLD_PCT)            return '<span style="color:var(--red)">✗ regression</span>';
  if (e._delta < -REGRESSION_THRESHOLD_PCT)           return '<span style="color:var(--green)">↑ faster</span>';
  return '<span style="color:var(--muted)">✓ ok</span>';
}

function deltaCell(e) {
  if (!e._hasPrev) return '<td class="num muted">—</td>';
  const pct = e._delta.toFixed(1);
  const cls = e._noisy ? 'delta-noise' : (e._delta > 0 ? 'delta-pos' : 'delta-neg');
  const sign = e._delta > 0 ? '+' : '';
  return `<td class="num ${cls}">${sign}${pct}%</td>`;
}

function updateSortArrows() {
  ['name','params','score','mgas','error','delta','status'].forEach(col => {
    const arr = el(`arr-${col}`);
    if (!arr) return;
    arr.textContent = sortCol === col ? (sortAsc ? '↑' : '↓') : '';
    const th = arr.closest('th');
    if (th) th.classList.toggle('sorted', sortCol === col);
  });
}

function renderTable() {
  const rows = getFilteredSorted();
  el('result-count').textContent = `${rows.length} of ${latestResults.length} benchmarks`;
  updateSortArrows();

  const tbody = el('bench-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="msg">No benchmarks match the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(e => `
    <tr data-key="${escapeAttr(e._key)}" class="${e._key === selectedKey ? 'selected' : ''}" onclick="selectBenchmark(this, '${escapeAttr(e._key)}')">
      <td>${escapeHTML(e._name)}</td>
      <td class="muted">${escapeHTML(e._params)}</td>
      <td class="num">${e._score.toFixed(2)}</td>
      <td class="num ${e._mgas === null ? 'muted' : ''}">${e._mgas === null ? '—' : e._mgas.toFixed(1)}</td>
      <td class="num muted">± ${e._error.toFixed(2)}</td>
      ${deltaCell(e)}
      <td>${statusLabel(e)}</td>
    </tr>
  `).join('');
}

// ── Trend (inline in Latest Run tab) ──────────────────────────────────────

async function selectBenchmark(row, key) {
  // Toggle selection
  if (selectedKey === key) {
    selectedKey = null;
    document.querySelectorAll('#bench-tbody tr').forEach(r => r.classList.remove('selected'));
    el('trend-panel').classList.add('hidden');
    destroyChart('trendChart');
    return;
  }

  selectedKey = key;
  document.querySelectorAll('#bench-tbody tr').forEach(r => {
    r.classList.toggle('selected', r.dataset.key === key);
  });

  await renderInlineTrend(key);
}

async function renderInlineTrend(key) {
  const panel = el('trend-panel');
  panel.classList.remove('hidden');

  const entry = latestResults.find(e => e._key === key);
  if (!entry) return;

  el('trend-title').textContent = `${entry._name} — ${entry._params}`;
  el('trend-sub').textContent   = trendSubText(trendMode);

  lastTrendData = await loadTrendData(key);

  destroyChart('trendChart');
  if (trendMode === 'mgas') {
    trendChart = lastTrendData.hasMgas
      ? buildBoxPlotChart('trend-chart', lastTrendData.labels, lastTrendData.mgasRaw, 'MGas/s (higher is better)')
      : null;
  } else {
    trendChart = trendMode === 'box'
      ? buildBoxPlotChart('trend-chart', lastTrendData.labels, lastTrendData.raw, 'ns/op (lower is better)')
      : buildLineChart('trend-chart', lastTrendData.labels, lastTrendData.scores, lastTrendData.errors);
  }
}

async function renderTrendFromTab(key) {
  if (!key) return;

  const entry = latestResults.find(e => e._key === key) ||
                { _name: key.split('|')[0].split('.').slice(-2, -1)[0], _params: '' };

  el('trend-tab-title').textContent = entry._name + (entry._params && entry._params !== '—' ? ` — ${entry._params}` : '');
  el('trend-tab-sub').textContent   = trendSubText(trendTabMode);
  el('trend-tab-chart-wrap').style.display = 'block';
  el('trend-tab-hint').style.display = 'none';

  lastTrendTabData = await loadTrendData(key);

  destroyChart('trendTabChart');
  if (trendTabMode === 'mgas') {
    trendTabChart = lastTrendTabData.hasMgas
      ? buildBoxPlotChart('trend-tab-chart', lastTrendTabData.labels, lastTrendTabData.mgasRaw, 'MGas/s (higher is better)')
      : null;
  } else {
    trendTabChart = trendTabMode === 'box'
      ? buildBoxPlotChart('trend-tab-chart', lastTrendTabData.labels, lastTrendTabData.raw, 'ns/op (lower is better)')
      : buildLineChart('trend-tab-chart', lastTrendTabData.labels, lastTrendTabData.scores, lastTrendTabData.errors);
  }
}

function setTrendMode(mode) {
  if (mode === trendMode) return;
  trendMode = mode;
  el('trend-mode-line').classList.toggle('active', mode === 'line');
  el('trend-mode-box').classList.toggle('active', mode === 'box');
  el('trend-mode-mgas').classList.toggle('active', mode === 'mgas');
  if (!lastTrendData) return;
  el('trend-sub').textContent = trendSubText(mode);
  destroyChart('trendChart');
  if (mode === 'mgas') {
    trendChart = lastTrendData.hasMgas
      ? buildBoxPlotChart('trend-chart', lastTrendData.labels, lastTrendData.mgasRaw, 'MGas/s (higher is better)')
      : null;
  } else {
    trendChart = mode === 'box'
      ? buildBoxPlotChart('trend-chart', lastTrendData.labels, lastTrendData.raw, 'ns/op (lower is better)')
      : buildLineChart('trend-chart', lastTrendData.labels, lastTrendData.scores, lastTrendData.errors);
  }
}

function setTrendTabMode(mode) {
  if (mode === trendTabMode) return;
  trendTabMode = mode;
  el('trend-tab-mode-line').classList.toggle('active', mode === 'line');
  el('trend-tab-mode-box').classList.toggle('active', mode === 'box');
  el('trend-tab-mode-mgas').classList.toggle('active', mode === 'mgas');
  if (!lastTrendTabData) return;
  el('trend-tab-sub').textContent = trendSubText(mode);
  destroyChart('trendTabChart');
  if (mode === 'mgas') {
    trendTabChart = lastTrendTabData.hasMgas
      ? buildBoxPlotChart('trend-tab-chart', lastTrendTabData.labels, lastTrendTabData.mgasRaw, 'MGas/s (higher is better)')
      : null;
  } else {
    trendTabChart = mode === 'box'
      ? buildBoxPlotChart('trend-tab-chart', lastTrendTabData.labels, lastTrendTabData.raw, 'ns/op (lower is better)')
      : buildLineChart('trend-tab-chart', lastTrendTabData.labels, lastTrendTabData.scores, lastTrendTabData.errors);
  }
}

async function loadTrendData(key) {
  const slice = globalIndex.slice(-20);
  const labels      = [];
  const scores      = [];
  const errors      = [];
  const raw         = [];
  const gasPerOpByRun = [];

  for (const run of slice) {
    try {
      const results = await fetchJSON(`${DATA_BASE}/${run.run_id}/results.json`);
      const match = results.find(e => benchKey(e) === key);
      if (match) {
        labels.push(fmtDateShort(run.date) + ' (' + shortenSHA(run.sha) + ')');
        scores.push(match.primaryMetric.score);
        errors.push(match.primaryMetric.scoreError);
        const rd = match.primaryMetric.rawData;
        raw.push(Array.isArray(rd) ? rd.flat() : []);
        gasPerOpByRun.push(match.secondaryMetrics?.gas?.score ?? null);
      }
    } catch (_) { /* skip failed loads */ }
  }

  const mgasScores = scores.map((s, i) => computeMGasPerSec(s, gasPerOpByRun[i]));
  const mgasRaw    = raw.map((pts, i) => {
    const g = gasPerOpByRun[i];
    return g != null ? pts.map(ns => g * 1000 / ns) : [];
  });
  const hasMgas = mgasScores.some(v => v !== null);

  return { labels, scores, errors, raw, hasMgas, mgasScores, mgasRaw };
}

function buildLineChart(canvasId, labels, scores, errors) {
  const ctx = el(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Score (ns/op)',
        data: scores,
        borderColor: '#388bfd',
        backgroundColor: '#388bfd22',
        borderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.1,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const idx = ctx.dataIndex;
              const e   = errors[idx];
              return `${ctx.parsed.y.toFixed(2)} ± ${e.toFixed(2)} ns/op`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxRotation: 45, font: { size: 11 } },
          grid:  { color: '#30363d' }
        },
        y: {
          title: { display: true, text: 'ns/op (lower is better)', color: '#8b949e' },
          ticks: { color: '#8b949e' },
          grid:  { color: '#30363d' }
        }
      }
    }
  });
}

// chartjs-chart-boxplot summarises each inner array (Tukey, 1.5×IQR whiskers).
function buildBoxPlotChart(canvasId, labels, rawByRun, yLabel = 'ns/op (lower is better)') {
  const ctx = el(canvasId).getContext('2d');

  // Tight-scale Y so stable benchmarks don't render as hairlines.
  const flat = rawByRun.flat().filter(v => Number.isFinite(v));
  const dataMin = flat.length ? Math.min(...flat) : 0;
  const dataMax = flat.length ? Math.max(...flat) : 1;
  const pad     = Math.max((dataMax - dataMin) * 0.15, dataMax * 0.02);
  const yMin    = Math.max(0, dataMin - pad);
  const yMax    = dataMax + pad;

  return new Chart(ctx, {
    type: 'boxplot',
    data: {
      labels,
      datasets: [{
        label: 'ns/op distribution',
        data: rawByRun,
        backgroundColor: '#388bfd33',
        borderColor: '#388bfd',
        borderWidth: 1.5,
        medianColor: '#f0f6fc',
        itemRadius: 2,
        itemStyle: 'circle',
        itemBackgroundColor: '#8b949e88',
        outlierRadius: 3,
        outlierBackgroundColor: '#f8514933',
        outlierBorderColor: '#f85149',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const p = item.parsed;
              if (!p) return '';
              const f = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
              const n = Array.isArray(p.items) ? p.items.length : '—';
              return [
                `median: ${f(p.median)} ns/op`,
                `Q1–Q3:  ${f(p.q1)}–${f(p.q3)}`,
                `min–max: ${f(p.min)}–${f(p.max)}`,
                `n = ${n} (3 forks × 5 iterations)`,
              ];
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxRotation: 45, font: { size: 11 } },
          grid:  { color: '#30363d' }
        },
        y: {
          title: { display: true, text: yLabel, color: '#8b949e' },
          ticks: { color: '#8b949e' },
          grid:  { color: '#30363d' },
          min:   yMin,
          max:   yMax,
        }
      }
    }
  });
}

function trendSubText(mode) {
  if (mode === 'mgas') return 'Per-run MGas/s distribution derived from raw ns/op measurements (higher is better).';
  return mode === 'box'
    ? 'Per-run distribution of raw ns/op measurements. Each box = 15 points (3 forks × 5 iterations).'
    : 'Historical ns/op across stored runs (lower is better).';
}

function destroyChart(which) {
  if (which === 'trendChart' && trendChart) {
    trendChart.destroy();
    trendChart = null;
  }
  if (which === 'trendTabChart' && trendTabChart) {
    trendTabChart.destroy();
    trendTabChart = null;
  }
}

// ── Trend tab ──────────────────────────────────────────────────────────────

function buildTrendSelect() {
  const wrap = el('trend-tab-select-wrap');
  if (!wrap || latestResults.length === 0) return;

  // Group by class name
  const options = latestResults.map(e =>
    `<option value="${escapeAttr(e._key)}">${escapeHTML(e._name)} — ${escapeHTML(e._params)}</option>`
  ).join('');

  wrap.innerHTML = `
    <div style="display:flex; gap:10px; align-items:center;">
      <select id="trend-select" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:6px 10px;min-width:360px;outline:none;">
        <option value="">— Select a benchmark —</option>
        ${options}
      </select>
      <button class="btn" onclick="renderTrendFromTab(document.getElementById('trend-select').value)">Show Trend</button>
    </div>
  `;
}

// ── Compare Runs View ──────────────────────────────────────────────────────

function populateRunDropdowns() {
  const opts = globalIndex.map((r, i) =>
    `<option value="${escapeAttr(r.run_id)}">${fmtDateShort(r.date)} — ${shortenSHA(r.sha)} (${escapeHTML(r.ref)}) — ${r.benchmark_count} benchmarks</option>`
  ).join('');

  el('compare-a').innerHTML = opts;
  el('compare-b').innerHTML = opts;

  // Default: A = second-to-last, B = last
  if (globalIndex.length >= 2) {
    el('compare-a').value = globalIndex[globalIndex.length - 2].run_id;
    el('compare-b').value = globalIndex[globalIndex.length - 1].run_id;
  } else {
    el('compare-a').value = globalIndex[0].run_id;
    el('compare-b').value = globalIndex[0].run_id;
  }
}

async function runComparison() {
  const runIdA = el('compare-a').value;
  const runIdB = el('compare-b').value;
  const btn    = el('compare-btn');

  if (!runIdA || !runIdB) return;

  btn.disabled    = true;
  btn.textContent = 'Loading…';
  el('compare-result').innerHTML = '<div class="msg">Fetching results…</div>';

  try {
    const [dataA, dataB] = await Promise.all([
      fetchJSON(`${DATA_BASE}/${runIdA}/results.json`),
      fetchJSON(`${DATA_BASE}/${runIdB}/results.json`),
    ]);

    const metaA = globalIndex.find(r => r.run_id === runIdA);
    const metaB = globalIndex.find(r => r.run_id === runIdB);

    renderCompareTable(dataA, dataB, metaA, metaB);
  } catch (e) {
    el('compare-result').innerHTML = `<div class="msg error">Failed: ${e.message}</div>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Compare';
  }
}

function renderCompareTable(dataA, dataB, metaA, metaB) {
  const mapA = {};
  for (const e of dataA) mapA[benchKey(e)] = e;

  const mapB = {};
  for (const e of dataB) mapB[benchKey(e)] = e;

  const allKeys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);

  const rows = [];
  for (const key of allKeys) {
    const a = mapA[key];
    const b = mapB[key];
    if (a && b) {
      const sa = a.primaryMetric.score;
      const sb = b.primaryMetric.score;
      const speedup = sa !== 0 ? sa / sb : null;
      rows.push({ key, a, b, sa, sb, speedup, status: 'both' });
    } else if (a && !b) {
      rows.push({ key, a, b: null, sa: a.primaryMetric.score, sb: null, speedup: null, status: 'missing' });
    } else {
      rows.push({ key, a: null, b, sa: null, sb: b.primaryMetric.score, speedup: null, status: 'new' });
    }
  }

  // Sort: slowdowns first (speedup < 1), then by speedup desc (most improved first), missing last
  rows.sort((x, y) => {
    if (x.status !== y.status) {
      const o = { both: 0, missing: 1, new: 2 };
      return (o[x.status] || 0) - (o[y.status] || 0);
    }
    if (x.speedup !== null && y.speedup !== null) return x.speedup - y.speedup;
    return 0;
  });

  const labelA = `${fmtDateShort(metaA?.date)} ${shortenSHA(metaA?.sha)}`;
  const labelB = `${fmtDateShort(metaB?.date)} ${shortenSHA(metaB?.sha)}`;

  const regression = rows.filter(r => r.speedup !== null && r.speedup < 0.9).length;
  const improved   = rows.filter(r => r.speedup !== null && r.speedup > 1.1).length;

  const tableRows = rows.map(r => {
    const name   = r.a ? shortName(r.a) : shortName(r.b);
    const params = r.a ? paramsDisplay(r.a) : paramsDisplay(r.b);
    const colA = r.a ? `${r.sa.toFixed(2)} ± ${r.a.primaryMetric.scoreError.toFixed(2)}` : '—';
    const colB = r.b ? `${r.sb.toFixed(2)} ± ${r.b.primaryMetric.scoreError.toFixed(2)}` : '—';

    let speedupCell = '—';
    if (r.speedup !== null) {
      const pct  = ((r.speedup - 1) * 100).toFixed(1);
      const sign = r.speedup >= 1 ? '+' : '';
      const cls  = r.speedup > 1.1 ? 'faster' : (r.speedup < 0.9 ? 'slower' : 'same');
      const label = r.speedup > 1.1 ? `${r.speedup.toFixed(2)}x faster` :
                    r.speedup < 0.9 ? `${(1/r.speedup).toFixed(2)}x slower` : 'similar';
      speedupCell = `<span class="${cls}">${label}</span> <span style="color:var(--muted);font-size:11px;">(${sign}${pct}%)</span>`;
    }

    const rowStatus = r.status === 'new'     ? '<span style="color:var(--accent)">new</span>' :
                      r.status === 'missing' ? '<span style="color:var(--muted)">removed</span>' : '';

    return `
      <tr>
        <td>${escapeHTML(name)} ${rowStatus}</td>
        <td class="muted">${escapeHTML(params)}</td>
        <td class="num">${colA}</td>
        <td class="num">${colB}</td>
        <td>${speedupCell}</td>
      </tr>
    `;
  }).join('');

  el('compare-result').innerHTML = `
    <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:16px; font-size:13px; color:var(--muted);">
      <span>Run A: <strong style="color:var(--text);">${labelA}</strong></span>
      <span>Run B: <strong style="color:var(--text);">${labelB}</strong></span>
      <span>Compared: <strong style="color:var(--text);">${rows.filter(r=>r.status==='both').length}</strong></span>
      <span style="color:var(--red);">Regressions (&gt;10%): <strong>${regression}</strong></span>
      <span style="color:var(--green);">Improvements (&gt;10%): <strong>${improved}</strong></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Benchmark</th>
            <th>Params</th>
            <th>Run A (ns/op)</th>
            <th>Run B (ns/op)</th>
            <th>Speedup (B vs A)</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Noise Study View ───────────────────────────────────────────────────────

let noiseRows    = [];
let noiseAllRuns    = [];
let noiseAllResults = [];

function populateNoiseShaSelect() {
  const bySha = {};
  for (const run of globalIndex) {
    if (!bySha[run.sha]) bySha[run.sha] = [];
    bySha[run.sha].push(run);
  }

  const eligible = Object.entries(bySha).filter(([, runs]) => runs.length >= 2);
  const select = el('noise-sha-select');
  select.innerHTML = '';

  if (eligible.length === 0) {
    select.innerHTML = '<option value="">No SHA with 2+ runs yet</option>';
    return;
  }

  eligible.sort((a, b) => {
    const latestA = Math.max(...a[1].map(r => new Date(r.date)));
    const latestB = Math.max(...b[1].map(r => new Date(r.date)));
    return latestB - latestA;
  });

  for (const [sha, runs] of eligible) {
    const opt = document.createElement('option');
    opt.value = sha;
    opt.textContent = `${shortenSHA(sha)} — ${runs.length} runs — ${fmtDateShort(runs[0].date)}`;
    select.appendChild(opt);
  }

  onNoiseShaChange();
}

async function onNoiseShaChange() {
  const sha = el('noise-sha-select').value;
  if (!sha) return;

  const runs = globalIndex.filter(r => r.sha === sha);
  el('noise-run-count').textContent = `${runs.length} runs against this commit`;

  el('noise-result').innerHTML = '<div class="msg">Loading results…</div>';
  el('noise-summary-cards').style.display = 'none';
  el('noise-toolbar').style.display = 'none';

  let allResults;
  try {
    allResults = await Promise.all(
      runs.map(r => fetchJSON(`${DATA_BASE}/${r.run_id}/results.json`))
    );
  } catch (e) {
    el('noise-result').innerHTML = `<div class="msg error">Failed to load results: ${escapeHTML(e.message)}</div>`;
    return;
  }

  noiseAllRuns    = runs;
  noiseAllResults = allResults;

  const groups = {};
  runs.forEach((r, i) => {
    const key = r.cpu_model || `${r.runner_os} / ${r.runner_arch}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ run: r, index: i });
  });

  el('noise-runners').innerHTML = Object.entries(groups).map(([cpu, members]) => `
    <div class="noise-group">
      <div class="noise-group-header" onclick="toggleNoiseGroup(this)">
        <span class="noise-group-arrow">▼</span>
        <input type="checkbox" class="noise-group-cb" checked onclick="event.stopPropagation()" onchange="toggleNoiseGroupChecked(this)" />
        <strong style="color:var(--text)">${escapeHTML(cpu)}</strong>
        <span class="noise-group-count">(${members.length} run${members.length !== 1 ? 's' : ''})</span>
      </div>
      <div class="noise-group-body">
        ${members.map(({ run, index }) => `
          <label>
            <input type="checkbox" class="noise-run-cb" value="${escapeAttr(run.run_id)}" checked onchange="updateNoiseGroupMaster(this); recomputeNoise()" />
            Run ${index + 1}: ${fmtDateShort(run.date)} (${escapeHTML(run.run_id)})
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  recomputeNoise();
}

function toggleNoiseGroup(header) {
  const body = header.nextElementSibling;
  const arrow = header.querySelector('.noise-group-arrow');
  const collapsed = body.classList.toggle('hidden');
  arrow.classList.toggle('collapsed', collapsed);
}

function toggleNoiseGroupChecked(masterCb) {
  const body = masterCb.closest('.noise-group').querySelector('.noise-group-body');
  body.querySelectorAll('.noise-run-cb').forEach(cb => { cb.checked = masterCb.checked; });
  recomputeNoise();
}

function updateNoiseGroupMaster(cb) {
  const body = cb.closest('.noise-group-body');
  const master = body.closest('.noise-group').querySelector('.noise-group-cb');
  const all = Array.from(body.querySelectorAll('.noise-run-cb'));
  const checkedCount = all.filter(c => c.checked).length;
  master.checked = checkedCount > 0;
  master.indeterminate = checkedCount > 0 && checkedCount < all.length;
}

function recomputeNoise() {
  const checked = Array.from(document.querySelectorAll('.noise-run-cb:checked')).map(cb => cb.value);

  if (checked.length < 2) {
    el('noise-result').innerHTML = '<div class="msg">Select at least 2 runs to compare.</div>';
    el('noise-summary-cards').style.display = 'none';
    el('noise-toolbar').style.display = 'none';
    noiseRows = [];
    return;
  }

  const selected = noiseAllRuns
    .map((r, i) => ({ run: r, results: noiseAllResults[i] }))
    .filter(({ run }) => checked.includes(run.run_id));

  const selectedRuns = selected.map(s => s.run);

  const indexed = selected.map(({ results }) => {
    const map = {};
    for (const entry of results) map[benchKey(entry)] = entry;
    return map;
  });

  const commonKeys = Object.keys(indexed[0]).filter(k => indexed.every(m => k in m));

  const rows = commonKeys.map(k => {
    const scores = indexed.map(m => m[k].primaryMetric.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    const cv = mean !== 0 ? (std / mean) * 100 : 0;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const entry = indexed[0][k];
    return { k, cv, mean, std, min, max, entry, scores };
  });

  rows.sort((a, b) => b.cv - a.cv);

  const stable   = rows.filter(r => r.cv < 5).length;
  const medium   = rows.filter(r => r.cv >= 5 && r.cv < 10).length;
  const noisy    = rows.filter(r => r.cv >= 10).length;
  const medianCv = rows.length > 0
    ? rows.map(r => r.cv).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
    : 0;

  el('noise-summary-cards').style.display = 'grid';
  el('noise-summary-cards').innerHTML = `
    <div class="card"><div class="card-label">Benchmarks compared</div><div class="card-value">${rows.length}</div><div class="card-sub">in ${selectedRuns.length} selected runs</div></div>
    <div class="card"><div class="card-label">Median CV</div><div class="card-value" style="color:${medianCv < 5 ? 'var(--green)' : medianCv < 10 ? 'var(--yellow)' : 'var(--red)'}">${medianCv.toFixed(1)}%</div><div class="card-sub">coefficient of variation</div></div>
    <div class="card"><div class="card-label">Stable (CV &lt; 5%)</div><div class="card-value" style="color:var(--green)">${stable}</div><div class="card-sub">low noise</div></div>
    <div class="card"><div class="card-label">Medium (5–10%)</div><div class="card-value" style="color:var(--yellow)">${medium}</div><div class="card-sub">moderate noise</div></div>
    <div class="card"><div class="card-label">Noisy (CV &ge; 10%)</div><div class="card-value" style="color:var(--red)">${noisy}</div><div class="card-sub">high variance</div></div>
  `;

  noiseRows = rows;

  const scoreHeaders = selectedRuns.map(r => {
    const originalIdx = noiseAllRuns.indexOf(r);
    return `<th class="num">Run ${originalIdx + 1} (ns/op)</th>`;
  }).join('');

  el('noise-result').innerHTML = `
    <div class="table-wrap">
      <table id="noise-table">
        <thead>
          <tr>
            <th>Benchmark</th>
            <th>Params</th>
            <th class="num">Mean (ns/op)</th>
            <th class="num">Std Dev</th>
            <th class="num">CV%</th>
            <th class="num">Min</th>
            <th class="num">Max</th>
            ${scoreHeaders}
          </tr>
        </thead>
        <tbody id="noise-tbody"></tbody>
      </table>
    </div>
  `;

  el('noise-toolbar').style.display = 'flex';
  applyNoiseFilter();
}

function applyNoiseFilter() {
  const search = (el('noise-search')?.value || '').toLowerCase();
  const cvFilter = el('noise-cv-filter')?.value || 'all';

  const filtered = noiseRows.filter(r => {
    const name = shortName(r.entry).toLowerCase();
    const params = paramsDisplay(r.entry).toLowerCase();
    const matchesSearch = !search || name.includes(search) || params.includes(search);
    const matchesCv =
      cvFilter === 'all' ||
      (cvFilter === 'stable' && r.cv < 5) ||
      (cvFilter === 'medium' && r.cv >= 5 && r.cv < 10) ||
      (cvFilter === 'noisy'  && r.cv >= 10);
    return matchesSearch && matchesCv;
  });

  const tbody = el('noise-tbody');
  if (!tbody) return;

  tbody.innerHTML = filtered.map(r => {
    const cvClass = r.cv < 5 ? 'cv-stable' : r.cv < 10 ? 'cv-medium' : 'cv-noisy';
    const cvLabel = r.cv < 5 ? 'stable' : r.cv < 10 ? 'medium' : 'noisy';
    const scoreCells = r.scores.map(s => `<td class="num">${s.toFixed(2)}</td>`).join('');
    return `
      <tr>
        <td>${escapeHTML(shortName(r.entry))}</td>
        <td class="muted">${escapeHTML(paramsDisplay(r.entry))}</td>
        <td class="num">${r.mean.toFixed(2)}</td>
        <td class="num">${r.std.toFixed(2)}</td>
        <td class="num"><span class="cv-badge ${cvClass}">${r.cv.toFixed(1)}% ${cvLabel}</span></td>
        <td class="num">${r.min.toFixed(2)}</td>
        <td class="num">${r.max.toFixed(2)}</td>
        ${scoreCells}
      </tr>`;
  }).join('');

  el('noise-result-count').textContent = `${filtered.length} of ${noiseRows.length} benchmarks`;
}

// ── Entry point ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
