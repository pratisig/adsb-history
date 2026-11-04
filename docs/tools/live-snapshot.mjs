#!/usr/bin/env node
/**
 * Turnstone Lite — relevé ADS-B automatique (côté serveur, sans dépendance).
 *
 * Les API ADS-B publiques (adsb.lol, adsb.fi, OpenSky) ne renvoient pas d'en-tête
 * `Access-Control-Allow-Origin` : un navigateur ne peut donc pas les lire
 * directement, quelle que soit la page qui l'essaie. Ce script fait le travail
 * depuis une machine ordinaire (le runner GitHub Actions du dépôt) et publie un
 * relevé en JSON, que le site — lui — peut lire sans problème.
 *
 * Usage :
 *   node docs/tools/live-snapshot.mjs                       # un relevé unique
 *   node docs/tools/live-snapshot.mjs --loop-minutes 4      # relevé toutes les 30 s pendant 4 min
 *   node docs/tools/live-snapshot.mjs --seed                # reprend le relevé précédent (branche live)
 *
 * Options : --out <dir> (défaut data), --zones <fichier.json>, --poll-seconds <n>,
 *           --window-minutes <n>, --seed, --repo <owner/name>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PROVIDERS, parseAcList, parseOpenSky } from '../assets/js/live.js';

/** Ordre des fournisseurs côté serveur (airplanes.live réserve son API aux projets déclarés). */
const PROVIDER_ORDER = ['adsblol', 'adsbfi', 'opensky', 'airplaneslive'];

/** Colonnes des échantillons publiés — l'ordre est celui du tableau `fields`. */
export const SAMPLE_FIELDS = [
  't', 'hex', 'flight', 'reg', 'type', 'category', 'military',
  'lat', 'lon', 'alt', 'gs', 'track', 'squawk',
];

const DEFAULTS = {
  zone: { id: 'dakar', label: 'Dakar', lat: 14.74, lon: -17.49, radius: 150 },
  pollSeconds: 30,
  windowMinutes: 180,
  maxRows: 200000,
  repo: 'pratisig/adsb-history',
};

const R = (v, n) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(n)) : null);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function providerFor(id) {
  return PROVIDERS.find((p) => p.id === id);
}

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', 'User-Agent': 'turnstone-lite-live/1.0' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Interroge les fournisseurs dans l'ordre ; renvoie le premier qui répond
 * effectivement avec des aéronefs.
 */
async function pollZone(zone, radiusCap = 250) {
  const radius = Math.max(1, Math.min(radiusCap, Math.round(zone.radius || 50)));
  const errors = [];
  for (const id of PROVIDER_ORDER) {
    const provider = providerFor(id);
    if (!provider) continue;
    const url = provider.url(zone.lat.toFixed(4), zone.lon.toFixed(4), radius);
    try {
      const data = await fetchJson(url);
      const points = provider.parse(data);
      if (!points) {
        errors.push(`${provider.label} : réponse inattendue`);
        continue;
      }
      return { provider: provider.label, providerId: provider.id, points, errors };
    } catch (err) {
      errors.push(`${provider.label} : ${err && err.message ? err.message : 'échec'}`);
    }
  }
  return { provider: null, providerId: null, points: [], errors };
}

function toRow(point, t) {
  return [
    t,
    point.hex || '',
    point.flight || '',
    point.reg || '',
    point.type || '',
    point.category || '',
    point.military ? 1 : 0,
    R(point.lat, 5),
    R(point.lon, 5),
    typeof point.alt === 'number' ? Math.round(point.alt) : null,
    R(point.gs, 1),
    R(point.bearing, 1),
    point.squawk || '',
  ];
}

async function loadZones(file) {
  if (!file) return [DEFAULTS.zone];
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const zones = Array.isArray(raw) ? raw : raw.zones;
    if (Array.isArray(zones) && zones.length) {
      return zones.map((z, i) => ({
        id: String(z.id || `zone-${i}`).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
        label: z.label || z.id || `Zone ${i + 1}`,
        lat: Number(z.lat),
        lon: Number(z.lon),
        radius: Number(z.radius || 150),
      })).filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lon));
    }
  } catch (err) {
    console.warn(`Zones illisibles (${file}) : ${err.message}`);
  }
  return [DEFAULTS.zone];
}

/** Reprend le relevé publié lors du passage précédent (fenêtre glissante). */
async function seedZone(zone, { repo, out, windowMinutes }) {
  const candidates = [
    `https://raw.githubusercontent.com/${repo}/live/data/${zone.id}.json`,
    path.join(out, `${zone.id}.json`),
  ];
  for (const ref of candidates) {
    try {
      const raw = ref.startsWith('http')
        ? await fetchJson(ref, 20000)
        : JSON.parse(await readFile(ref, 'utf8'));
      if (!raw || !Array.isArray(raw.samples)) continue;
      const min = Math.floor(Date.now() / 1000) - windowMinutes * 60;
      const samples = raw.samples.filter((row) => Array.isArray(row) && row[0] >= min);
      if (samples.length) return samples;
    } catch {
      /* premier passage : aucune amorce disponible */
    }
  }
  return [];
}

