/**
 * Turnstone Lite — application principale (aucune étape de build, aucun serveur).
 */

import {
  datasetFromDemoJson,
  datasetFromRows,
  describeDataset,
  mergeDatasets,
  formatAlt,
  formatTime,
  formatDuration,
} from './dataset.js';
import { queryDataset, aggregateByAircraft, buildTimeline, resultsToCsv, aircraftToCsv } from './query.js';
import { MapView, colorFor } from './mapview.js';
import { parseCsv, parseHeatmapBuffer, readTarStream } from './parse.js';
import {
  fetchLive,
  fetchSnapshot,
  fetchSnapshotIndex,
  snapshotTraffic,
  RELAYS,
  RELAYS_PUBLIC,
  BROWSER_PROVIDERS,
  openSkyCost,
  OPENSKY_DAILY_CREDITS,
} from './live.js';
import { ColumnBuilder } from './dataset.js';

const $ = (sel) => document.querySelector(sel);
const nf = new Intl.NumberFormat('fr-FR');

const state = {
  datasets: [],
  active: null,
  activeId: null,
  stats: null,
  bbox: null,
  results: null,
  view: 'map',
  selectedKey: null,
  positionsSort: { key: 't', dir: -1 },
  positionsPage: 0,
  aircraftSort: { key: 'count', dir: -1 },
  aircraftPage: 0,
  importFiles: [],
  worker: null,
};

let mapView = null;

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                 */
/* -------------------------------------------------------------------------- */

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

function openModal(selector) {
  const el = $(selector);
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');
}

function closeModal(selector) {
  const el = $(selector);
  if (typeof el.close === 'function') el.close();
  else el.removeAttribute('open');
}

function setLoading(on, label = 'Analyse…') {
  const el = $('#loading');
  el.hidden = !on;
  el.querySelector('p').textContent = label;
}

function dtToEpoch(value) {
  if (!value) return null;
  const ms = Date.parse(`${value.length === 16 ? value + ':00' : value}Z`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function epochToDt(seconds, round = 'floor') {
  if (seconds === null || seconds === undefined) return '';
  const ms = seconds * 1000;
  // on arrondit au minuteur le plus proche sans jamais exclure les données :
  // le début descend, la fin monte (sinon un jeu de données de < 1 min serait vide)
  const rounded = (round === 'ceil' ? Math.ceil(ms / 60000) : Math.floor(ms / 60000)) * 60000;
  return new Date(rounded).toISOString().slice(0, 16);
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatBytes(bytes) {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/* -------------------------------------------------------------------------- */
/* IndexedDB                                                                   */
/* -------------------------------------------------------------------------- */

const DB_NAME = 'turnstone-lite';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('datasets')) db.createObjectStore('datasets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function persistDataset(id, meta, ds) {
  await dbPut('data', { id, columns: ds.columns, dicts: ds.dicts, n: ds.n });
  await dbPut('datasets', { id, ...meta });
}

async function loadPersistedDataset(id) {
  const row = await dbGet('data', id);
  if (!row) return null;
  return { meta: { id }, n: row.n, columns: row.columns, dicts: row.dicts };
}

/* -------------------------------------------------------------------------- */
/* Jeux de données                                                             */
/* -------------------------------------------------------------------------- */

async function loadDemo() {
  const res = await fetch('data/demo.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Jeu de démonstration introuvable');
  const json = await res.json();
  const ds = datasetFromDemoJson(json);
  const stats = describeDataset(ds);
  const meta = {
    id: 'demo',
    name: json.meta.name || 'Démonstration',
    source: 'demo',
    synthetic: true,
    note: json.meta.note || '',
    day: json.meta.day || null,
    count: stats.count,
    aircraft: stats.aircraft,
    tMin: stats.tMin,
    tMax: stats.tMax,
  };
  return { ds, meta, stats };
}

async function refreshDatasetList() {
  const imported = await dbAll('datasets').catch(() => []);
  const known = new Map(imported.map((d) => [d.id, d]));
  for (const [id, entry] of (state.cache || new Map())) {
    if (id === 'demo' || known.has(id)) continue;
    known.set(id, { id, ...entry.meta });
  }
  imported.length = 0;
  imported.push(...known.values());
  const demoEntry = {
    id: 'demo',
    name: (state.cache.get('demo') || {}).meta?.name || 'Démonstration',
    source: 'demo',
  };
  state.datasets = [demoEntry, ...imported];
  const select = $('#dataset-select');
  select.innerHTML = '';
  for (const d of state.datasets) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    select.appendChild(opt);
  }
  if (state.activeId) select.value = state.activeId;
}

async function activateDataset(id) {
  if (!state.cache) state.cache = new Map();
  let entry = state.cache.get(id);
  if (!entry) {
    if (id === 'demo') {
      entry = await loadDemo();
    } else {
      const ds = await loadPersistedDataset(id);
      if (!ds) {
        toast('Jeu de données introuvable.', 'error');
        return;
      }
      const metaRow = state.datasets.find((d) => d.id === id) || { id };
      entry = { ds, meta: { ...metaRow }, stats: describeDataset(ds) };
    }
    state.cache.set(id, entry);
  }

  state.active = entry.ds;
  state.activeId = id;
  state.stats = entry.stats;
  state.meta = entry.meta;
  state.selectedKey = null;
  state.positionsPage = 0;
  state.aircraftPage = 0;

  $('#dataset-select').value = id;
  $('#dataset-badge').textContent = entry.meta.synthetic ? 'démo' : 'importé';
  $('#dataset-badge').className = `badge ${entry.meta.synthetic ? 'demo' : ''}`;
  $('#btn-delete-dataset').hidden = id === 'demo';

  // catégories disponibles
  const catSelect = $('#category-select');
  catSelect.innerHTML = '<option value="">Toutes</option>';
  for (const cat of state.stats.categories) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    catSelect.appendChild(opt);
  }
  const hasMeta = state.stats.categories.length > 0;
  catSelect.disabled = !hasMeta;
  $('#military-select').disabled = !hasMeta;

  // période par défaut = couverture complète
  $('#start-input').value = epochToDt(state.stats.tMin, 'floor');
  $('#end-input').value = epochToDt(state.stats.tMax, 'ceil');
  document.querySelectorAll('#period-chips button').forEach((b) => b.classList.remove('active'));
  document.querySelector('#period-chips button[data-all]').classList.add('active');

  setBbox(null);
  await runQuery({ fit: true });
}

/* -------------------------------------------------------------------------- */
/* Filtres & zone                                                              */
/* -------------------------------------------------------------------------- */

function readFilters() {
  const bbox = state.bbox;
  return {
    bbox,
    start: dtToEpoch($('#start-input').value),
    end: dtToEpoch($('#end-input').value),
    hex: $('#hex-input').value,
    flight: $('#flight-input').value,
    reg: $('#reg-input').value,
    minAlt: $('#min-alt').value,
    maxAlt: $('#max-alt').value,
    minGs: $('#min-gs').value,
    maxGs: $('#max-gs').value,
    minBrg: $('#min-brg').value,
    maxBrg: $('#max-brg').value,
    category: $('#category-select').value,
    military: $('#military-select').value,
    limit: $('#limit-select').value,
  };
}

function setBbox(bbox) {
  state.bbox = bbox;
  if (mapView) {
    if (bbox) mapView.setBbox(bbox);
    else mapView.clearBbox();
  }
  const label = $('#bbox-label');
  if (!bbox) {
    label.textContent = 'Monde entier';
    return;
  }
  const fmt = (v) => v.toFixed(2);
  label.textContent = `O ${fmt(bbox[0])} · S ${fmt(bbox[1])} · E ${fmt(bbox[2])} · N ${fmt(bbox[3])}`;
}

function applyPeriod(hours) {
  const end = state.stats.tMax || Date.now() / 1000;
  const start = Math.max(state.stats.tMin || end - hours * 3600, end - hours * 3600);
  $('#start-input').value = epochToDt(start, 'floor');
  $('#end-input').value = epochToDt(end, 'ceil');
}

/* -------------------------------------------------------------------------- */
/* Requête & rendu                                                             */
/* -------------------------------------------------------------------------- */

async function runQuery({ fit = false } = {}) {
  if (!state.active) return;
  setLoading(true, 'Recherche…');
  await new Promise((r) => setTimeout(r, 16));

  const t0 = performance.now();
  const filters = readFilters();
  const { indices, truncated } = queryDataset(state.active, filters);
  const aircraft = aggregateByAircraft(state.active, indices);
  const timeline = buildTimeline(state.active, indices, {
    start: filters.start,
    end: filters.end,
  });
  state.results = { indices, aircraft, timeline, truncated, filters, ms: performance.now() - t0 };
  state.selectedKey = null;
  state.positionsPage = 0;
  state.aircraftPage = 0;
  hideDetail();
  renderAll({ fit });
  setLoading(false);
}

function renderAll({ fit = false } = {}) {
  if (!state.results) return;
  renderSummary();
  renderMap(fit);
  renderPositionsTable();
  renderAircraftTable();
  renderTimeline();
}

function renderSummary() {
  const { indices, aircraft, truncated, ms } = state.results;
  const el = $('#result-summary');
  if (!indices.length) {
    el.innerHTML = `<span class="muted">Aucune position ne correspond à ces critères.</span>`;
    return;
  }
  const first = state.active.columns.t[indices[0]];
  const last = state.active.columns.t[indices[indices.length - 1]];
  el.innerHTML = `
    <span><b>${nf.format(indices.length)}</b> positions</span>
    <span><b>${nf.format(aircraft.length)}</b> aéronefs</span>
    <span class="muted">${formatTime(first)} → ${formatTime(last)} UTC</span>
    ${truncated ? '<span class="muted">· limité</span>' : ''}
    ${state.meta && state.meta.synthetic ? '<span class="tag" title="Données simulées pour la démonstration — importez vos propres archives pour du réel">démo simulée</span>' : ''}
    <span class="muted">· ${Math.round(ms)} ms</span>
  `;
  syncTitle();
}

function trackList(limit = 600) {
  const list = state.results.aircraft;
  const shown = list.slice(0, limit);
  return shown.map((a) => ({
    key: a.key,
    hex: a.hex,
    callsign: a.callsign,
    typecode: a.typecode,
    category: a.category,
    track: a.track,
    count: a.count,
  }));
}

function renderMap(fit = false) {
  const { indices, aircraft } = state.results;
  const tracks = trackList();
  mapView.render(tracks, state.selectedKey);
  if (fit && indices.length) {
    const bounds = L.latLngBounds(tracks.flatMap((t) => t.track.map((p) => [p[0], p[1]])));
    if (bounds.isValid()) mapView.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
  }
  const caption = indices.length
    ? `${nf.format(aircraft.length)} aéronefs · ${nf.format(indices.length)} positions${
        aircraft.length > tracks.length ? ` · ${tracks.length} traces affichées` : ''
      }`
    : 'Aucun résultat';
  $('#map-caption').textContent = caption;
}

function updateSortIndicators(tableSelector, sort) {
  document.querySelectorAll(`${tableSelector} th`).forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === sort.key && sort.dir === 1);
    th.classList.toggle('sort-desc', th.dataset.sort === sort.key && sort.dir === -1);
  });
}

