/* dashboard.js — Besu EVM Benchmark Dashboard */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const DATA_BASE = 'data/runs';
const INDEX_URL = `${DATA_BASE}/index.json`;

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
    showMsg('bench-tbody', `<tr><td colspan="6" class="msg error">Could not load index.json: ${e.message}</td></tr>`);
    return;
  }

  // Sort oldest → newest
  globalIndex.sort((a, b) => new Date(a.date) - new Date(b.date));

  if (globalIndex.length === 0) {
    showMsg('bench-tbody', '<tr><td colspan="6" class="msg">No benchmark runs found.</td></tr>');
    return;
  }

  populateRunDropdowns();
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
  el('bench-tbody').innerHTML = '<tr><td colspan="6" class="msg">Loading…</td></tr>';
  try {
    latestResults = await fetchJSON(`${DATA_BASE}/${latest.sha}/results.json`);
  } catch (e) {
    el('bench-tbody').innerHTML = `<tr><td colspan="6" class="msg error">Failed to load results: ${e.message}</td></tr>`;
    return;
  }

  // Load previous results for delta column
  if (prev) {
    try {
      prevResults = await fetchJSON(`${DATA_BASE}/${prev.sha}/results.json`);
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
  const regressions = latestResults.filter(e => e._hasPrev && !e._noisy && e._delta > 10).length;
  const improvements = latestResults.filter(e => e._hasPrev && !e._noisy && e._delta < -10).length;

  const maxEntry = latestResults.find(e => e._score === max);
  const minEntry = latestResults.find(e => e._score === min);

  el('summary-cards').innerHTML = `
    <div class="card">
      <div class="card-label">Benchmarks</div>
      <div class="card-value">${latestResults.length}</div>
      <div class="card-sub">${latest.benchmark_filter === 'all' ? 'full suite' : latest.benchmark_filter}</div>
    </div>
    <div class="card">
      <div class="card-label">Regressions</div>
      <div class="card-value" style="color:${regressions > 0 ? 'var(--red)' : 'var(--green)'}">${prev ? regressions : '—'}</div>
      <div class="card-sub">${prev ? '> 10% vs previous' : 'no previous run'}</div>
    </div>
    <div class="card">
      <div class="card-label">Improvements</div>
      <div class="card-value" style="color:var(--green)">${prev ? improvements : '—'}</div>
      <div class="card-sub">${prev ? '> 10% faster' : 'no previous run'}</div>
    </div>
    <div class="card">
      <div class="card-label">Fastest</div>
      <div class="card-value" style="font-size:14px; padding-top:6px;">${min.toFixed(2)} ns/op</div>
      <div class="card-sub">${minEntry ? minEntry._name : '—'}</div>
    </div>
    <div class="card">
      <div class="card-label">Slowest</div>
      <div class="card-value" style="font-size:14px; padding-top:6px;">${max.toFixed(0)} ns/op</div>
      <div class="card-sub">${maxEntry ? maxEntry._name : '—'}</div>
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
    rows = rows.filter(e => e._hasPrev && !e._noisy && e._delta > 10);
  } else if (statusFilter === 'improvement') {
    rows = rows.filter(e => e._hasPrev && !e._noisy && e._delta < -10);
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
  if (e._hasPrev && !e._noisy && e._delta > 10)  return 0; // regression first
  if (e._hasPrev && !e._noisy && e._delta < -10) return 1; // improvement
  if (e._hasPrev && e._noisy)                    return 2; // noisy
  if (!e._hasPrev)                               return 3; // new/no baseline
  return 4; // ok
}

function statusLabel(e) {
  if (!e._hasPrev)                               return '<span style="color:var(--muted)">—</span>';
  if (e._noisy)                                  return '<span style="color:var(--muted)" title="Confidence intervals overlap — measurement noise">⚠ noisy</span>';
  if (e._delta > 10)                             return '<span style="color:var(--red)">✗ regression</span>';
  if (e._delta < -10)                            return '<span style="color:var(--green)">↑ faster</span>';
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
  ['name','params','score','error','delta','status'].forEach(col => {
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
    tbody.innerHTML = '<tr><td colspan="6" class="msg">No benchmarks match the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(e => `
    <tr data-key="${escapeAttr(e._key)}" class="${e._key === selectedKey ? 'selected' : ''}" onclick="selectBenchmark(this, '${escapeAttr(e._key)}')">
      <td>${escapeHTML(e._name)}</td>
      <td class="muted">${escapeHTML(e._params)}</td>
      <td class="num">${e._score.toFixed(2)}</td>
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

  // Find the entry in latest results to get display name
  const entry = latestResults.find(e => e._key === key);
  if (!entry) return;

  el('trend-title').textContent = `${entry._name} — ${entry._params}`;
  el('trend-sub').textContent   = 'Historical ns/op across stored runs (lower is better)';

  const { labels, scores, errors } = await loadTrendData(key);

  destroyChart('trendChart');
  trendChart = buildLineChart('trend-chart', labels, scores, errors);
}

async function renderTrendFromTab(key) {
  if (!key) return;

  const entry = latestResults.find(e => e._key === key) ||
                { _name: key.split('|')[0].split('.').slice(-2, -1)[0], _params: '' };

  el('trend-tab-title').textContent = entry._name + (entry._params && entry._params !== '—' ? ` — ${entry._params}` : '');
  el('trend-tab-sub').textContent   = 'Historical ns/op across stored runs (lower is better)';
  el('trend-tab-chart-wrap').style.display = 'block';
  el('trend-tab-hint').style.display = 'none';

  const { labels, scores, errors } = await loadTrendData(key);

  destroyChart('trendTabChart');
  trendTabChart = buildLineChart('trend-tab-chart', labels, scores, errors);
}

async function loadTrendData(key) {
  // Load up to 20 most recent runs
  const slice = globalIndex.slice(-20);
  const labels = [];
  const scores = [];
  const errors = [];

  for (const run of slice) {
    try {
      const results = await fetchJSON(`${DATA_BASE}/${run.sha}/results.json`);
      const match = results.find(e => benchKey(e) === key);
      if (match) {
        labels.push(fmtDateShort(run.date) + ' (' + shortenSHA(run.sha) + ')');
        scores.push(match.primaryMetric.score);
        errors.push(match.primaryMetric.scoreError);
      }
    } catch (_) { /* skip failed loads */ }
  }

  return { labels, scores, errors };
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
    `<option value="${r.sha}">${fmtDateShort(r.date)} — ${shortenSHA(r.sha)} (${r.ref}) — ${r.benchmark_count} benchmarks</option>`
  ).join('');

  el('compare-a').innerHTML = opts;
  el('compare-b').innerHTML = opts;

  // Default: A = second-to-last, B = last
  if (globalIndex.length >= 2) {
    el('compare-a').value = globalIndex[globalIndex.length - 2].sha;
    el('compare-b').value = globalIndex[globalIndex.length - 1].sha;
  } else {
    el('compare-a').value = globalIndex[0].sha;
    el('compare-b').value = globalIndex[0].sha;
  }
}

async function runComparison() {
  const shaA = el('compare-a').value;
  const shaB = el('compare-b').value;
  const btn  = el('compare-btn');

  if (!shaA || !shaB) return;

  btn.disabled    = true;
  btn.textContent = 'Loading…';
  el('compare-result').innerHTML = '<div class="msg">Fetching results…</div>';

  try {
    const [dataA, dataB] = await Promise.all([
      fetchJSON(`${DATA_BASE}/${shaA}/results.json`),
      fetchJSON(`${DATA_BASE}/${shaB}/results.json`),
    ]);

    const metaA = globalIndex.find(r => r.sha === shaA);
    const metaB = globalIndex.find(r => r.sha === shaB);

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

// ── Entry point ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