function pruneAndTidy(samples, { windowMinutes, maxRows }) {
  const min = Math.floor(Date.now() / 1000) - windowMinutes * 60;
  const kept = samples.filter((row) => Array.isArray(row) && Number.isFinite(row[0]) && row[0] >= min);
  kept.sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])));
  return kept.length > maxRows ? kept.slice(kept.length - maxRows) : kept;
}

async function writeZone(outDir, zone, samples, meta) {
  const file = path.join(outDir, `${zone.id}.json`);
  const payload = {
    zone,
    updated: new Date().toISOString(),
    provider: meta.provider,
    providerId: meta.providerId,
    windowMinutes: meta.windowMinutes,
    fields: SAMPLE_FIELDS,
    first: samples.length ? new Date(samples[0][0] * 1000).toISOString() : null,
    last: samples.length ? new Date(samples[samples.length - 1][0] * 1000).toISOString() : null,
    rows: samples.length,
    aircraft: new Set(samples.map((row) => row[1])).size,
    errors: meta.errors.slice(-8),
    samples,
  };
  await writeFile(file, JSON.stringify(payload));
  return payload;
}

export async function collect({
  out = 'data',
  zonesFile = null,
  pollSeconds = DEFAULTS.pollSeconds,
  windowMinutes = DEFAULTS.windowMinutes,
  maxRows = DEFAULTS.maxRows,
  loopMinutes = 0,
  seed = false,
  repo = DEFAULTS.repo,
  log = console.log,
} = {}) {
  const zones = await loadZones(zonesFile);
  await mkdir(out, { recursive: true });

  const buffers = new Map();
  for (const zone of zones) {
    buffers.set(zone.id, seed ? await seedZone(zone, { repo, out, windowMinutes }) : []);
    if (buffers.get(zone.id).length) {
      log(`Amorce ${zone.id} : ${buffers.get(zone.id).length} positions reprises.`);
    }
  }

  const cycles = loopMinutes > 0 ? Math.max(1, Math.round((loopMinutes * 60) / pollSeconds)) : 1;
  let lastMeta = { provider: null, providerId: null, errors: [] };

  for (let cycle = 0; cycle < cycles; cycle++) {
    const startedAt = Date.now();
    const results = await Promise.all(zones.map((zone) => pollZone(zone)));
    const t = Math.floor(startedAt / 1000);

    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const result = results[i];
      const buffer = buffers.get(zone.id);
      for (const point of result.points) buffer.push(toRow(point, t));

      if (result.points.length) {
        log(`${new Date(t * 1000).toISOString()} · ${zone.id} · ${result.points.length} aéronefs · ${result.provider}`);
      } else {
        log(`${new Date(t * 1000).toISOString()} · ${zone.id} · aucun aéronef (${result.errors.join(' · ')})`);
      }
      lastMeta = { provider: result.provider, providerId: result.providerId, errors: result.errors };
    }

    if (cycle < cycles - 1) {
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(1000, pollSeconds * 1000 - elapsed);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  const written = [];
  for (const zone of zones) {
    const samples = pruneAndTidy(buffers.get(zone.id), { windowMinutes, maxRows });
    written.push(await writeZone(out, zone, samples, {
      provider: lastMeta.provider,
      providerId: lastMeta.providerId,
      windowMinutes,
      errors: lastMeta.errors,
    }));
    log(`${zone.id} : ${samples.length} positions publiées (${written[written.length - 1].aircraft} aéronefs).`);
  }

  const index = {
    generated: new Date().toISOString(),
    repo,
    zones: written.map((w) => ({
      id: w.zone.id,
      label: w.zone.label,
      lat: w.zone.lat,
      lon: w.zone.lon,
      radius: w.zone.radius,
      provider: w.provider,
      updated: w.updated,
      first: w.first,
      last: w.last,
      rows: w.rows,
      aircraft: w.aircraft,
    })),
  };
  await writeFile(path.join(out, 'index.json'), JSON.stringify(index, null, 2));
  return { zones: written, index };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('live-snapshot.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  collect({
    out: typeof args.out === 'string' ? args.out : 'data',
    zonesFile: typeof args.zones === 'string' ? args.zones : 'docs/data/live-zones.json',
    pollSeconds: Number(args['poll-seconds'] || DEFAULTS.pollSeconds),
    windowMinutes: Number(args['window-minutes'] || DEFAULTS.windowMinutes),
    maxRows: Number(args['max-rows'] || DEFAULTS.maxRows),
    loopMinutes: Number(args['loop-minutes'] || 0),
    seed: Boolean(args.seed),
    repo: typeof args.repo === 'string' ? args.repo : process.env.GITHUB_REPOSITORY || DEFAULTS.repo,
  }).catch((err) => {
    console.error(`Relevé impossible : ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}

export { parseAcList, parseOpenSky };