function sortedPositions() {
  const { key, dir } = state.positionsSort;
  const ds = state.active;
  const arr = Array.from(state.results.indices);
  const getter = {
    t: (i) => ds.columns.t[i],
    hex: (i) => ds.dicts.hex[ds.columns.h[i]] || '',
    flight: (i) => ds.dicts.flight[ds.columns.f[i]] || '',
    alt: (i) => ds.columns.alt[i],
    gs: (i) => ds.columns.gs[i],
    bearing: (i) => ds.columns.brg[i],
    lat: (i) => ds.columns.lat[i],
    lon: (i) => ds.columns.lon[i],
    registration: (i) => ds.dicts.reg[ds.columns.r[i]] || '',
    typecode: (i) => ds.dicts.type[ds.columns.ty[i]] || '',
  }[key] || ((i) => ds.columns.t[i]);
  arr.sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    if (va === vb) return 0;
    return (va > vb ? 1 : -1) * dir;
  });
  return arr;
}

function renderPositionsTable() {
  const ds = state.active;
  const { indices } = state.results;
  const tbody = $('#positions-table tbody');
  const pager = $('#positions-pager');

  if (!indices.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted">Aucune position.</td></tr>`;
    pager.innerHTML = '';
    return;
  }

  updateSortIndicators('#positions-table', state.positionsSort);
  const sorted = sortedPositions();
  const perPage = 100;
  const pages = Math.ceil(sorted.length / perPage);
  state.positionsPage = Math.min(state.positionsPage, pages - 1);
  const slice = sorted.slice(state.positionsPage * perPage, (state.positionsPage + 1) * perPage);

  const rows = slice.map((i) => {
    const alt = ds.columns.alt[i];
    const gs = ds.columns.gs[i];
    const brg = ds.columns.brg[i];
    return `<tr data-hex="${ds.dicts.hex[ds.columns.h[i]] || ''}" data-key="${ds.columns.h[i]}">
      <td class="num">${formatTime(ds.columns.t[i])}</td>
      <td class="num">${ds.dicts.hex[ds.columns.h[i]] || '—'}</td>
      <td>${ds.dicts.flight[ds.columns.f[i]] || '—'}</td>
      <td class="num">${formatAlt(alt)}</td>
      <td class="num">${gs >= 0 ? `${gs.toFixed(0)} kt` : '—'}</td>
      <td class="num">${brg >= 0 ? `${brg.toFixed(0)}°` : '—'}</td>
      <td class="num">${ds.columns.lat[i].toFixed(4)}</td>
      <td class="num">${ds.columns.lon[i].toFixed(4)}</td>
      <td>${ds.dicts.reg[ds.columns.r[i]] || '—'}</td>
      <td>${ds.dicts.type[ds.columns.ty[i]] || '—'}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
  tbody.querySelectorAll('tr[data-key]').forEach((tr) => {
    tr.addEventListener('click', () => selectAircraft(Number(tr.dataset.key)));
  });

  pager.innerHTML = `
    <button ${state.positionsPage === 0 ? 'disabled' : ''} data-page="prev">‹</button>
    <span>${nf.format(state.positionsPage * perPage + 1)}–${nf.format(
      Math.min((state.positionsPage + 1) * perPage, sorted.length)
    )} sur ${nf.format(sorted.length)}</span>
    <button ${state.positionsPage >= pages - 1 ? 'disabled' : ''} data-page="next">›</button>`;
  pager.querySelector('[data-page="prev"]').onclick = () => {
    state.positionsPage--;
    renderPositionsTable();
  };
  pager.querySelector('[data-page="next"]').onclick = () => {
    state.positionsPage++;
    renderPositionsTable();
  };
}

function sortedAircraft() {
  const { key, dir } = state.aircraftSort;
  return [...state.results.aircraft].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    const na = va === null || va === undefined ? -Infinity : va;
    const nb = vb === null || vb === undefined ? -Infinity : vb;
    if (typeof na === 'string' || typeof nb === 'string') {
      return String(va || '').localeCompare(String(vb || '')) * dir;
    }
    if (na === nb) return 0;
    return (na > nb ? 1 : -1) * dir;
  });
}

function renderAircraftTable() {
  const { aircraft } = state.results;
  const tbody = $('#aircraft-table tbody');
  const pager = $('#aircraft-pager');

  if (!aircraft.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="muted">Aucun aéronef.</td></tr>`;
    pager.innerHTML = '';
    return;
  }
  updateSortIndicators('#aircraft-table', state.aircraftSort);
  const sorted = sortedAircraft();
  const perPage = 50;
  const pages = Math.ceil(sorted.length / perPage);
  state.aircraftPage = Math.min(state.aircraftPage, pages - 1);
  const slice = sorted.slice(state.aircraftPage * perPage, (state.aircraftPage + 1) * perPage);

  tbody.innerHTML = slice
    .map(
      (a) => `<tr data-key="${a.key}" class="${state.selectedKey === a.key ? 'selected' : ''}">
      <td>${a.callsign || '—'} ${a.military ? '<span class="tag mil">mil</span>' : ''}</td>
      <td class="num">${a.hex}</td>
      <td>${a.typecode || '—'}</td>
      <td>${a.category || '—'}</td>
      <td class="num">${nf.format(a.count)}</td>
      <td class="num">${formatDuration(a.duration)}</td>
      <td class="num">${Number.isFinite(a.maxAlt) ? `${nf.format(Math.round(a.maxAlt))} ft` : '—'}</td>
      <td class="num">${a.avgGs ? `${a.avgGs.toFixed(0)} kt` : '—'}</td>
      <td class="num">${a.distance > 1 ? `${nf.format(Math.round(a.distance))} km` : '—'}</td>
      <td class="num">${formatTime(a.firstT)}</td>
      <td class="num">${formatTime(a.lastT)}</td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('tr[data-key]').forEach((tr) => {
    tr.addEventListener('click', () => selectAircraft(Number(tr.dataset.key)));
  });

  pager.innerHTML = `
    <button ${state.aircraftPage === 0 ? 'disabled' : ''} data-page="prev">‹</button>
    <span>${state.aircraftPage * perPage + 1}–${Math.min(
      (state.aircraftPage + 1) * perPage,
      sorted.length
    )} sur ${nf.format(sorted.length)}</span>
    <button ${state.aircraftPage >= pages - 1 ? 'disabled' : ''} data-page="next">›</button>`;
  pager.querySelector('[data-page="prev"]').onclick = () => {
    state.aircraftPage--;
    renderAircraftTable();
  };
  pager.querySelector('[data-page="next"]').onclick = () => {
    state.aircraftPage++;
    renderAircraftTable();
  };
}

function renderTimeline() {
  const el = $('#timeline-chart');
  const { timeline } = state.results;
  const width = Math.max(320, el.clientWidth || 800);
  const height = Math.max(200, el.clientHeight || 260);
  const pad = { top: 12, right: 12, bottom: 26, left: 46 };

  if (!timeline.bins.length) {
    el.innerHTML = '<p class="muted" style="padding:8px">Pas de données sur cette période.</p>';
    return;
  }

  const maxPos = Math.max(...timeline.bins.map((b) => b.positions), 1);
  const maxAc = Math.max(...timeline.bins.map((b) => b.aircraft), 1);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const barW = innerW / timeline.bins.length;

  const bars = timeline.bins
    .map((b, i) => {
      const h = (b.positions / maxPos) * innerH;
      const x = pad.left + i * barW;
      const y = pad.top + innerH - h;
      const label = `${formatTime(b.start)} → ${formatTime(b.end)} UTC\n${nf.format(b.positions)} positions · ${
        b.aircraft
      } aéronefs`;
      return `<rect class="bar" x="${x + 0.5}" y="${y}" width="${Math.max(1, barW - 1)}" height="${h}" rx="1.5">
        <title>${label}</title></rect>`;
    })
    .join('');

  const linePoints = timeline.bins
    .map((b, i) => {
      const x = pad.left + i * barW + barW / 2;
      const y = pad.top + innerH - (b.aircraft / maxAc) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const ticks = 5;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (maxPos / ticks) * i;
    const y = pad.top + innerH - (i / ticks) * innerH;
    return `<line class="grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" />
      <text class="axis-label" x="${pad.left - 8}" y="${y + 3}" text-anchor="end">${nf.format(
      Math.round(v)
    )}</text>`;
  }).join('');

  const longSpan = timeline.binSize >= 6 * 3600;
  const pad2 = (n) => String(n).padStart(2, '0');
  const tickLabel = (t) => {
    const d = new Date(t * 1000);
    const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    return longSpan ? `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)} ${time}` : time;
  };
  const xTickCount = Math.min(8, timeline.bins.length);
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const idx = Math.floor((i * (timeline.bins.length - 1)) / Math.max(1, xTickCount - 1));
    const bin = timeline.bins[idx];
    const x = pad.left + idx * barW + barW / 2;
    return `<text class="axis-label" x="${x}" y="${height - 8}" text-anchor="middle">${tickLabel(
      bin.start
    )}</text>`;
  }).join('');

  el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
    <defs>
      <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffb02e" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#ffb02e" stop-opacity="0.35" />
      </linearGradient>
    </defs>
    ${yTicks}
    ${bars}
    <polyline class="line" points="${linePoints}" />
    ${xTicks}
  </svg>`;
}

