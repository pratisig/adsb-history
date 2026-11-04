/**
 * Turnstone Lite — moteur de requête (filtrage, agrégation, export).
 */

import { haversineKm } from './dataset.js';

/** Normalise et valide les filtres venant de l'interface. */
export function normalizeFilters(input = {}) {
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const f = {
    bbox: Array.isArray(input.bbox) && input.bbox.length === 4 ? input.bbox.map(Number) : null,
    start: num(input.start),
    end: num(input.end),
    hex: (input.hex || '').trim().toLowerCase(),
    flight: (input.flight || '').trim().toUpperCase(),
    reg: (input.reg || '').trim().toUpperCase(),
    minAlt: num(input.minAlt),
    maxAlt: num(input.maxAlt),
    minGs: num(input.minGs),
    maxGs: num(input.maxGs),
    minBrg: num(input.minBrg),
    maxBrg: num(input.maxBrg),
    category: input.category || '',
    military: input.military || 'any',
    limit: num(input.limit) || 200000,
  };
  if (f.bbox && (f.bbox[0] > f.bbox[2] || f.bbox[1] > f.bbox[3])) {
    f.bbox = [Math.min(f.bbox[0], f.bbox[2]), Math.min(f.bbox[1], f.bbox[3]), Math.max(f.bbox[0], f.bbox[2]), Math.max(f.bbox[1], f.bbox[3])];
  }
  return f;
}

/**
 * Filtre le dataset et renvoie les indices retenus, triés par temps croissant.
 */
export function queryDataset(ds, filters) {
  const f = normalizeFilters(filters);
  const { t, lat, lon, alt, gs, brg, h, f: fc, r, ty, c, mil } = ds.columns;
  const { hex: hexDict, flight: flightDict, cat: catDict } = ds.dicts;

  let hexIds = null;
  if (f.hex) {
    hexIds = new Set();
    const wanted = f.hex.replace(/^0x/, '');
    for (let i = 0; i < hexDict.length; i++) {
      const value = hexDict[i];
      if (value && (value === wanted || value === f.hex || value.endsWith(wanted))) hexIds.add(i);
    }
    if (!hexIds.size) return { indices: new Uint32Array(0), truncated: false, filters: f };
  }

  let flightIds = null;
  if (f.flight) {
    flightIds = new Set();
    for (let i = 0; i < flightDict.length; i++) {
      const value = flightDict[i];
      if (value && value.toUpperCase().includes(f.flight)) flightIds.add(i);
    }
    if (!flightIds.size) return { indices: new Uint32Array(0), truncated: false, filters: f };
  }

  let regIds = null;
  if (f.reg) {
    regIds = new Set();
    for (let i = 0; i < ds.dicts.reg.length; i++) {
      const value = ds.dicts.reg[i];
      if (value && value.toUpperCase().includes(f.reg)) regIds.add(i);
    }
    if (!regIds.size) return { indices: new Uint32Array(0), truncated: false, filters: f };
  }

  let catIds = null;
  if (f.category) {
    catIds = new Set();
    for (let i = 0; i < catDict.length; i++) if (catDict[i] === f.category) catIds.add(i);
    if (!catIds.size) return { indices: new Uint32Array(0), truncated: false, filters: f };
  }

  const out = [];
  let truncated = false;
  const { limit } = f;

  for (let i = 0; i < ds.n; i++) {
    const ti = t[i];
    if (f.start !== null && ti < f.start) continue;
    if (f.end !== null && ti > f.end) continue;
    if (hexIds && !hexIds.has(h[i])) continue;
    if (flightIds && !flightIds.has(fc[i])) continue;
    if (regIds && !regIds.has(r[i])) continue;
    if (catIds && !catIds.has(c[i])) continue;

    const la = lat[i];
    const lo = lon[i];
    if (f.bbox && (lo < f.bbox[0] || lo > f.bbox[2] || la < f.bbox[1] || la > f.bbox[3])) continue;

    const al = alt[i];
    if (f.minAlt !== null && (al === -9999 || al < f.minAlt)) continue;
    if (f.maxAlt !== null && (al === -9999 || al > f.maxAlt)) continue;

    const sp = gs[i];
    if (f.minGs !== null && (sp < 0 || sp < f.minGs)) continue;
    if (f.maxGs !== null && (sp < 0 || sp > f.maxGs)) continue;

    const b = brg[i];
    if (f.minBrg !== null && f.maxBrg !== null && f.minBrg <= f.maxBrg) {
      if (b < 0 || b < f.minBrg || b > f.maxBrg) continue;
    } else if (f.minBrg !== null && f.maxBrg !== null) {
      if (b < 0 || (b < f.minBrg && b > f.maxBrg)) continue;
    }

    if (f.military === 'yes' && !mil[i]) continue;
    if (f.military === 'no' && mil[i]) continue;

    out.push(i);
    if (out.length >= limit) {
      truncated = true;
      break;
    }
  }

  const indices = Uint32Array.from(out);
  indices.sort((a, b) => t[a] - t[b]);
  return { indices, truncated, filters: f };
}

