/**
 * Turnstone Lite — application principale (aucune étape de build, aucun serveur).
 */

import {
  datasetFromDemoJson,
  datasetFromRows,
  describeDataset,
  formatAlt,
  formatTime,
  formatDuration,
} from './dataset.js';
import { queryDataset, aggregateByAircraft, buildTimeline, resultsToCsv, aircraftToCsv } from './query.js';
import { MapView, colorFor } from './mapview.js';
import { parseCsv, parseHeatmapBuffer, readTarStream } from './parse.js';
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

function epochToDt(seconds) {
  if (seconds === null || seconds === undefined) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 16);
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
  state.datasets = [{ id: 'demo', name: 'Démo · Dakar & Afrique de l’Ouest', source: 'demo' }, ...imported];
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
  $('#start-input').value = epochToDt(state.stats.tMin);
  $('#end-input').value = epochToDt(state.stats.tMax);
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
  $('#start-input').value = epochToDt(start);
  $('#end-input').value = epochToDt(end);
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

function setImportFiles(files) {
  state.importFiles = [...files];
  const total = state.importFiles.reduce((s, f) => s + f.size, 0);
  $('#file-list').textContent = state.importFiles.length
    ? `${state.importFiles.map((f) => f.name).join(', ')} — ${formatBytes(total)}`
    : 'Aucun fichier sélectionné';
  $('#import-start').disabled = !state.importFiles.length;
}

async function startImport() {
  const files = state.importFiles;
  if (!files.length) return;
  const zone = $('#import-zone').value;
  const bbox = zone === 'view' ? mapView.getViewBbox() : null;
  const minIntervalSec = Number($('#import-sampling').value);
  const maxPoints = Number($('#import-limit').value);
  const progress = $('#import-progress');
  const fill = $('#import-progress-fill');
  const label = $('#import-progress-label');
  progress.hidden = false;
  $('#import-start').disabled = true;
  $('#import-cancel').textContent = 'Annuler';

  const isCsv = files.length === 1 && /\.(csv|txt)$/i.test(files[0].name);

  try {
    let ds;
    let name;
    if (isCsv) {
      label.textContent = 'Lecture du CSV…';
      fill.style.width = '30%';
      const text = await files[0].text();
      const { rows } = parseCsv(text, { limit: maxPoints });
      if (!rows.length) throw new Error('Aucune position lisible dans ce CSV.');
      ds = datasetFromRows(rows.slice(0, maxPoints), { source: 'csv', minIntervalSec });
      name = files[0].name;
      fill.style.width = '90%';
    } else {
      const onProgress = (p) => {
        const ratio = p.ratio ?? Math.min(1, p.points / maxPoints);
        fill.style.width = `${Math.max(4, ratio * 100).toFixed(1)}%`;
        label.textContent = `${p.files || 0} fichier(s) · ${nf.format(p.points)} positions${
          p.name ? ` · ${p.name.split('/').pop()}` : ''
        }`;
      };
      let result;
      try {
        result = await runWorkerImport(files, { bbox, minIntervalSec, maxPoints }, onProgress);
      } catch (err) {
        if (!/Worker|module|import/i.test(err.message)) throw err;
        toast('Import en mode compatibilité (plus lent)…');
        result = await runMainThreadImport(files, { bbox, minIntervalSec, maxPoints }, onProgress);
      }
      ds = result.dataset;
      name = files.map((f) => f.name).join(' + ');
      fill.style.width = '100%';
    }

    if (!ds.n) throw new Error("Aucune position ADS-B n'a été trouvée dans ces fichiers.");

    const stats = describeDataset(ds);
    const id = `imp-${Date.now()}`;
    const meta = {
      id,
      name: name.length > 60 ? `${name.slice(0, 57)}…` : name,
      source: isCsv ? 'csv' : 'heatmap',
      synthetic: false,
      count: stats.count,
      aircraft: stats.aircraft,
      tMin: stats.tMin,
      tMax: stats.tMax,
      importedAt: Date.now(),
      bbox,
    };

    label.textContent = 'Enregistrement local (IndexedDB)…';
    try {
      await persistDataset(id, meta, ds);
    } catch (err) {
      toast("Jeu de données trop volumineux pour être conservé après rechargement : il reste disponible pour cette session.", 'error');
    }

    state.datasets.push(meta);
    state.cache.set(id, { ds, meta, stats });
    await refreshDatasetList();
    closeModal('#import-dialog');
    setImportFiles([]);
    progress.hidden = true;
    fill.style.width = '0%';
    $('#import-start').disabled = false;
    await activateDataset(id);
    toast(`Import terminé : ${nf.format(stats.count)} positions, ${nf.format(stats.aircraft)} aéronefs.`);
  } catch (err) {
    progress.hidden = true;
    fill.style.width = '0%';
    $('#import-start').disabled = false;
    label.textContent = '';
    toast(`Import impossible : ${err.message}`, 'error');
    console.error(err);
  } finally {
    $('#import-cancel').textContent = 'Annuler';
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
  }
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

function runWorkerImport(files, options, onProgress) {
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
    worker.postMessage({ type: 'start', files, options });
  });
}

/* -------------------------------------------------------------------------- */
/* Initialisation                                                              */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  $('#btn-import').onclick = () => openModal('#import-dialog');
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
    $('#start-input').value = epochToDt(state.stats.tMin);
    $('#end-input').value = epochToDt(state.stats.tMax);
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
        $('#start-input').value = epochToDt(state.stats.tMin);
        $('#end-input').value = epochToDt(state.stats.tMax);
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

  try {
    const demo = await loadDemo();
    state.cache.set('demo', demo);
    state.datasets = [{ id: 'demo', name: 'Démo · Dakar & Afrique de l’Ouest', source: 'demo' }];
    await refreshDatasetList();
    await activateDataset('demo');
    mapView.map.fitBounds(
      [
        [4, -24],
        [22, -8],
      ],
      { padding: [20, 20] }
    );
  } catch (err) {
    console.error(err);
    toast(`Chargement de la démo impossible : ${err.message}`, 'error');
    setLoading(false);
  }
}

init();