/* -------------------------------------------------------------------------- */
/* Panneau de détail                                                           */
/* -------------------------------------------------------------------------- */

function selectAircraft(key) {
  const aircraft = state.results.aircraft;
  const ac = aircraft.find((a) => a.key === key);
  if (!ac) return;
  state.selectedKey = key;
  showDetail(ac);
  mapView.render(trackList(), key);
  renderAircraftTable();
}

function hideDetail() {
  $('#detail').hidden = true;
  $('.layout').classList.remove('with-detail');
  state.selectedKey = null;
  setTimeout(() => mapView && mapView.map.invalidateSize(), 60);
}

function altitudeSparkline(track, color) {
  const pts = track.filter((p) => p[2] !== -9999);
  if (pts.length < 2) return '';
  const w = 320;
  const h = 90;
  const maxAlt = Math.max(...pts.map((p) => p[2]), 1);
  const path = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - 6 - (p[2] / maxAlt) * (h - 14);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="${color || '#ffb02e'}" stroke-width="1.6"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" />
  </svg>`;
}

function showDetail(ac) {
  $('#detail').hidden = false;
  $('.layout').classList.add('with-detail');
  setTimeout(() => mapView && mapView.map.invalidateSize(), 60);
  $('#detail-title').textContent = ac.callsign || ac.hex;
  const rows = [
    ['Hex ICAO', ac.hex],
    ['Indicatif(s)', ac.allCallsigns.join(', ') || '—'],
    ['Immatriculation', ac.registration || '—'],
    ['Type', ac.typecode || '—'],
    ['Catégorie', ac.category || '—'],
    ['Militaire', ac.military ? 'oui' : 'non'],
    ['Positions', nf.format(ac.count)],
    ['Premier point', formatTime(ac.firstT)],
    ['Dernier point', formatTime(ac.lastT)],
    ['Durée observée', formatDuration(ac.duration)],
    ['Altitude max', Number.isFinite(ac.maxAlt) ? `${nf.format(Math.round(ac.maxAlt))} ft` : '—'],
    ['Vitesse moyenne', ac.avgGs ? `${ac.avgGs.toFixed(0)} kt` : '—'],
    ['Distance suivie', ac.distance > 1 ? `${nf.format(Math.round(ac.distance))} km` : '—'],
  ];

  $('#detail-body').innerHTML = `
    <div class="kv-list">
      ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('')}
    </div>
    <h3>Profil d'altitude</h3>
    ${altitudeSparkline(ac.track, colorFor(ac.hex)) || '<p class="hint">Trop peu de points.</p>'}
    <h3>Actions</h3>
    <div class="row wrap">
      <button class="btn small" id="detail-isolate">Isoler ce vol</button>
      <button class="btn small ghost" id="detail-copy">Copier le hex</button>
    </div>
  `;

  $('#detail-isolate').onclick = async () => {
    $('#hex-input').value = ac.hex;
    await runQuery({ fit: true });
    toast(`Filtre appliqué sur ${ac.hex}`);
  };
  $('#detail-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(ac.hex);
      toast('Hex copié.');
    } catch {
      toast('Copie impossible dans ce navigateur.', 'error');
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

function refreshImportOptions() {
  const target = $('#import-target');
  const canMerge = !!state.active && !(state.meta && state.meta.synthetic);
  target.querySelector('option[value="merge"]').disabled = !canMerge;
  if (!canMerge) target.value = 'new';
  target.querySelector('option[value="merge"]').textContent = canMerge
    ? `Ajouter au jeu actif (${nf.format(state.stats.count)} positions)`
    : 'Ajouter au jeu actif (indisponible avec la démo)';

  const limit = Number($('#import-limit').value);
  const mo = Math.round((limit * 60) / 1e6);
  $('#import-estimate').textContent =
    `Jusqu'à ${nf.format(limit)} positions dans ce lot ≈ ${mo} Mo de mémoire du navigateur ` +
    `(les jeux de données fusionnés s'additionnent).`;
}

