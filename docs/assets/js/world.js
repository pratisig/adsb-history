/**
 * Turnstone Lite — photo mondiale.
 *
 * Le collecteur publie `world.json` : **tous** les aéronefs positionnés connus de
 * l'agrégateur (une requête de rayon 20 000 NM suffit), soit la planète entière.
 * Ce module ne fait que filtrer cette photo — par aéroport (rayon) ou par pays —
 * pour que le site couvre réellement tous les pays et tous les aéroports, sans
 * déclarer de zone.
 */

/** Colonnes des lignes publiées (ordre de `fields` dans world.json). */
export const WORLD_FIELDS = ['t', 'hex', 'flight', 'reg', 'type', 'lat', 'lon', 'alt', 'gs', 'track'];

/** Distance approximative en milles nautiques entre deux points. */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Lit une photo mondiale publiée.
 * @returns {{updated:string|null, at:number|null, aircraft:number, rows:object[]}|null}
 */
export function parseWorld(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.samples)) return null;
  const fields = Array.isArray(raw.fields) && raw.fields.length ? raw.fields : WORLD_FIELDS;
  const idx = Object.fromEntries(fields.map((f, i) => [f, i]));
  const rows = [];
  for (const sample of raw.samples) {
    if (!Array.isArray(sample)) continue;
    const lat = sample[idx.lat];
    const lon = sample[idx.lon];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({
      t: Number(sample[idx.t]) || 0,
      hex: String(sample[idx.hex] || ''),
      flight: emptyToNull(sample[idx.flight]),
      reg: emptyToNull(sample[idx.reg]),
      type: emptyToNull(sample[idx.type]),
      lat,
      lon,
      alt: Number.isFinite(sample[idx.alt]) ? sample[idx.alt] : null,
      gs: Number.isFinite(sample[idx.gs]) ? sample[idx.gs] : null,
      track: Number.isFinite(sample[idx.track]) ? sample[idx.track] : null,
    });
  }
  const at = rows.length ? Math.max(...rows.map((r) => r.t)) : null;
  return {
    updated: raw.updated || null,
    at,
    aircraft: new Set(rows.map((r) => r.hex)).size,
    source: raw.source || null,
    rows,
  };
}

function emptyToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** Aéronefs dans un rayon autour d'un point. */
export function filterByPoint(world, lat, lon, radiusNm) {
  const radius = Number(radiusNm) || 50;
  return world.rows.filter((row) => distanceNm(lat, lon, row.lat, row.lon) <= radius);
}

/** Boîte englobante d'un pays, calculée à partir de ses aéroports (marge incluse). */
export function countryBbox(airports, cc, paddingDeg = 1.5) {
  const pts = airports.filter((a) => a.cc === cc);
  if (!pts.length) return null;
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const a of pts) {
    minLat = Math.min(minLat, a.lat);
    maxLat = Math.max(maxLat, a.lat);
    minLon = Math.min(minLon, a.lon);
    maxLon = Math.max(maxLon, a.lon);
  }
  return [
    Math.max(-90, minLat - paddingDeg),
    Math.max(-180, minLon - paddingDeg),
    Math.min(90, maxLat + paddingDeg),
    Math.min(180, maxLon + paddingDeg),
  ];
}

/** Aéronefs dans une boîte [minLat, minLon, maxLat, maxLon]. */
export function filterByBbox(world, bbox) {
  if (!bbox) return [];
  const [minLat, minLon, maxLat, maxLon] = bbox;
  return world.rows.filter(
    (row) =>
      row.lat >= minLat && row.lat <= maxLat && row.lon >= minLon && row.lon <= maxLon
  );
}

/**
 * Recherche un aéroport : code IATA exact d'abord, puis nom/ville.
 * @returns {object[]} jusqu'à `limit` correspondances, la meilleure d'abord
 */
export function searchAirports(airports, query, limit = 20) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return [];
  const exact = airports.filter((a) => a.iata === q);
  if (exact.length) return exact.slice(0, limit);
  const scored = [];
  for (const a of airports) {
    const name = `${a.name || ''} ${a.city || ''}`.toUpperCase();
    const pos = name.indexOf(q);
    if (pos === -1) continue;
    scored.push({ airport: a, score: pos === 0 ? 0 : 1 + pos / 1000 });
  }
  scored.sort((x, y) => x.score - y.score);
  return scored.slice(0, limit).map((s) => s.airport);
}

/** Libellé lisible d'un aéroport. */
export function airportLabel(airport) {
  if (!airport) return '';
  const city = airport.city ? `${airport.city}, ` : '';
  return `${airport.iata} · ${airport.name || 'aéroport'} (${city}${airport.cc})`;
}

/** Convertit des lignes « monde » en lignes de jeu de données (format interne). */
export function rowsToDataset(rows) {
  return rows.map((row) => ({
    t: row.t,
    hex: row.hex,
    flight: row.flight,
    reg: row.reg,
    type: row.type,
    category: null,
    military: false,
    lat: row.lat,
    lon: row.lon,
    alt: row.alt,
    gs: row.gs,
    bearing: row.track,
    squawk: null,
  }));
}