/** Regroupe les résultats par aéronef et calcule les statistiques de vol. */
export function aggregateByAircraft(ds, indices) {
  const { t, lat, lon, alt, gs, h, f, r, ty, c, mil } = ds.columns;
  const groups = new Map();

  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const key = h[i];
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        hex: ds.dicts.hex[key] || '',
        callsigns: new Map(),
        count: 0,
        firstT: t[i],
        lastT: t[i],
        maxAlt: -Infinity,
        minAlt: Infinity,
        maxGs: -Infinity,
        sumGs: 0,
        gsCount: 0,
        distance: 0,
        firstLat: lat[i],
        firstLon: lon[i],
        lastLat: lat[i],
        lastLon: lon[i],
        lastBearing: null,
        registration: ds.dicts.reg[r[i]] || null,
        typecode: ds.dicts.type[ty[i]] || null,
        category: ds.dicts.cat[c[i]] || null,
        military: !!mil[i],
        track: [],
      };
      groups.set(key, g);
    }
    const callsign = ds.dicts.flight[f[i]];
    if (callsign) g.callsigns.set(callsign, (g.callsigns.get(callsign) || 0) + 1);
    if (alt[i] !== -9999) {
      if (alt[i] > g.maxAlt) g.maxAlt = alt[i];
      if (alt[i] < g.minAlt) g.minAlt = alt[i];
    }
    if (gs[i] >= 0) {
      if (gs[i] > g.maxGs) g.maxGs = gs[i];
      g.sumGs += gs[i];
      g.gsCount++;
    }
    const d = haversineKm(g.lastLat, g.lastLon, lat[i], lon[i]);
    if (d < 400) g.distance += d; // ignore les sauts aberrants
    g.count++;
    g.firstT = Math.min(g.firstT, t[i]);
    g.lastT = Math.max(g.lastT, t[i]);
    g.lastLat = lat[i];
    g.lastLon = lon[i];
    g.lastBearing = ds.columns.brg[i] >= 0 ? ds.columns.brg[i] : null;
    g.track.push([lat[i], lon[i], alt[i], t[i]]);
  }

  const list = [...groups.values()].map((g) => {
    const callsigns = [...g.callsigns.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ...g,
      callsign: callsigns.length ? callsigns[0][0] : null,
      allCallsigns: callsigns.map((e) => e[0]),
      avgGs: g.gsCount ? g.sumGs / g.gsCount : null,
      duration: g.lastT - g.firstT,
    };
  });
  list.sort((a, b) => b.count - a.count);
  return list;
}

/** Histogramme temporel des positions et des aéronefs. */
export function buildTimeline(ds, indices, range) {
  const { t, h } = ds.columns;
  let start = range && range.start ? range.start : Infinity;
  let end = range && range.end ? range.end : -Infinity;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    start = Infinity;
    end = -Infinity;
    for (let k = 0; k < indices.length; k++) {
      const ti = t[indices[k]];
      if (ti < start) start = ti;
      if (ti > end) end = ti;
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { bins: [], start: null, end: null, binSize: 0 };
  }

  const span = end - start;
  let binSize;
  if (span <= 3 * 3600) binSize = 300;
  else if (span <= 36 * 3600) binSize = 3600;
  else if (span <= 14 * 86400) binSize = 6 * 3600;
  else if (span <= 120 * 86400) binSize = 86400;
  else binSize = 7 * 86400;

  const count = Math.max(1, Math.ceil((end - start) / binSize));
  const positions = new Float64Array(count);
  const aircraftSets = Array.from({ length: count }, () => new Set());

  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const b = Math.min(count - 1, Math.floor((t[i] - start) / binSize));
    positions[b] += 1;
    aircraftSets[b].add(h[i]);
  }

  return {
    start,
    end,
    binSize,
    bins: Array.from({ length: count }, (_, i) => ({
      start: start + i * binSize,
      end: start + (i + 1) * binSize,
      positions: positions[i],
      aircraft: aircraftSets[i].size,
    })),
  };
}

const CSV_COLUMNS = [
  ['t', (ds, i) => new Date(ds.columns.t[i] * 1000).toISOString()],
  ['hex', (ds, i) => ds.dicts.hex[ds.columns.h[i]] || ''],
  ['flight', (ds, i) => ds.dicts.flight[ds.columns.f[i]] || ''],
  ['lat', (ds, i) => ds.columns.lat[i].toFixed(6)],
  ['lon', (ds, i) => ds.columns.lon[i].toFixed(6)],
  ['alt', (ds, i) => (ds.columns.alt[i] === -9999 ? '' : ds.columns.alt[i])],
  ['gs', (ds, i) => (ds.columns.gs[i] < 0 ? '' : ds.columns.gs[i])],
  ['bearing', (ds, i) => (ds.columns.brg[i] < 0 ? '' : ds.columns.brg[i])],
  ['registration', (ds, i) => ds.dicts.reg[ds.columns.r[i]] || ''],
  ['typecode', (ds, i) => ds.dicts.type[ds.columns.ty[i]] || ''],
  ['category', (ds, i) => ds.dicts.cat[ds.columns.c[i]] || ''],
  ['military', (ds, i) => (ds.columns.mil[i] ? 'true' : 'false')],
];

export function resultsToCsv(ds, indices) {
  const lines = [CSV_COLUMNS.map((c) => c[0]).join(',')];
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    lines.push(CSV_COLUMNS.map(([, fn]) => fn(ds, i)).join(','));
  }
  return lines.join('\n');
}

export function aircraftToCsv(list) {
  const header = ['hex', 'callsign', 'registration', 'typecode', 'category', 'military', 'positions', 'first_seen', 'last_seen', 'max_alt_ft', 'avg_gs_kt', 'distance_km'];
  const lines = [header.join(',')];
  for (const a of list) {
    lines.push([
      a.hex,
      a.callsign || '',
      a.registration || '',
      a.typecode || '',
      a.category || '',
      a.military ? 'true' : 'false',
      a.count,
      new Date(a.firstT * 1000).toISOString(),
      new Date(a.lastT * 1000).toISOString(),
      Number.isFinite(a.maxAlt) ? Math.round(a.maxAlt) : '',
      a.avgGs ? a.avgGs.toFixed(1) : '',
      a.distance ? Math.round(a.distance) : '',
    ].join(','));
  }
  return lines.join('\n');
}