function setImportFiles(files) {
  state.importFiles = [...files];
  const total = state.importFiles.reduce((s, f) => s + f.size, 0);
  $('#file-list').textContent = state.importFiles.length
    ? `${state.importFiles.map((f) => f.name).join(', ')} — ${formatBytes(total)}`
    : 'Aucun fichier sélectionné';
  updateImportStartState();
}

function updateImportStartState() {
  const hasUrl = !!($('#import-url').value || '').trim();
  $('#import-start').disabled = !state.importFiles.length && !hasUrl;
  const readonly = hasUrl && !state.importFiles.length;
  $('#import-zone').disabled = false;
  void readonly;
}

async function startImport() {
  const url = ($('#import-url').value || '').trim();
  const files = state.importFiles;
  if (!files.length && !url) {
    toast('Choisissez un fichier ou collez une URL de téléchargement.', 'error');
    return;
  }

  const bbox = $('#import-zone').value === 'view' ? mapView.getViewBbox() : null;
  const minIntervalSec = Number($('#import-sampling').value);
  const maxPoints = Number($('#import-limit').value);
  const progress = $('#import-progress');
  const fill = $('#import-progress-fill');
  const label = $('#import-progress-label');
  const options = { bbox, minIntervalSec, maxPoints };

  progress.hidden = false;
  $('#import-start').disabled = true;
  $('#import-cancel').textContent = 'Annuler';

  const onProgress = (p) => {
    const parts = [];
    if (p.points !== undefined) parts.push(`${nf.format(p.points)} positions`);
    if (p.received) parts.push(`${formatBytes(p.received)} reçus`);
    if (p.files) parts.push(`${p.files} fichier(s)`);
    if (p.name) parts.push(p.name.split('/').pop());
    label.textContent = parts.join(' · ') || 'Lecture…';
    const ratio = p.ratio ?? (p.points !== undefined ? Math.min(1, p.points / maxPoints) : 0);
    fill.style.width = `${Math.max(4, ratio * 100).toFixed(1)}%`;
  };

  const isCsv = !url && files.length === 1 && /\.(csv|txt)$/i.test(files[0].name);

  try {
    let ds;
    let name;
    let source;

    if (url) {
      const result = await runUrlImport(url, options, onProgress);
      ds = result.dataset;
      name = result.name;
      source = result.source;
      fill.style.width = '100%';
    } else if (isCsv) {
      label.textContent = 'Lecture du CSV…';
      fill.style.width = '30%';
      const text = await files[0].text();
      const { rows } = parseCsv(text, { limit: maxPoints });
      if (!rows.length) throw new Error('Aucune position lisible dans ce CSV.');
      ds = datasetFromRows(rows.slice(0, maxPoints), { source: 'csv', minIntervalSec });
      name = files[0].name;
      source = 'csv';
      fill.style.width = '90%';
    } else {
      let result;
      try {
        result = await runWorkerImport({ files }, options, onProgress);
      } catch (err) {
        if (!/Worker|module|import/i.test(err.message)) throw err;
        toast('Import en mode compatibilité (plus lent)…');
        result = await runMainThreadImport(files, options, onProgress);
      }
      ds = result.dataset;
      name = files.map((f) => f.name).join(' + ');
      source = 'heatmap';
      fill.style.width = '100%';
    }

    await finalizeImport(ds, name, { bbox, source });
    progress.hidden = true;
    fill.style.width = '0%';
  } catch (err) {
    progress.hidden = true;
    fill.style.width = '0%';
    label.textContent = '';
    toast(`Import impossible : ${err.message}`, 'error');
    console.error(err);
  } finally {
    $('#import-cancel').textContent = 'Annuler';
    $('#import-start').disabled = false;
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
  }
}

/** Enregistre (ou fusionne) le jeu de données importé puis l'active. */
async function finalizeImport(ds, name, { bbox, source = 'heatmap' }) {
  if (!ds.n) throw new Error("Aucune position ADS-B n'a été trouvée dans ces données.");

  const fill = $('#import-progress-fill');
  const label = $('#import-progress-label');

  let target = $('#import-target').value;
  if (target === 'merge' && !state.active) target = 'new';
  if (target === 'merge' && state.meta && state.meta.synthetic) target = 'new';

  let mergeId = null;
  let mergeMeta = null;
  if (target === 'merge') {
    label.textContent = 'Fusion avec le jeu de données actif…';
    mergeId = state.activeId;
    mergeMeta = { ...state.meta };
    ds = mergeDatasets(state.active, ds);
    name = `${mergeMeta.name} + ${name}`;
  }

  const stats = describeDataset(ds);
  const id = mergeId || `imp-${Date.now()}`;
  const meta = {
    id,
    name: name.length > 70 ? `${name.slice(0, 67)}…` : name,
    source,
    synthetic: false,
    count: stats.count,
    aircraft: stats.aircraft,
    tMin: stats.tMin,
    tMax: stats.tMax,
    importedAt: Date.now(),
    bbox: mergeMeta ? (mergeMeta.bbox ?? bbox) : bbox,
  };

  label.textContent = 'Enregistrement local (IndexedDB)…';
  try {
    await persistDataset(id, meta, ds);
  } catch (err) {
    toast(
      "Jeu de données trop volumineux pour être conservé après rechargement : il reste disponible pour cette session.",
      'error'
    );
  }

  const existing = state.datasets.findIndex((d) => d.id === id);
  if (existing >= 0) state.datasets[existing] = meta;
  else state.datasets.push(meta);
  state.cache.set(id, { ds, meta, stats });

  await refreshDatasetList();
  closeModal('#import-dialog');
  setImportFiles([]);
  $('#import-url').value = '';
  $('#import-progress').hidden = true;
  fill.style.width = '0%';
  await activateDataset(id);

  toast(
    `${target === 'merge' ? 'Fusion terminée' : 'Import terminé'} : ${nf.format(
      stats.count
    )} positions, ${nf.format(stats.aircraft)} aéronefs, ${formatTime(stats.tMin)} → ${formatTime(
      stats.tMax
    )} UTC.`
  );
}

