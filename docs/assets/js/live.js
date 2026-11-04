/**
 * Turnstone Lite — ingestion ADS-B en direct.
 *
 * Deux voies, complémentaires :
 *
 * 1. **Relevé automatique** (`fetchSnapshot`) : un runner GitHub interroge les API
 *    ADS-B publiques toutes les 30 s et publie un JSON sur la branche `live`
 *    (voir `.github/workflows/live-snapshot.yml`). Le navigateur lit ce fichier —
 *    données réelles, sans archive, sans clé, et sans dépendre du CORS.
 * 2. **Appel direct** (`fetchLive`) : le navigateur interroge lui-même les API.
 *    Ces services n'envoient pas d'en-tête `Access-Control-Allow-Origin`, donc le
 *    navigateur bloque la lecture ; la fonction reste utile via un relais CORS
 *    (option `relays`) ou pour un serveur auto-hébergé.
 *
 * Modèle de point commun à toute l'application :
 * { hex, flight, reg, type, category, military, lat, lon, alt, gs, bearing }
 */

/** Rayon maximal accepté par les API "point" (en milles nautiques). */
export const MAX_RADIUS_NM = 250;

/** Dépôt et branche où le relevé automatique est publié. */
export const SNAPSHOT_REPO = 'pratisig/adsb-history';
export const SNAPSHOT_BRANCH = 'live';

/** Colonnes des échantillons du relevé (ordre de `fields` dans le JSON). */
export const SAMPLE_FIELDS = [
  't', 'hex', 'flight', 'reg', 'type', 'category', 'military',
  'lat', 'lon', 'alt', 'gs', 'track', 'squawk',
];

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

/** Coût en crédits OpenSky d'une requête `states/all` selon la surface couverte. */
export function openSkyCost(lat, radiusNm) {
  const dLat = radiusNm / 60;
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const area = 2 * dLat * 2 * dLon;
  if (area <= 25) return 1;
  if (area <= 100) return 2;
  if (area <= 400) return 3;
  return 4;
}

/** Crédits OpenSky anonymes disponibles par jour. */
export const OPENSKY_DAILY_CREDITS = 400;

/**
 * Fournisseurs utilisables depuis un navigateur, par ordre de préférence.
 * Seul OpenSky envoie `Access-Control-Allow-Origin: *`.
 */
export const BROWSER_PROVIDERS = [
  PROVIDERS.find((p) => p.id === 'opensky'),
  PROVIDERS.find((p) => p.id === 'adsblol'),
  PROVIDERS.find((p) => p.id === 'airplaneslive'),
  PROVIDERS.find((p) => p.id === 'adsbfi'),
].filter(Boolean);

/* -------------------------------------------------------------------------- */
/* Relais CORS (facultatif)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Aucune des API ADS-B publiques n'envoie d'en-tête CORS : depuis un navigateur,
 * l'appel direct échoue toujours. Un relais (proxy qui ajoute l'en-tête) est donc
 * la seule façon d'obtenir du direct côté client ; il reste facultatif.
 */
export const RELAYS = [
  { id: 'direct', label: 'appel direct', wrap: (url) => url, text: false },
  {
    id: 'allorigins',
    label: 'relais allorigins',
    wrap: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    text: false,
  },
  {
    id: 'codetabs',
    label: 'relais codetabs',
    wrap: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    text: false,
  },
  {
    id: 'jina',
    label: 'relais r.jina.ai',
    // r.jina.ai renvoie un texte qui contient le JSON de la réponse
    wrap: (url) => `https://r.jina.ai/${url}`,
    text: true,
  },
];

/** Relais publics proposés (tous sauf l'appel direct). */
export const RELAYS_PUBLIC = RELAYS.filter((relay) => relay.id !== 'direct');

/** Construit l'URL relayée (préfixe libre accepté, `{url}` facultatif). */
export function relayUrl(relay, url) {
  if (!relay || typeof relay.wrap !== 'function') return url;
  return relay.wrap(url);
}

/** Extrait un objet JSON d'une réponse texte (le relais ajoute un en-tête). */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function describeFetchError(err, relay) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'délai dépassé';
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return 'hors ligne';
  if (err && typeof err.message === 'string' && /HTTP \d+/.test(err.message)) return err.message;
  return relay && relay.id !== 'direct' ? 'relais indisponible' : 'appel bloqué (CORS/DNS)';
}

