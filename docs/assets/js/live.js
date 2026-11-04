/**
 * Turnstone Lite — ingestion ADS-B en direct.
 *
 * Interroge les API publiques (aucune archive à télécharger, aucune clé) dans
 * l'ordre de préférence et normalise les réponses vers le modèle de points de
 * l'application : { hex, flight, reg, type, category, military, lat, lon, alt, gs, bearing }.
 *
 * Les appels sont faits depuis le navigateur de l'utilisateur : les éventuelles
 * restrictions CORS sont traitées comme un simple échec du fournisseur, avec
 * bascule automatique sur le suivant.
 */

/** Rayon maximal accepté par les API "point" (en milles nautiques). */
export const MAX_RADIUS_NM = 250;

/**
 * Normalise un aéronef au format dump1090 / readsb (adsb.lol, airplanes.live, adsb.fi).
 * @returns {object|null}
 */
export function normalizeAircraft(ac) {
  if (!ac || typeof ac !== 'object') return null;
  // attention : Number(null) vaut 0 — on rejette explicitement les valeurs absentes
  if (ac.lat === null || ac.lat === undefined || ac.lat === '' || ac.lon === null || ac.lon === undefined || ac.lon === '') {
    return null;
  }
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  let alt = null;
  const altRaw = ac.alt_baro !== undefined ? ac.alt_baro : ac.alt_geom;
  if (typeof altRaw === 'number' && Number.isFinite(altRaw)) alt = altRaw;
  else if (altRaw === 'ground') alt = -123;

  const hex = String(ac.hex || '').toLowerCase().slice(0, 8);
  return {
    hex: hex || `live-${Math.round(lat * 1000)}-${Math.round(lon * 1000)}`,
    flight: ac.flight ? String(ac.flight).trim() || null : null,
    reg: ac.r || null,
    type: ac.t || null,
    category: ac.category || null,
    military: !!(ac.dbFlags && ac.dbFlags & 1),
    lat,
    lon,
    alt,
    gs: typeof ac.gs === 'number' && Number.isFinite(ac.gs) ? ac.gs : null,
    bearing: typeof ac.track === 'number' && Number.isFinite(ac.track) ? ac.track : null,
    squawk: ac.squawk || null,
  };
}

/** Extrait la liste d'aéronefs d'une réponse adsb.lol / airplanes.live / adsb.fi. */
export function parseAcList(data) {
  if (!data || typeof data !== 'object') return null;
  const list = Array.isArray(data.ac) ? data.ac : Array.isArray(data.aircraft) ? data.aircraft : null;
  if (!list) return null;
  return list.map(normalizeAircraft).filter(Boolean);
}

/** Normalise une réponse OpenSky `/states/all` (vecteurs d'état en tableaux). */
export function parseOpenSky(data) {
  if (!data || !Array.isArray(data.states)) return null;
  const points = [];
  for (const s of data.states) {
    if (!Array.isArray(s)) continue;
    if (s[5] === null || s[5] === undefined || s[6] === null || s[6] === undefined) continue;
    const lon = Number(s[5]);
    const lat = Number(s[6]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const altM = typeof s[7] === 'number' ? s[7] : s[13];
    const velMs = typeof s[9] === 'number' ? s[9] : null;
    points.push({
      hex: String(s[0] || '').toLowerCase(),
      flight: s[1] ? String(s[1]).trim() || null : null,
      reg: null,
      type: null,
      category: null,
      military: false,
      lat,
      lon,
      alt: typeof altM === 'number' ? altM * 3.28084 : null,
      gs: typeof velMs === 'number' ? velMs * 1.94384 : null,
      bearing: typeof s[10] === 'number' ? s[10] : null,
      squawk: s[14] ? String(s[14]) : null,
    });
  }
  return points;
}

/** Bornes géographiques approximatives autour d'un point (rayon en NM). */
export function bboxAround(lat, lon, radiusNm) {
  const dLat = radiusNm / 60;
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return {
    lamin: Math.max(-90, lat - dLat),
    lamax: Math.min(90, lat + dLat),
    lomin: Math.max(-180, lon - dLon),
    lomax: Math.min(180, lon + dLon),
  };
}

export const PROVIDERS = [
  {
    id: 'adsblol',
    label: 'adsb.lol',
    url: (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`,
    parse: parseAcList,
  },
  {
    id: 'airplaneslive',
    label: 'airplanes.live',
    url: (lat, lon, r) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`,
    parse: parseAcList,
  },
  {
    id: 'adsbfi',
    label: 'adsb.fi',
    url: (lat, lon, r) => `https://opendata.adsb.fi/api/v2/point/${lat}/${lon}/${r}`,
    parse: parseAcList,
  },
  {
    id: 'opensky',
    label: 'OpenSky',
    url: (lat, lon, r) => {
      const b = bboxAround(lat, lon, r);
      const q = new URLSearchParams({
        lamin: b.lamin.toFixed(3),
        lomin: b.lomin.toFixed(3),
        lamax: b.lamax.toFixed(3),
        lomax: b.lomax.toFixed(3),
      });
      return `https://opensky-network.org/api/states/all?${q.toString()}`;
    },
    parse: parseOpenSky,
  },
];

/**
 * Récupère le trafic autour d'un point, en essayant les fournisseurs dans l'ordre.
 *
 * @param {object} options
 * @param {number} options.lat
 * @param {number} options.lon
 * @param {number} [options.radiusNm]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] injectable pour les tests
 * @param {Array} [options.providers] liste de fournisseurs à essayer
 * @returns {Promise<{provider:string, points:object[], timestamp:number}>}
 */
export async function fetchLive({
  lat,
  lon,
  radiusNm = 50,
  timeoutMs = 9000,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  providers = PROVIDERS,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Position inconnue.');
  if (!fetchImpl) throw new Error('Ce navigateur ne permet pas les requêtes réseau.');

  const radius = Math.max(1, Math.min(MAX_RADIUS_NM, Math.round(radiusNm)));
  const errors = [];

  for (const provider of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = provider.url(lat.toFixed(4), lon.toFixed(4), radius);
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        mode: 'cors',
      });
      if (!response.ok) {
        errors.push(`${provider.label} : HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const points = provider.parse(data);
      if (!points) {
        errors.push(`${provider.label} : réponse inattendue`);
        continue;
      }
      return { provider: provider.label, providerId: provider.id, points, timestamp: Date.now() };
    } catch (err) {
      const why = err && err.name === 'AbortError' ? 'délai dépassé' : 'injoignable (réseau/CORS)';
      errors.push(`${provider.label} : ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Aucune source en direct joignable — ${errors.join(' · ')}. ` +
      'Un bloqueur de publicité ou un filtrage DNS peut bloquer ces API ; réessayez ou changez de réseau.'
  );
}
