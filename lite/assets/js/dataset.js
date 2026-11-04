/**
 * Turnstone Lite — modèle de données en colonnes (compact et rapide).
 */

const FIELDS = ['t', 'lat', 'lon', 'alt', 'gs', 'brg'];
const INDEX_FIELDS = ['h', 'f', 'r', 'ty', 'c'];
const DICTS = ['hex', 'flight', 'reg', 'type', 'cat'];

export class ColumnBuilder {
  constructor() {
    this.t = [];
    this.lat = [];
    this.lon = [];
    this.alt = [];
    this.gs = [];
    this.brg = [];
    this.h = [];
    this.f = [];
    this.r = [];
    this.ty = [];
    this.c = [];
    this.mil = [];
    this.dicts = { hex: [], flight: [], reg: [], type: [], cat: [] };
    this._idx = { hex: new Map(), flight: new Map(), reg: new Map(), type: new Map(), cat: new Map() };
  }

  get size() {
    return this.t.length;
  }

  _push(key, value) {
    const dict = this.dicts[key];
    const map = this._idx[key];
    if (!value) return 0;
    let id = map.get(value);
    if (id === undefined) {
      id = dict.length;
      dict.push(value);
      map.set(value, id);
    }
    return id;
  }

  add(rec) {
    this.t.push(rec.t);
    this.lat.push(rec.lat);
    this.lon.push(rec.lon);
    this.alt.push(rec.alt === null || rec.alt === undefined ? -9999 : rec.alt);
    this.gs.push(rec.gs === null || rec.gs === undefined ? -1 : rec.gs);
    this.brg.push(rec.bearing === null || rec.bearing === undefined ? -1 : rec.bearing);
    this.h.push(this._push('hex', rec.hex));
    this.f.push(this._push('flight', rec.flight));
    this.r.push(this._push('reg', rec.registration || rec.reg));
    this.ty.push(this._push('type', rec.typecode || rec.type));
    this.c.push(this._push('cat', rec.category || rec.cat));
    this.mil.push(rec.military ? 1 : 0);
  }

  append(other) {
    // fusionne un autre ColumnBuilder (dicts remappés)
    const map = {};
    for (const key of DICTS) {
      map[key] = new Int32Array(other.dicts[key].length).fill(-1);
    }
    for (let i = 0; i < other.size; i++) {
      const rec = {
        t: other.t[i],
        lat: other.lat[i],
        lon: other.lon[i],
        alt: other.alt[i] === -9999 ? null : other.alt[i],
        gs: other.gs[i] === -1 ? null : other.gs[i],
        bearing: other.brg[i] === -1 ? null : other.brg[i],
        hex: other.dicts.hex[other.h[i]],
        flight: other.dicts.flight[other.f[i]],
        registration: other.dicts.reg[other.r[i]],
        typecode: other.dicts.type[other.ty[i]],
        category: other.dicts.cat[other.c[i]],
        military: other.mil[i] === 1,
      };
      this.add(rec);
    }
    return this;
  }

  finish(meta = {}) {
    const n = this.t.length;
    const ds = {
      meta: { ...meta, count: n },
      n,
      columns: {
        t: Float64Array.from(this.t),
        lat: Float32Array.from(this.lat),
        lon: Float32Array.from(this.lon),
        alt: Float32Array.from(this.alt),
        gs: Float32Array.from(this.gs),
        brg: Float32Array.from(this.brg),
        h: Uint32Array.from(this.h),
        f: Uint32Array.from(this.f),
        r: Uint32Array.from(this.r),
        ty: Uint32Array.from(this.ty),
        c: Uint32Array.from(this.c),
        mil: Uint8Array.from(this.mil),
      },
      dicts: this.dicts,
    };
    this.t = this.lat = this.lon = this.alt = this.gs = this.brg = null;
    this.h = this.f = this.r = this.ty = this.c = this.mil = null;
    return ds;
  }
}

/** Construit un dataset à partir de lignes brutes (format heatmap ou CSV). */
export function datasetFromRows(rows, meta = {}) {
  const builder = new ColumnBuilder();
  for (const r of rows) builder.add(r);
  return builder.finish(meta);
}

/** Charge le JSON de démonstration (format colonne compressé). */
export function datasetFromDemoJson(json) {
  const { dict, rows, meta } = json;
  const n = rows.length;
  const columns = {
    t: new Float64Array(n),
    lat: new Float32Array(n),
    lon: new Float32Array(n),
    alt: new Float32Array(n),
    gs: new Float32Array(n),
    brg: new Float32Array(n),
    h: new Uint32Array(n),
    f: new Uint32Array(n),
    r: new Uint32Array(n),
    ty: new Uint32Array(n),
    c: new Uint32Array(n),
    mil: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    columns.t[i] = r[0];
    columns.h[i] = r[1];
    columns.f[i] = r[2];
    columns.lat[i] = r[3];
    columns.lon[i] = r[4];
    columns.alt[i] = r[5];
    columns.gs[i] = r[6];
    columns.brg[i] = r[7];
    columns.r[i] = r[8];
    columns.ty[i] = r[9];
    columns.c[i] = r[10];
    columns.mil[i] = r[11];
  }
  return { meta: { ...meta, count: n }, n, columns, dicts: dict };
}

/** Statistiques générales sur un dataset. */
export function describeDataset(ds) {
  const { t, h, c, mil } = ds.columns;
  let tMin = Infinity;
  let tMax = -Infinity;
  const hexes = new Set();
  for (let i = 0; i < ds.n; i++) {
    if (t[i] < tMin) tMin = t[i];
    if (t[i] > tMax) tMax = t[i];
    hexes.add(h[i]);
  }
  const categories = [...new Set(Array.from(c).map((id) => ds.dicts.cat[id]).filter(Boolean))].sort();
  let militaryCount = 0;
  for (let i = 0; i < ds.n; i++) if (mil[i]) militaryCount++;
  return {
    count: ds.n,
    aircraft: hexes.size,
    tMin: Number.isFinite(tMin) ? tMin : null,
    tMax: Number.isFinite(tMax) ? tMax : null,
    categories,
    militaryCount,
  };
}

export function hexOf(ds, i) {
  return ds.dicts.hex[ds.columns.h[i]];
}
export function flightOf(ds, i) {
  return ds.dicts.flight[ds.columns.f[i]] || null;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatAlt(alt) {
  if (alt === null || alt === undefined || alt === -9999) return '—';
  if (alt === -123) return 'sol';
  return `${Math.round(alt).toLocaleString('fr-FR')} ft`;
}

export function formatTime(t, withDate = true) {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const opts = withDate
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }
    : { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };
  return d.toLocaleString('fr-FR', opts).replace(',', '');
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h} h ${String(m).padStart(2, '0')}`;
  if (h) return `${h} h`;
  if (m) return `${m} min`;
  return `${s} s`;
}