/**
 * Récupère le trafic autour d'un point, en essayant les fournisseurs dans l'ordre,
 * puis les relais éventuels.
 *
 * @param {object} options
 * @param {number} options.lat
 * @param {number} options.lon
 * @param {number} [options.radiusNm]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] injectable pour les tests
 * @param {Array} [options.providers] liste de fournisseurs à essayer
 * @param {Array} [options.relays] relais à essayer après l'appel direct
 * @returns {Promise<{provider:string, providerId:string, points:object[], timestamp:number}>}
 */
export async function fetchLive({
  lat,
  lon,
  radiusNm = 50,
  timeoutMs = 9000,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  providers = PROVIDERS,
  relays = [RELAYS[0]],
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Position inconnue.');
  if (!fetchImpl) throw new Error('Ce navigateur ne permet pas les requêtes réseau.');

  const radius = Math.max(1, Math.min(MAX_RADIUS_NM, Math.round(radiusNm)));
  const errors = [];

  for (const relay of relays) {
    for (const provider of providers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const suffix = relay.id === 'direct' ? '' : ` (${relay.label})`;
      try {
        const target = provider.url(lat.toFixed(4), lon.toFixed(4), radius);
        const response = await fetchImpl(relayUrl(relay, target), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          mode: 'cors',
        });
        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}`);
          err.name = 'HttpError';
          throw err;
        }
        const data = relay.text ? extractJson(await response.text()) : await response.json();
        const points = provider.parse(data);
        if (!points) {
          errors.push(`${provider.label}${suffix} : réponse inattendue`);
          continue;
        }
        return {
          provider: provider.label + (relay.id === 'direct' ? '' : ` via ${relay.label}`),
          providerId: provider.id,
          relayId: relay.id,
          points,
          timestamp: Date.now(),
        };
      } catch (err) {
        errors.push(`${provider.label}${suffix} : ${describeFetchError(err, relay)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw new Error(
    `Aucune source en direct joignable — ${errors.join(' · ')}. ` +
      'Les API ADS-B publiques ne renvoient pas d’en-tête CORS : un navigateur ne peut pas les lire directement, ' +
      'quel que soit le réseau. Utilisez le relevé automatique (données réelles, collectées hors navigateur) ' +
      'ou renseignez un relais.'
  );
}

/* -------------------------------------------------------------------------- */
/* Relevé automatique (données réelles, lisibles sans CORS)                    */
/* -------------------------------------------------------------------------- */

/** URL du relevé publié pour une zone. */
export function snapshotUrl(zoneId = 'dakar', { repo = SNAPSHOT_REPO, branch = SNAPSHOT_BRANCH } = {}) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/data/${zoneId}.json`;
}

/** URLs de l'index des zones relevées. */
export function snapshotIndexCandidates({ repo = SNAPSHOT_REPO, branch = SNAPSHOT_BRANCH } = {}) {
  return [
    `https://raw.githubusercontent.com/${repo}/${branch}/data/index.json`,
    `https://cdn.jsdelivr.net/gh/${repo}@${branch}/data/index.json`,
    'data/live/index.json',
  ];
}

/** URLs essayées dans l'ordre pour un relevé (miroir CDN puis copie locale). */
export function snapshotCandidates(zoneId = 'dakar', { repo = SNAPSHOT_REPO, branch = SNAPSHOT_BRANCH } = {}) {
  return [
    snapshotUrl(zoneId, { repo, branch }),
    `https://cdn.jsdelivr.net/gh/${repo}@${branch}/data/${zoneId}.json`,
    `data/live/${zoneId}.json`,
  ];
}

/**
 * Lit un relevé automatique (`zone`, `updated`, `fields`, `samples`).
 * @returns {{zone:object, updated:string|null, provider:string|null, first:number|null,
 *            last:number|null, samples:object[]}|null}
 */
export function parseSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.samples)) return null;
  const fields = Array.isArray(raw.fields) && raw.fields.length ? raw.fields : SAMPLE_FIELDS;
  const samples = [];
  for (const row of raw.samples) {
    if (!Array.isArray(row)) continue;
    const obj = {};
    for (let i = 0; i < fields.length; i++) obj[fields[i]] = row[i];
    if (!Number.isFinite(obj.t) || !Number.isFinite(obj.lat) || !Number.isFinite(obj.lon)) continue;
    samples.push({
      t: obj.t,
      hex: String(obj.hex || '').toLowerCase(),
      flight: obj.flight || null,
      registration: obj.reg || null,
      typecode: obj.type || null,
      category: obj.category || null,
      military: obj.military === 1 || obj.military === true,
      lat: obj.lat,
      lon: obj.lon,
      alt: typeof obj.alt === 'number' ? obj.alt : null,
      gs: typeof obj.gs === 'number' ? obj.gs : null,
      bearing: typeof obj.track === 'number' ? obj.track : null,
      squawk: obj.squawk || null,
    });
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a.t - b.t);
  return {
    zone: raw.zone || null,
    updated: raw.updated || null,
    provider: raw.provider || null,
    windowMinutes: raw.windowMinutes || null,
    first: samples[0].t,
    last: samples[samples.length - 1].t,
    samples,
  };
}