/** Import direct depuis une URL (archive tar ou CSV), en flux. */
async function runUrlImport(url, options, onProgress) {
  let response;
  try {
    response = await fetch(url, { mode: 'cors', redirect: 'follow' });
  } catch (err) {
    throw new Error(
      "téléchargement direct bloqué par le site distant (CORS) ou par le réseau. " +
        'Téléchargez le fichier puis déposez-le dans la zone ci-dessus.'
    );
  }
  if (!response.ok) throw new Error(`le serveur a répondu HTTP ${response.status}.`);
  if (!response.body) throw new Error("ce navigateur ne sait pas lire cette URL en flux.");

  let fileName = 'archive.tar';
  try {
    fileName = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()) || fileName;
  } catch (err) {
    /* URL exotique : on garde le nom par défaut */
  }
  const totalBytes = Number(response.headers.get('content-length')) || null;

  if (/\.(csv|txt)$/i.test(fileName)) {
    const text = await response.text();
    const { rows } = parseCsv(text, { limit: options.maxPoints });
    if (!rows.length) throw new Error('aucune position lisible dans ce CSV.');
    return {
      dataset: datasetFromRows(rows, { source: 'csv', minIntervalSec: options.minIntervalSec }),
      name: fileName,
      source: 'csv',
    };
  }

  const result = await runWorkerImport({ stream: response.body, totalBytes }, options, onProgress);
  return { dataset: result.dataset, name: fileName, source: 'url' };
}

async function runMainThreadImport(files, options, onProgress) {
  const { bbox, minIntervalSec, maxPoints } = options;
  const blob = files.length === 1 ? files[0] : new Blob(files);
  const builder = new ColumnBuilder();
  await readTarStream(
    blob.stream(),
    (name, buffer, progress) => {
      parseHeatmapBuffer(buffer, {
        bbox,
        minIntervalSec,
        limit: Math.max(0, maxPoints - builder.size),
        onPoint: (rec) => builder.add(rec),
      });
      onProgress({ files: progress.files, points: builder.size, name, ratio: progress.ratio });
    },
    { totalBytes: blob.size }
  );
  return {
    dataset: builder.finish({ source: 'import', files: files.length, importedAt: Date.now() }),
  };
}