/** Transforme un relevé en points (dernière position par aéronef) + traînées. */
export function snapshotTraffic(snapshot, { maxTrail = 240, windowMinutes = null } = {}) {
  const points = [];
  const trails = new Map();
  const latest = new Map();
  const minT = windowMinutes
    ? (snapshot.last || Math.floor(Date.now() / 1000)) - windowMinutes * 60
    : -Infinity;
  for (const sample of snapshot.samples) {
    if (sample.t < minT) continue;
    let trail = trails.get(sample.hex);
    if (!trail) {
      trail = [];
      trails.set(sample.hex, trail);
    }
    trail.push([sample.lat, sample.lon, sample.t]);
    if (trail.length > maxTrail) trail.shift();
    latest.set(sample.hex, sample);
  }
  for (const sample of latest.values()) {
    points.push({
      hex: sample.hex,
      flight: sample.flight,
      reg: sample.registration,
      type: sample.typecode,
      category: sample.category,
      military: sample.military,
      lat: sample.lat,
      lon: sample.lon,
      alt: sample.alt,
      gs: sample.gs,
      bearing: sample.bearing,
      squawk: sample.squawk,
    });
  }
  return { points, trails, lastT: snapshot.last };
}

/** Récupère le relevé automatique de la zone demandée. */
export async function fetchSnapshot({
  zoneId = 'dakar',
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  timeoutMs = 12000,
  urls = null,
  repo = SNAPSHOT_REPO,
  branch = SNAPSHOT_BRANCH,
} = {}) {
  if (!fetchImpl) throw new Error('Ce navigateur ne permet pas les requêtes réseau.');
  const candidates = urls || snapshotCandidates(zoneId, { repo, branch });
  const problems = [];
  for (const candidate of candidates) {
    // paramètre anti-cache : raw.githubusercontent.com sert des copies pendant 5 min
    const url = candidate.startsWith('http')
      ? `${candidate}${candidate.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 1000)}`
      : candidate;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, mode: 'cors' });
      if (!response.ok) {
        problems.push(`${url} : HTTP ${response.status}`);
        continue;
      }
      const snapshot = parseSnapshot(await response.json());
      if (!snapshot) {
        problems.push(`${url} : contenu inattendu`);
        continue;
      }
      snapshot.url = url;
      return snapshot;
    } catch (err) {
      problems.push(`${url} : ${describeFetchError(err, null)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Relevé automatique indisponible — ${problems.join(' · ')}`);
}

/** Liste des zones disponibles dans le relevé automatique. */
export async function fetchSnapshotIndex({
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  timeoutMs = 12000,
  urls = null,
  repo = SNAPSHOT_REPO,
  branch = SNAPSHOT_BRANCH,
} = {}) {
  if (!fetchImpl) return null;
  for (const url of urls || snapshotIndexCandidates({ repo, branch })) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, mode: 'cors' });
      if (!response.ok) continue;
      const data = await response.json();
      if (data && Array.isArray(data.zones) && data.zones.length) return data.zones;
    } catch {
      /* on essaie l'URL suivante */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