function runWorkerImport(target, options, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.js', import.meta.url), { type: 'module' });
    state.worker = worker;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') onProgress(msg);
      else if (msg.type === 'done') resolve({ dataset: msg.dataset, truncated: msg.truncated });
      else if (msg.type === 'error') reject(new Error(msg.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'Erreur du worker'));

    try {
      if (target.stream) {
        worker.postMessage(
          { type: 'start-stream', stream: target.stream, totalBytes: target.totalBytes, options },
          [target.stream]
        );
      } else {
        worker.postMessage({ type: 'start', files: target.files, options });
      }
    } catch (err) {
      reject(new Error(`flux non transférable vers le worker (${err.message})`));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Relevé automatique : données réelles collectées hors du navigateur          */
/* -------------------------------------------------------------------------- */

function snapshotState() {
  if (!state.snapshot) {
    state.snapshot = {
      loading: false,
      data: null,
      zones: [],
      zoneId: 'dakar',
      error: null,
    };
  }
  return state.snapshot;
}

/** Durée de la fenêtre affichée, en minutes (null = tout le relevé). */
function snapshotWindow() {
  const el = $('#snapshot-window');
  const value = el ? Number(el.value) : 60;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function humanMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

function snapshotRows(snapshot, windowMinutes) {
  const minT = windowMinutes ? snapshot.last - windowMinutes * 60 : -Infinity;
  const rows = [];
  for (const sample of snapshot.samples) {
    if (sample.t < minT) continue;
    rows.push({
      t: sample.t,
      hex: sample.hex,
      flight: sample.flight,
      lat: sample.lat,
      lon: sample.lon,
      alt: sample.alt,
      gs: sample.gs,
      bearing: sample.bearing,
      registration: sample.registration,
      typecode: sample.typecode,
      category: sample.category,
      military: sample.military,
    });
  }
  return rows;
}

/** Titre de l'onglet : indique la source affichée (utile aussi pour les diagnostics). */
function syncTitle() {
  const snap = snapshotState();
  const isReal = typeof state.activeId === 'string' && state.activeId.startsWith('live-snapshot');
  let suffix = '';
  if (isReal) {
    const aircraft = state.stats ? state.stats.aircraft : null;
    suffix = aircraft ? `Relevé réel · ${nf.format(aircraft)} aéronefs` : 'Relevé réel';
  } else if (state.activeId === 'demo') {
    suffix = 'démonstration simulée';
  } else if (snap.error) {
    suffix = 'relevé indisponible';
  }
  document.title = suffix ? `Turnstone Lite — ${suffix}` : 'Turnstone Lite — historique de vols ADS-B';
}

function updateSnapshotUi() {
  const snap = snapshotState();
  const status = $('#snapshot-status');
  if (!status) return;
  const mapBtn = $('#snapshot-map');
  const loadBtn = $('#snapshot-load');

  if (snap.loading) {
    status.textContent = 'Chargement du relevé automatique…';
    status.style.color = '';
    mapBtn.disabled = true;
    loadBtn.disabled = true;
    return;
  }
  if (snap.error || !snap.data) {
    status.textContent = snap.error || 'Relevé automatique indisponible.';
    status.style.color = 'var(--danger)';
    mapBtn.disabled = true;
    loadBtn.disabled = true;
    return;
  }

  status.style.color = '';
  const data = snap.data;
  const label = (data.zone && data.zone.label) || snap.zoneId;
  const aircraft = new Set(data.samples.map((s) => s.hex)).size;
  const span = humanMinutes((data.last - data.first) / 60);
  const lag = humanMinutes(Math.max(0, Date.now() / 1000 - data.last));
  status.textContent =
    `${label} · ${nf.format(aircraft)} aéronefs · ${nf.format(data.samples.length)} positions ` +
    `sur ${span} · dernière relève il y a ${lag}${data.provider ? ` (${data.provider})` : ''}.`;
  mapBtn.disabled = data.samples.length === 0;
  loadBtn.disabled = data.samples.length === 0;
}

function fillSnapshotZones() {
  const snap = snapshotState();
  const select = $('#snapshot-zone');
  if (!select || !snap.zones.length) return;
  select.innerHTML = '';
  for (const zone of snap.zones) {
    const opt = document.createElement('option');
    opt.value = zone.id;
    opt.textContent = zone.label || zone.id;
    select.appendChild(opt);
  }
  select.value = snap.zoneId;
}

async function loadSnapshot(zoneId = null) {
  const snap = snapshotState();
  if (zoneId) snap.zoneId = zoneId;
  snap.loading = true;
  snap.error = null;
  updateSnapshotUi();
  try {
    if (!snap.zones.length) {
      const zones = await fetchSnapshotIndex().catch(() => null);
      if (zones && zones.length) {
        snap.zones = zones;
        if (!zones.some((z) => z.id === snap.zoneId)) snap.zoneId = zones[0].id;
        fillSnapshotZones();
      }
    }
    snap.data = await fetchSnapshot({ zoneId: snap.zoneId });
  } catch (err) {
    snap.data = null;
    snap.error =
      `Relevé automatique indisponible (${err.message}). Vérifiez que le workflow « Relevé ADS-B automatique » ` +
      "a bien tourné (onglet Actions du dépôt), ou importez une archive / un CSV à l'étape 2.";
  } finally {
    snap.loading = false;
    updateSnapshotUi();
    syncTitle();
  }
}

/** Affiche la dernière position connue de chaque aéronef et ses traînées. */
function renderSnapshotMap({ silent = false } = {}) {
  const snap = snapshotState();
  if (!snap.data) return;
  const windowMinutes = snapshotWindow();
  const { points, trails, lastT } = snapshotTraffic(snap.data, { windowMinutes });
  if (!points.length) {
    toast('Aucune position dans cette fenêtre : élargissez la fenêtre affichée.', 'error');
    return;
  }
  mapView.renderLive(points, trails);
  const bounds = points.map((p) => [p.lat, p.lon]);
  if (bounds.length) mapView.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  if (!silent) {
    toast(
      `Relevé affiché : ${nf.format(points.length)} aéronefs, dernière position à ${formatTime(lastT)} UTC.`
    );
  }
}

/**
 * Au chargement : si un relevé réel est disponible, on l'ouvre directement pour que
 * la carte, les tableaux et le résumé montrent du trafic réel dès l'arrivée.
 */
async function maybeAutoOpenSnapshot() {
  const snap = snapshotState();
  if (!snap.data || !snap.data.samples.length) return false;
  if (state.activeId && state.activeId !== 'demo') return false;
  const label = (snap.data.zone && snap.data.zone.label) || snap.zoneId;
  const rows = snapshotRows(snap.data, null);
  if (!rows.length) return false;
  try {
    const ds = datasetFromRows(rows, { source: 'live' });
    const stats = describeDataset(ds);
    const id = `live-snapshot-${snap.zoneId}`;
    const meta = {
      id,
      name: `Relevé ${label} · ${formatTime(rows[0].t)} → ${formatTime(rows[rows.length - 1].t)} UTC`,
      source: 'live',
      synthetic: false,
      count: stats.count,
      aircraft: stats.aircraft,
      tMin: stats.tMin,
      tMax: stats.tMax,
      importedAt: Date.now(),
      bbox: null,
    };
    state.datasets = state.datasets.filter((d) => d.id !== id);
    state.cache.set(id, { ds, meta, stats });
    await refreshDatasetList();
    await activateDataset(id);
    renderSnapshotMap({ silent: true });
    toast(
      `Relevé réel chargé : ${nf.format(stats.aircraft)} aéronefs, ${nf.format(stats.count)} positions ` +
        `(${label}). Choisissez « Démonstration » dans la liste pour revenir aux données simulées.`
    );
    return true;
  } catch (err) {
    console.warn('Ouverture automatique du relevé impossible :', err);
    return false;
  }
}

/** Ouvre le relevé comme jeu de données interrogeable (filtres, tableaux, CSV). */
async function buildSnapshotDataset() {
  const snap = snapshotState();
  if (!snap.data) {
    toast('Aucun relevé disponible pour le moment.', 'error');
    return;
  }
  const rows = snapshotRows(snap.data, snapshotWindow());
  if (!rows.length) {
    toast('Aucune position dans cette fenêtre : élargissez la fenêtre affichée.', 'error');
    return;
  }
  const label = (snap.data.zone && snap.data.zone.label) || snap.zoneId;
  const name = `Relevé ${label} · ${formatTime(rows[0].t)} → ${formatTime(rows[rows.length - 1].t)} UTC`;
  try {
    const stats = await openRowsDataset(rows, { name, source: 'live' });
    toast(`Relevé ouvert : ${nf.format(stats.count)} positions réelles, ${nf.format(stats.aircraft)} aéronefs.`);
  } catch (err) {
    toast(`Ouverture impossible : ${err.message}`, 'error');
  }
}

/* -------------------------------------------------------------------------- */
/* Temps réel : ingestion directe des flux ADS-B publics                       */
/* -------------------------------------------------------------------------- */

const LIVE_TICK_MS = 1000;
const CREDIT_KEY = 'turnstone.opensky.credits';

/** Compteur local des crédits OpenSky consommés aujourd'hui (400 / jour en anonyme). */
function creditState() {
  const today = new Date().toISOString().slice(0, 10);
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(CREDIT_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || stored.date !== today) stored = { date: today, used: 0 };
  return stored;
}

function spendCredits(amount) {
  const credits = creditState();
  credits.used += amount;
  try {
    localStorage.setItem(CREDIT_KEY, JSON.stringify(credits));
  } catch {
    /* mode privé : le compteur reste en mémoire */
  }
  return credits;
}

function remainingCredits() {
  return Math.max(0, OPENSKY_DAILY_CREDITS - creditState().used);
}

function liveState() {
  if (!state.live) {
    state.live = {
      active: false,
      timer: null,
      ticker: null,
      busy: false,
      radius: 50,
      interval: 300,
      recording: false,
      points: [],
      trails: new Map(),
      rows: [],
      lastRecord: new Map(),
      provider: null,
      lastAt: null,
      error: null,
    };
  }
  return state.live;
}

function readLiveOptions() {
  const live = liveState();
  live.radius = Number($('#live-radius').value) || 50;
  live.interval = Number($('#live-interval').value) || 300;
  return live;
}

function updateLiveUi() {
  const live = liveState();
  if (!$('#live-toggle')) return;
  const card = document.querySelector('.live-card');
  const toggle = $('#live-toggle');
  toggle.textContent = live.active ? 'Arrêter' : 'Activer';
  toggle.classList.toggle('primary', !live.active);
  if (card) card.classList.toggle('active', live.active);
  $('#live-panel').hidden = !live.active;
  $('#live-build').disabled = live.rows.length === 0;

  const status = $('#live-status');
  if (!live.active) {
    status.style.color = '';
    if (live.error) {
      status.textContent = live.error;
      status.style.color = 'var(--danger)';
      return;
    }
    const parts = [];
    if (live.lastAt) {
      const ago = Math.max(0, Math.round((Date.now() - live.lastAt) / 1000));
      parts.push(
        `Dernière relève directe : ${nf.format(live.points.length)} aéronefs` +
          `${live.provider ? ` (${live.provider})` : ''}, il y a ${ago < 90 ? `${ago} s` : `${Math.round(ago / 60)} min`}`
      );
    }
    if (live.rows.length) parts.push(`${nf.format(live.rows.length)} positions enregistrées en attente`);
    parts.push(`crédits OpenSky restants ≈ ${nf.format(remainingCredits())}/${OPENSKY_DAILY_CREDITS}`);
    status.textContent = parts.join(' · ') + '.';
    return;
  }
  if (live.error) {
    status.textContent = live.error;
    status.style.color = 'var(--danger)';
    $('#live-panel').classList.add('error');
    $('#live-count').textContent = '0';
    $('#live-provider').textContent = '';
    $('#live-ago').textContent = '';
    return;
  }
  status.style.color = '';
  $('#live-panel').classList.remove('error');
  const ago = live.lastAt ? Math.max(0, Math.round((Date.now() - live.lastAt) / 1000)) : null;
  const credits = remainingCredits();
  status.textContent =
    `${nf.format(live.points.length)} aéronefs reçus${live.provider ? ` · ${live.provider}` : ''}` +
    `${live.recording ? ` · ${nf.format(live.rows.length)} positions enregistrées` : ' · enregistrement désactivé'}` +
    (live.relayId && live.relayId !== 'direct'
      ? ' · via relais public'
      : ` · crédits OpenSky restants ≈ ${nf.format(credits)}/${OPENSKY_DAILY_CREDITS}`);
  $('#live-count').textContent = nf.format(live.points.length);
  $('#live-provider').textContent = live.provider ? `· ${live.provider}` : '';
  $('#live-ago').textContent = ago !== null ? `· il y a ${ago} s` : '';
}

/** Enregistre les nouvelles positions (max 1 point / 10 s et par aéronef). */
function recordLive(points, timestamp) {
  const live = liveState();
  if (!live.recording) return;
  for (const p of points) {
    const last = live.lastRecord.get(p.hex);
    if (last !== undefined && timestamp - last < 10) continue;
    live.lastRecord.set(p.hex, timestamp);
    live.rows.push({
      t: timestamp,
      hex: p.hex,
      flight: p.flight,
      lat: p.lat,
      lon: p.lon,
      alt: p.alt,
      gs: p.gs,
      bearing: p.bearing,
      registration: p.reg,
      typecode: p.type,
      category: p.category,
      military: p.military,
    });
  }
  if (live.rows.length > 250000) live.rows.splice(0, live.rows.length - 250000);
}

/** Applique une réponse du direct : traînées, enregistrement, carte. */
function applyLiveResult(res) {
  const live = liveState();
  live.points = res.points;
  live.provider = res.provider;
  live.relayId = res.relayId || 'direct';
  live.lastAt = Date.now();
  live.error = null;

  const now = res.timestamp / 1000;
  for (const p of res.points) {
    let path = live.trails.get(p.hex);
    if (!path) {
      path = [];
      live.trails.set(p.hex, path);
    }
    const last = path[path.length - 1];
    if (!last || last[0] !== p.lat || last[1] !== p.lon) path.push([p.lat, p.lon, now]);
    if (path.length > 240) path.shift();
  }

  recordLive(res.points, now);
  try {
    mapView.renderLive(res.points, live.trails);
  } catch (err) {
    // un souci d'affichage ne doit pas faire perdre les positions reçues
    console.warn('Affichage du direct impossible :', err);
  }
}

/** Interroge une fois les fournisseurs accessibles depuis le navigateur. */
async function probeDirect() {
  const live = liveState();
  const { lat, lon } = mapView.getCenter();
  const res = await fetchLive({
    lat,
    lon,
    radiusNm: live.radius,
    providers: BROWSER_PROVIDERS,
    relays: liveRelays(),
    timeoutMs: 8000,
  });
  if (res.providerId === 'opensky' && res.relayId === 'direct') spendCredits(openSkyCost(lat, live.radius));
  rememberRelay(res.relayId);
  applyLiveResult(res);
  return res;
}

/** Message court : le détail technique complet reste dans la console. */
const DIRECT_ERROR =
  'Direct impossible : les API ADS-B publiques refusent les appels depuis un navigateur, et les ' +
  'relais publics n’ont pas répondu. Le relevé automatique ci-dessus fournit les données réelles.';

async function pollLive() {
  const live = liveState();
  if (!live.active || live.busy) return;
  live.busy = true;
  try {
    await probeDirect();
  } catch (err) {
    console.warn(err);
    live.error = DIRECT_ERROR;
    live.points = [];
  } finally {
    live.busy = false;
    updateLiveUi();
  }
}

function startLive() {
  const live = readLiveOptions();
  if (live.active) return;
  live.active = true;
  live.error = null;
  live.trails.clear();
  updateLiveUi();
  pollLive();
  live.timer = setInterval(pollLive, live.interval * 1000);
  live.ticker = setInterval(updateLiveUi, LIVE_TICK_MS);
  const minutes = Math.round(live.interval / 60);
  toast(
    `Direct activé : relève toutes les ${minutes} min via un relais public ` +
      '(ces API refusent les appels depuis un navigateur).'
  );
}

function stopLive() {
  const live = liveState();
  live.active = false;
  clearInterval(live.timer);
  clearInterval(live.ticker);
  live.timer = null;
  live.ticker = null;
  live.points = [];
  mapView.clearLive();
  updateLiveUi();
}

const RELAY_MEMO_KEY = 'turnstone.live.relay';

/**
 * Relais à essayer : appel direct, puis relais publics — en commençant par celui
 * qui a fonctionné lors de la relève précédente (mémorisé localement).
 */
function liveRelays() {
  const prefix = ($('#live-relay') && $('#live-relay').value.trim()) || '';
  if (prefix) {
    return [
      RELAYS[0],
      {
        id: 'custom',
        label: 'relais indiqué',
        wrap: (url) => (prefix.includes('{url}') ? prefix.replace('{url}', url) : prefix + url),
        text: /jina\.ai/.test(prefix),
      },
    ];
  }
  let preferred = null;
  try {
    preferred = localStorage.getItem(RELAY_MEMO_KEY);
  } catch {
    preferred = null;
  }
  const others = RELAYS_PUBLIC.filter((relay) => relay.id !== preferred);
  const first = RELAYS_PUBLIC.find((relay) => relay.id === preferred);
  return [RELAYS[0], ...(first ? [first] : []), ...others];
}

function rememberRelay(relayId) {
  if (!relayId || relayId === 'direct' || relayId === 'custom') return;
  try {
    localStorage.setItem(RELAY_MEMO_KEY, relayId);
  } catch {
    /* mode privé : pas de mémorisation */
  }
}

/** Crée un jeu de données à partir de lignes brutes et l'ouvre. */
async function openRowsDataset(rows, { name, source = 'live' } = {}) {
  setLoading(true, 'Construction du jeu de données…');
  await new Promise((r) => setTimeout(r, 16));
  try {
    const ds = datasetFromRows(rows, { source });
    const stats = describeDataset(ds);
    const id = `${source}-${Date.now()}`;
    const meta = {
      id,
      name,
      source,
      synthetic: false,
      count: stats.count,
      aircraft: stats.aircraft,
      tMin: stats.tMin,
      tMax: stats.tMax,
      importedAt: Date.now(),
      bbox: null,
    };
    try {
      await persistDataset(id, meta, ds);
    } catch (err) {
      toast(
        'Enregistrement local impossible (volume trop important) : le jeu reste disponible pour cette session.',
        'error'
      );
    }
    state.datasets.push(meta);
    state.cache.set(id, { ds, meta, stats });
    await refreshDatasetList();
    await activateDataset(id);
    return stats;
  } finally {
    setLoading(false);
  }
}

/** Transforme les positions accumulées en jeu de données interrogeable. */
async function buildLiveDataset() {
  const live = liveState();
  if (!live.rows.length) {
    toast("Aucune position enregistrée : cochez « Enregistrer pour l'historique » et laissez le direct actif.", 'error');
    return;
  }
  const rows = live.rows.slice();
  const name = `Direct · ${formatTime(rows[0].t)} → ${formatTime(rows[rows.length - 1].t)} UTC`;
  try {
    const stats = await openRowsDataset(rows, { name, source: 'live' });
    live.rows = [];
    live.lastRecord.clear();
    updateLiveUi();
    toast(
      `Historique enregistré ouvert : ${nf.format(stats.count)} positions réelles, ${nf.format(
        stats.aircraft
      )} aéronefs.`
    );
  } catch (err) {
    toast(`Construction impossible : ${err.message}`, 'error');
  }
}

/* -------------------------------------------------------------------------- */
/* Initialisation                                                              */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  $('#btn-import').onclick = () => {
    refreshImportOptions();
    openModal('#import-dialog');
  };
  $('#btn-help').onclick = () => openModal('#help-dialog');
  $('#help-close').onclick = () => closeModal('#help-dialog');

  $('#dataset-select').onchange = async (e) => {
    setLoading(true, 'Chargement du jeu de données…');
    try {
      await activateDataset(e.target.value);
    } finally {
      setLoading(false);
    }
  };

  $('#btn-delete-dataset').onclick = async () => {
    if (state.activeId === 'demo') return;
    const id = state.activeId;
    await dbDelete('data', id).catch(() => {});
    await dbDelete('datasets', id).catch(() => {});
    state.cache.delete(id);
    state.datasets = state.datasets.filter((d) => d.id !== id);
    await refreshDatasetList();
    await activateDataset('demo');
    toast('Jeu de données supprimé.');
  };

  $('#live-toggle').onclick = () => (liveState().active ? stopLive() : startLive());
  $('#live-refresh').onclick = async () => {
    const live = liveState();
    if (live.busy) return;
    live.busy = true;
    try {
      const res = await probeDirect();
      toast(`Actualisé via ${res.provider} : ${nf.format(res.points.length)} aéronefs autour de la carte.`);
    } catch (err) {
      console.warn(err);
      live.error = DIRECT_ERROR;
      toast('Relève directe impossible (CORS) — le relevé automatique reste disponible.', 'error');
    } finally {
      live.busy = false;
      updateLiveUi();
    }
  };
  $('#live-dakar').onclick = () => {
    mapView.centerOn(14.7397, -17.4902, 9);
    toast('Carte centrée sur Dakar (Yoff).');
    if (liveState().active) pollLive();
  };
  $('#live-radius').onchange = () => {
    readLiveOptions();
    if (liveState().active) pollLive();
  };
  $('#live-interval').onchange = () => {
    const live = readLiveOptions();
    if (live.active) {
      clearInterval(live.timer);
      live.timer = setInterval(pollLive, live.interval * 1000);
    }
    updateLiveUi();
  };
  $('#live-record').onchange = (e) => {
    liveState().recording = e.target.checked;
    updateLiveUi();
    if (e.target.checked) {
      toast('Enregistrement activé : les positions reçues s’accumulent localement (IndexedDB à l’ouverture).');
    }
  };
  $('#live-build').onclick = () => buildLiveDataset();

  $('#snapshot-zone').onchange = () => loadSnapshot($('#snapshot-zone').value);
  $('#snapshot-window').onchange = () => updateSnapshotUi();
  $('#snapshot-map').onclick = () => renderSnapshotMap();
  $('#snapshot-load').onclick = () => buildSnapshotDataset();

  document.addEventListener('visibilitychange', () => {
    const live = liveState();
    if (!live.active) return;
    if (document.hidden) {
      clearInterval(live.timer);
      live.timer = null;
    } else if (!live.timer) {
      pollLive();
      live.timer = setInterval(pollLive, live.interval * 1000);
    }
  });

  $('#btn-search').onclick = () => runQuery({ fit: true });
  $('#btn-reset').onclick = async () => {
    ['#hex-input', '#flight-input', '#reg-input', '#min-alt', '#max-alt', '#min-gs', '#max-gs', '#min-brg', '#max-brg'].forEach(
      (sel) => {
        $(sel).value = '';
      }
    );
    $('#category-select').value = '';
    $('#military-select').value = 'any';
    setBbox(null);
    $('#start-input').value = epochToDt(state.stats.tMin, 'floor');
    $('#end-input').value = epochToDt(state.stats.tMax, 'ceil');
    document.querySelectorAll('#period-chips button').forEach((b) => b.classList.remove('active'));
    document.querySelector('#period-chips button[data-all]').classList.add('active');
    await runQuery({ fit: true });
  };

  $('#zone-view').onclick = () => {
    const bbox = mapView.getViewBbox();
    setBbox(bbox);
    toast('Zone = vue actuelle de la carte.');
  };
  $('#zone-world').onclick = () => setBbox(null);
  $('#zone-draw').onclick = () => {
    mapView.enableDraw(true);
    $('#zone-draw').setAttribute('aria-pressed', 'true');
    toast('Tracez un rectangle sur la carte.');
  };
  $('#zone-clear').onclick = () => setBbox(null);

  document.querySelectorAll('#period-chips button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#period-chips button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.all) {
        $('#start-input').value = epochToDt(state.stats.tMin, 'floor');
        $('#end-input').value = epochToDt(state.stats.tMax, 'ceil');
      } else {
        applyPeriod(Number(btn.dataset.hours));
      }
    };
  });

  document.querySelectorAll('#tabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.view = btn.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      $(`#view-${state.view}`).classList.add('active');
      if (state.view === 'map') setTimeout(() => mapView.map.invalidateSize(), 30);
      if (state.view === 'timeline') requestAnimationFrame(() => renderTimeline());
    };
  });

  $('#basemap-select').onchange = (e) => mapView.setBasemap(e.target.value);

  $('#btn-export-positions').onclick = () => {
    if (!state.results || !state.results.indices.length) return toast('Aucun résultat à exporter.', 'error');
    download(`turnstone-positions-${Date.now()}.csv`, resultsToCsv(state.active, state.results.indices));
    toast('Export CSV des positions lancé.');
  };

  $('#btn-export-aircraft').onclick = () => {
    if (!state.results || !state.results.aircraft.length) return toast('Aucun résultat à exporter.', 'error');
    download(`turnstone-aeronefs-${Date.now()}.csv`, aircraftToCsv(state.results.aircraft));
    toast('Export CSV des aéronefs lancé.');
  };

  $('#detail-close').onclick = () => {
    hideDetail();
    mapView.render(trackList(), null);
    renderAircraftTable();
  };

  // tri des tableaux
  document.querySelectorAll('#positions-table th').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      state.positionsSort = {
        key,
        dir: state.positionsSort.key === key ? -state.positionsSort.dir : -1,
      };
      state.positionsPage = 0;
      renderPositionsTable();
    };
  });
  document.querySelectorAll('#aircraft-table th').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      state.aircraftSort = {
        key,
        dir: state.aircraftSort.key === key ? -state.aircraftSort.dir : -1,
      };
      state.aircraftPage = 0;
      renderAircraftTable();
    };
  });

  // import
  $('#file-input').onchange = (e) => setImportFiles(e.target.files);
  $('#import-limit').onchange = refreshImportOptions;
  $('#import-url').oninput = updateImportStartState;
  $('#import-start').onclick = startImport;
  $('#import-cancel').onclick = () => {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
      $('#import-progress').hidden = true;
      $('#import-start').disabled = false;
      toast('Import annulé.');
      return;
    }
    closeModal('#import-dialog');
  };

  const dropZone = $('#drop-zone');
  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('over');
    })
  );
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) setImportFiles(e.dataTransfer.files);
  });

  window.addEventListener('resize', () => {
    if (state.view === 'timeline') renderTimeline();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) runQuery({ fit: true });
  });
}

async function init() {
  mapView = new MapView($('#map'), {
    onBboxChange: (bbox) => {
      setBbox(bbox);
      $('#zone-draw').setAttribute('aria-pressed', 'false');
      toast('Zone délimitée. Cliquez sur « Rechercher ».');
    },
    onSelectAircraft: (key) => {
      document.querySelector('#tabs button[data-view="aircraft"]').click();
      selectAircraft(key);
    },
  });

  bindEvents();
  state.cache = new Map();
  updateSnapshotUi();
  updateLiveUi();

  // 1. le relevé réel d'abord : c'est la vue par défaut
  let opened = false;
  try {
    await loadSnapshot('dakar');
    opened = await maybeAutoOpenSnapshot();
  } catch (err) {
    console.warn('Relevé automatique indisponible :', err);
  }
  if (opened) return;

  // 2. à défaut, la démonstration simulée (chargée à la demande)
  try {
    const demo = await loadDemo();
    state.cache.set('demo', demo);
    await refreshDatasetList();
    await activateDataset('demo');
    mapView.map.fitBounds(
      [
        [4, -24],
        [22, -8],
      ],
      { padding: [20, 20] }
    );
    updateLiveUi();
  } catch (err) {
    console.error(err);
    const hint =
      location.protocol === 'file:'
        ? " Cette page est ouverte en file:// : lancez plutôt « python3 -m http.server 8000 --directory docs » puis ouvrez http://localhost:8000."
        : '';
    toast(`Chargement de la démo impossible : ${err.message}.${hint}`, 'error');
    setLoading(false);
  }
}
init();
