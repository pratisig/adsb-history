/**
 * Tests du décodeur et du moteur de requête de Turnstone Lite.
 * Exécution : node docs/test/run-tests.mjs
 */

import { readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readTarStream, parseHeatmapBuffer, parseCsv } from '../assets/js/parse.js';
import {
  parseWorld,
  distanceNm,
  filterByPoint,
  filterByBbox,
  countryBbox,
  searchAirports,
  rowsToDataset,
  WORLD_FIELDS,
} from '../assets/js/world.js';
import { datasetFromDemoJson, datasetFromRows, describeDataset, mergeDatasets } from '../assets/js/dataset.js';
import { queryDataset, aggregateByAircraft, buildTimeline, resultsToCsv } from '../assets/js/query.js';
import {
  normalizeAircraft,
  parseAcList,
  parseOpenSky,
  bboxAround,
  fetchLive,
  parseSnapshot,
  snapshotTraffic,
  snapshotUrl,
  snapshotCandidates,
  snapshotIndexCandidates,
  extractJson,
  relayUrl,
  RELAYS,
  RELAYS_PUBLIC,
  fetchSnapshot,
  fetchSnapshotIndex,
  openSkyCost,
  BROWSER_PROVIDERS,
  OPENSKY_DAILY_CREDITS,
} from '../assets/js/live.js';
import { collect as collectSnapshot, parseArgs } from '../tools/live-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function closeTo(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

async function collectFromArchive(files) {
  const blob = files.length === 1 ? files[0] : new Blob(files);
  const points = [];
  const names = [];
  await readTarStream(
    blob.stream(),
    (name, buffer) => {
      names.push(name);
      parseHeatmapBuffer(buffer, { minIntervalSec: 0, onPoint: (p) => points.push(p) });
    },
    {}
  );
  points.sort((a, b) => a.t - b.t);
  return { points, names };
}

async function main() {
  const fixtureDir = path.join(here, 'fixtures');
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'expected.json'), 'utf8')).points;
  const tarBuf = await readFile(path.join(fixtureDir, 'sample.tar'));
  const partA = await readFile(path.join(fixtureDir, 'sample.tar.aa'));
  const partB = await readFile(path.join(fixtureDir, 'sample.tar.ab'));

  console.log('\nDécodage d’une archive tar complète');
  {
    const { points, names } = await collectFromArchive([new Blob([tarBuf])]);
    check('10 positions décodées', points.length === expected.length, `obtenu ${points.length}`);
    check(
      'fichiers heatmap seuls retenus',
      names.length === 2 && names.every((n) => /\/\d+$/.test(n)),
      JSON.stringify(names)
    );
    let ok = true;
    for (let i = 0; i < expected.length && i < points.length; i++) {
      const e = expected[i];
      const p = points[i];
      if (
        p.hex !== e.hex ||
        !closeTo(p.t, e.t, 0.01) ||
        !closeTo(p.lat, e.lat, 1e-5) ||
        !closeTo(p.lon, e.lon, 1e-5) ||
        p.alt !== e.alt ||
        (e.gs === null ? false : !closeTo(p.gs, e.gs, 0.11)) ||
        (p.flight || null) !== (e.flight || null)
      ) {
        ok = false;
        console.log('       écart sur', JSON.stringify(p), 'vs', JSON.stringify(e));
        break;
      }
    }
    check('valeurs conformes (temps, position, altitude, vitesse, callsign)', ok);
  }

  console.log('\nArchive découpée (.tar.aa + .tar.ab)');
  {
    const { points } = await collectFromArchive([new Blob([partA]), new Blob([partB])]);
    check('lecture en flux des morceaux concaténés', points.length === expected.length, `obtenu ${points.length}`);
  }

  console.log('\nFiltrage géographique à l’import');
  {
    const points = [];
    const entries = [];
    await readTarStream(new Blob([tarBuf]).stream(), (name, buffer) => {
      entries.push(name);
      parseHeatmapBuffer(buffer, {
        minIntervalSec: 0,
        bbox: [-18, 13, -16, 16],
        onPoint: (p) => points.push(p),
      });
    });
    check('seules les positions du Sénégal sont gardées', points.length === 7, `obtenu ${points.length}`);
  }

  console.log('\nImport CSV générique');
  {
    const csv = await readFile(path.join(fixtureDir, 'sample.csv'), 'utf8');
    const { rows, skipped } = parseCsv(csv);
    check('lignes CSV lues', rows.length === expected.length, `obtenu ${rows.length}`);
    check('aucune ligne ignorée', skipped === 0);
    check('horodatage ISO interprété', closeTo(rows[0].t, expected[0].t, 1));
    const ds = datasetFromRows(rows);
    const { indices } = queryDataset(ds, { bbox: [-18, 13, -16, 16] });
    check('requête bbox sur CSV', indices.length === 7, `obtenu ${indices.length}`);
  }

  console.log('\nRequêtes sur le jeu de démonstration');
  {
    const raw = JSON.parse(await readFile(path.join(here, '..', 'data', 'demo.json'), 'utf8'));
    const ds = datasetFromDemoJson(raw);
    const stats = describeDataset(ds);
    check('dataset chargé', ds.n === raw.rows.length && ds.n > 1000);
    check('couverture temporelle de plusieurs jours', stats.tMax - stats.tMin > 48 * 3600);

    const all = queryDataset(ds, { limit: 1e6 });
    check('requête sans filtre = toutes les positions', all.indices.length === ds.n);

    const mil = queryDataset(ds, { military: 'yes', limit: 1e6 });
    check('filtre militaire', mil.indices.length > 0 && mil.indices.length < ds.n);

    const africa = queryDataset(ds, { bbox: [-25, 4, 0, 22], limit: 1e6 });
    check('filtre géographique', africa.indices.length > 0 && africa.indices.length < ds.n);

    const sorted = Array.from(all.indices).every((v, i, arr) => i === 0 || ds.columns.t[arr[i - 1]] <= ds.columns.t[v]);
    check('résultats triés par temps', sorted);

    const aircraft = aggregateByAircraft(ds, all.indices);
    check('agrégation par aéronef', aircraft.length > 100);
    check('comptage cohérent', aircraft.reduce((s, a) => s + a.count, 0) === ds.n);
    check('distances calculées', aircraft.some((a) => a.distance > 100));
    check('indicatifs récupérés', aircraft.filter((a) => a.callsign).length > 100);

    const timeline = buildTimeline(ds, all.indices, {});
    const total = timeline.bins.reduce((s, b) => s + b.positions, 0);
    check('histogramme temporel', Math.abs(total - ds.n) < 1e-6 && timeline.bins.length >= 10, `${timeline.bins.length} bins`);

    const csv = resultsToCsv(ds, all.indices.slice(0, 10));
    check('export CSV', csv.split('\n').length === 11 && csv.includes('2026-10-28T'));

    // fusion de deux jeux de données (import multi-jours)
    {
      const a = datasetFromDemoJson(raw);
      const half = Math.floor(a.n / 2);
      const cut = {
        meta: { ...a.meta },
        n: half,
        columns: Object.fromEntries(Object.entries(a.columns).map(([k, v]) => [k, v.slice(0, half)])),
        dicts: a.dicts,
      };
      const merged = mergeDatasets(cut, a);
      check('fusion : total des positions', merged.n === half + a.n, `${merged.n}`);
      check('fusion : dictionnaires cohérents', merged.dicts.hex.length === a.dicts.hex.length);
      const res = queryDataset(merged, { limit: 1e6 });
      check('fusion : requête sur le jeu fusionné', res.indices.length === merged.n);
      const agg = aggregateByAircraft(merged, res.indices);
      check('fusion : agrégation sur le jeu fusionné', agg.length === aircraft.length);
    }

    const callSign = aircraft[0].callsign;
    const byFlight = queryDataset(ds, { flight: callSign, limit: 1e6 });
    check(`filtre indicatif (${callSign})`, byFlight.indices.length === aircraft[0].count);

    const withReg = aircraft.find((a) => a.registration);
    if (withReg) {
      const byReg = queryDataset(ds, { reg: withReg.registration.slice(0, 4), limit: 1e6 });
      check(`filtre immatriculation (${withReg.registration})`, byReg.indices.length >= withReg.count);
    }

    const hex = aircraft[0].hex;
    const byHex = queryDataset(ds, { hex, limit: 1e6 });
    check(`filtre hex (${hex})`, byHex.indices.length === aircraft[0].count);
  }

  console.log('\nWorker d’import (chemin utilisé par l’interface)');
  {
    const messages = [];
    globalThis.self = {
      postMessage: (msg, transfer) => {
        messages.push(msg);
        void transfer;
      },
      onmessage: null,
    };
    await import('../assets/js/import-worker.js');
    const blobA = new Blob([partA]);
    const blobB = new Blob([partB]);
    globalThis.self.onmessage({
      data: {
        type: 'start',
        files: [blobA, blobB],
        options: { bbox: null, minIntervalSec: 0, maxPoints: 1000 },
      },
    });
    const done = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const final = messages.find((m) => m.type === 'done' || m.type === 'error');
        if (final) {
          clearInterval(poll);
          final.type === 'done' ? resolve(final) : reject(new Error(final.message));
        } else if (Date.now() - t0 > 10000) {
          clearInterval(poll);
          reject(new Error('timeout du worker'));
        }
      }, 20);
    });
    // la progression est limitée à un message / 150 ms : sur une archive minuscule
    // seul le message final peut apparaître.
    check('aucune erreur signalée', messages.every((m) => m.type !== 'error'));
    check('dataset produit par le worker', done.count === expected.length, `obtenu ${done.count}`);
    check(
      'colonnes typées et transférables',
      done.dataset.columns.t instanceof Float64Array && done.dataset.columns.h instanceof Uint32Array
    );
    check(
      'dictionnaires de chaînes',
      done.dataset.dicts.hex.includes('0a0001') && done.dataset.dicts.flight.includes('SZN204')
    );
    const ds = done.dataset;
    const { indices } = queryDataset(ds, { flight: 'GTS77' });
    check('requête sur le dataset importé', indices.length === 3, `obtenu ${indices.length}`);
  }

  console.log('\nWorker d’import — flux direct (import depuis une URL)');
  {
    const messages = [];
    globalThis.self.postMessage = (msg) => messages.push(msg);
    const blob = new Blob([tarBuf]);
    globalThis.self.onmessage({
      data: {
        type: 'start-stream',
        stream: blob.stream(),
        totalBytes: blob.size,
        options: { bbox: null, minIntervalSec: 0, maxPoints: 1000 },
      },
    });
    const done = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const final = messages.find((m) => m.type === 'done' || m.type === 'error');
        if (final) {
          clearInterval(poll);
          final.type === 'done' ? resolve(final) : reject(new Error(final.message));
        } else if (Date.now() - t0 > 10000) {
          clearInterval(poll);
          reject(new Error('timeout du worker (flux)'));
        }
      }, 20);
    });
    check('dataset produit depuis un flux', done.count === expected.length, `obtenu ${done.count}`);
    check(
      'positions du flux identiques à celles du fichier',
      done.dataset.dicts.hex.length === 3 && done.dataset.dicts.flight.includes('SZN204')
    );
  }

  console.log('\nIngestion en direct (API ADS-B publiques)');
  {
    const adsblol = {
      ac: [
        {
          hex: '0A0001',
          flight: 'SZN204 ',
          r: '6V-AMC',
          t: 'A319',
          alt_baro: 31000,
          gs: 440.2,
          track: 118.4,
          lat: 14.7,
          lon: -17.4,
          category: 'A3',
          dbFlags: 1,
        },
        { hex: '3c1234', lat: null, lon: null },
      ],
      total: 2,
    };
    const points = parseAcList(adsblol);
    check('parse adsb.lol : aéronefs sans position ignorés', points.length === 1);
    const p = points[0];
    check('callsign normalisé', p.flight === 'SZN204');
    check('altitude / vitesse / cap', p.alt === 31000 && Math.abs(p.gs - 440.2) < 1e-6 && Math.abs(p.bearing - 118.4) < 1e-6);
    check('indicateur militaire (dbFlags)', p.military === true);
    check('immatriculation et type', p.reg === '6V-AMC' && p.type === 'A319');
    check('position au sol', normalizeAircraft({ hex: 'abcdef', lat: 1, lon: 2, alt_baro: 'ground' }).alt === -123);
    check('aéronef sans position rejeté', normalizeAircraft({ hex: 'abcdef' }) === null);

    const opensky = {
      time: 1,
      states: [
        ['4ca7b3', 'RYR123 ', 'Ireland', 1690000000, 1690000000, -6.1, 50.1, 10000, false, 220.5, 90.0, 0, null, 10500, '1234', false, 0],
      ],
    };
    const op = parseOpenSky(opensky);
    check('parse OpenSky', op.length === 1 && op[0].hex === '4ca7b3');
    check('conversion altitude mètres → pieds', Math.abs(op[0].alt - 32808.4) < 1);
    check('conversion vitesse m/s → nœuds', Math.abs(op[0].gs - 428.6) < 1);
    const b = bboxAround(14.74, -17.49, 60);
    check(
      'bornes géographiques autour d’un point',
      b.lamin < 14.74 && b.lamax > 14.74 && b.lomin < -17.49 && b.lomax > -17.49
    );

    const urls = [];
    const fetchStub = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => adsblol };
    };
    const live = await fetchLive({ lat: 14.74, lon: -17.49, radiusNm: 60, fetchImpl: fetchStub });
    check('fetchLive : fournisseur principal', live.providerId === 'adsblol' && live.points.length === 1);
    check('fetchLive : URL de l’API', urls[0] === 'https://api.adsb.lol/v2/point/14.7400/-17.4900/60', urls[0]);

    const flaky = async (url) => {
      if (url.includes('adsb.lol')) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => adsblol };
    };
    const fallback = await fetchLive({ lat: 14.74, lon: -17.49, radiusNm: 60, fetchImpl: flaky });
    check('bascule automatique vers le fournisseur suivant', fallback.providerId === 'airplaneslive');

    let message = '';
    try {
      await fetchLive({
        lat: 14.74,
        lon: -17.49,
        fetchImpl: async () => {
          throw new TypeError('blocked');
        },
      });
    } catch (err) {
      message = err.message;
    }
    check('message explicite si toutes les sources échouent', /Aucune source en direct/i.test(message), message.slice(0, 80));
  }


  /* ---------------------------------------------------------------------- */
  console.log('\nRelevé automatique (données réelles sans CORS)');
  {
    const raw = {
      zone: { id: 'dakar', label: 'Dakar', lat: 14.74, lon: -17.49, radius: 150 },
      updated: '2026-11-04T13:00:00.000Z',
      provider: 'adsb.lol',
      windowMinutes: 180,
      fields: ['t', 'hex', 'flight', 'reg', 'type', 'category', 'military', 'lat', 'lon', 'alt', 'gs', 'track', 'squawk'],
      samples: [
        [1793796000, '07007c', '6VHAG', '6V-HAG', 'A139', 'A7', 0, 14.92, -17.58, 2850, 148.6, 216.8, '0733'],
        [1793796030, '07007c', '6VHAG', '6V-HAG', 'A139', 'A7', 0, 14.93, -17.59, 2800, 150, 216.8, '0733'],
        [1793796030, '0700dd', '6WHEM', '6W-HEM', 'B505', 'A7', 1, 14.82, -17.28, 1400, 87.5, 67.8, '0716'],
      ],
    };
    const snap = parseSnapshot(raw);
    check('parseSnapshot : échantillons lus', snap && snap.samples.length === 3);
    check('parseSnapshot : colonnes mappées', snap.samples[0].hex === '07007c' && snap.samples[0].registration === '6V-HAG');
    check('parseSnapshot : indicateur militaire', snap.samples[2].military === true);
    check('parseSnapshot : tri chronologique', snap.samples[2].t === 1793796030 && snap.samples[1].t === 1793796030);
    check('parseSnapshot : bornes du relevé', snap.first === 1793796000 && snap.last === 1793796030);
    check('parseSnapshot : contenu invalide rejeté', parseSnapshot({ nope: true }) === null);

    const traffic = snapshotTraffic(snap);
    check('snapshotTraffic : dernière position par aéronef', traffic.points.length === 2);
    check('snapshotTraffic : traînée du premier aéronef', traffic.trails.get('07007c').length === 2);
    const limited = snapshotTraffic(snap, { windowMinutes: 0.25 });
    check('snapshotTraffic : fenêtre appliquée', limited.points.length === 2 && limited.trails.get('07007c').length === 1);

    check('extractJson : texte du relais r.jina.ai', extractJson('Title: \n\nMarkdown Content:\n{"ac":[{"hex":"abc"}]}\n') !== null);
    check('extractJson : texte non JSON rejeté', extractJson('Rate limit exceeded') === null);
    const jina = RELAYS.find((relay) => relay.id === 'jina');
    const allorigins = RELAYS.find((relay) => relay.id === 'allorigins');
    const codetabs = RELAYS.find((relay) => relay.id === 'codetabs');
    check(
      'relayUrl : préfixe r.jina.ai',
      relayUrl(jina, 'https://api.adsb.lol/v2/point/1/2/3') === 'https://r.jina.ai/https://api.adsb.lol/v2/point/1/2/3'
    );
    check(
      'relayUrl : allorigins encode l’URL cible',
      relayUrl(allorigins, 'https://api.adsb.lol/v2/point/1/2/3') ===
        'https://api.allorigins.win/raw?url=https%3A%2F%2Fapi.adsb.lol%2Fv2%2Fpoint%2F1%2F2%2F3'
    );
    check(
      'relayUrl : codetabs encode l’URL cible',
      relayUrl(codetabs, 'https://api.adsb.lol/v2/point/1/2/3').startsWith('https://api.codetabs.com/v1/proxy?quest=https%3A%2F%2F')
    );
    check('relais publics : trois relais proposés', RELAYS_PUBLIC.length === 3, String(RELAYS_PUBLIC.length));
    check(
      'relayUrl : appel direct inchangé',
      relayUrl(RELAYS[0], 'https://api.adsb.lol/v2/point/1/2/3') === 'https://api.adsb.lol/v2/point/1/2/3'
    );
    check('snapshotUrl : URL du relevé publié', /raw\.githubusercontent\.com/.test(snapshotUrl('dakar')) && snapshotUrl('dakar').endsWith('/data/dakar.json'));
    check('snapshotCandidates : miroir puis copie locale', snapshotCandidates('dakar').length === 3);
    // --- photo mondiale : tous les pays, tous les aéroports ------------------
    const worldRaw = {
      updated: '2026-11-05T18:00:00.000Z',
      source: 'adsb.lol',
      fields: WORLD_FIELDS,
      samples: [
        [1762366800, 'aaaaaa', 'AFR001', 'F-GAAA', 'B738', 48.9, 2.4, 30000, 450, 90],
        [1762366800, 'bbbbbb', 'RAM200', 'CN-RAM', 'B788', 33.6, -7.6, 35000, 470, 200],
        [1762366800, 'cccccc', 'SZN001', '6V-AAA', 'A319', 14.75, -17.48, 12000, 300, 180],
        [1762366800, 'dddddd', '', '', '', 35.6, 139.7, 38000, 480, 45],
      ],
    };
    const world = parseWorld(worldRaw);
    check('monde : photo lue', world && world.rows.length === 4, String(world && world.rows.length));
    check('monde : aéronefs comptés', world.aircraft === 4);
    check('monde : date de la photo', world.at === 1762366800);
    check('monde : champs absents tolérés', world.rows[3].flight === null && world.rows[3].reg === null);
    check('monde : payload vide ignoré', parseWorld({}) === null);

    const dkr = { lat: 14.67, lon: -17.07 };
    const distCm = distanceNm(dkr.lat, dkr.lon, 33.6, -7.6);
    check('monde : distance DKR → Casablanca ≈ 1 180 NM', Math.abs(distCm - 1180) < 120, String(Math.round(distCm)));
    const nearDkr = filterByPoint(world, dkr.lat, dkr.lon, 100);
    check('monde : filtre par aéroport (rayon)', nearDkr.length === 1 && nearDkr[0].hex === 'cccccc');

    const airports = [
      { iata: 'DKR', name: 'Blaise Diagne', city: 'Dakar', cc: 'SN', lat: 14.67, lon: -17.07 },
      { iata: 'CMN', name: 'Mohammed V', city: 'Casablanca', cc: 'MA', lat: 33.37, lon: -7.59 },
      { iata: 'HND', name: 'Haneda', city: 'Tokyo', cc: 'JP', lat: 35.55, lon: 139.78 },
    ];
    check('monde : recherche par code IATA', searchAirports(airports, 'cmn')[0].iata === 'CMN');
    check('monde : recherche par ville', searchAirports(airports, 'casablanca')[0].iata === 'CMN');
    check('monde : recherche sans résultat', searchAirports(airports, 'zzz').length === 0);
    const maBbox = countryBbox(airports, 'MA');
    check(
      'monde : boîte du pays calculée',
      maBbox[0] < 33.37 && maBbox[2] > 33.37 && maBbox[1] < -7.59 && maBbox[3] > -7.59,
      String(maBbox)
    );
    const inMorocco = filterByBbox(world, maBbox);
    check('monde : filtre par pays', inMorocco.length === 1 && inMorocco[0].hex === 'bbbbbb');
    check('monde : pays sans aéroport', countryBbox(airports, 'XX') === null);
    check(
      'monde : conversion en lignes de jeu de données',
      rowsToDataset(world.rows).every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    );

    const catalog = JSON.parse(await readFile(new URL('../data/airports.json', import.meta.url), 'utf8'));
    check('catalogue : milliers d’aéroports', catalog.rows.length > 5000, String(catalog.rows.length));
    check('catalogue : pays nommés en français', catalog.countries.SN === 'Sénégal' && catalog.countries.FR === 'France');
    check(
      'catalogue : couverture mondiale',
      new Set(catalog.rows.map((r) => r[3])).size > 150,
      String(new Set(catalog.rows.map((r) => r[3])).size)
    );
    check(
      'catalogue : champs exploitables',
      catalog.rows.every((r) => typeof r[0] === 'string' && r[0].length === 3 && Number.isFinite(r[4]) && Number.isFinite(r[5]))
    );

    const indexUrls = snapshotIndexCandidates();
    check(
      'snapshotIndexCandidates : liste des zones lisible même sans relevé',
      indexUrls.includes('data/live-zones.json'),
      indexUrls.join(' ')
    );

    // Zones déclarées : c'est le seul endroit à modifier pour relever un autre coin du monde.
    const zonesConfig = JSON.parse(
      await readFile(new URL('../data/live-zones.json', import.meta.url), 'utf8')
    );
    const zones = zonesConfig.zones || [];
    check('live-zones.json : au moins une zone déclarée', zones.length > 0);
    check(
      'live-zones.json : champs obligatoires',
      zones.every(
        (z) =>
          typeof z.id === 'string' &&
          /^[a-z0-9-]+$/.test(z.id) &&
          typeof z.label === 'string' &&
          Number.isFinite(z.lat) &&
          Number.isFinite(z.lon) &&
          Number.isFinite(z.radius)
      )
    );
    check(
      'live-zones.json : identifiants uniques',
      new Set(zones.map((z) => z.id)).size === zones.length
    );
    check(
      'live-zones.json : coordonnées valides',
      zones.every((z) => Math.abs(z.lat) <= 90 && Math.abs(z.lon) <= 180 && z.radius > 0 && z.radius <= 500)
    );
    check(
      'live-zones.json : zones du monde entier, pas seulement le Sénégal',
      zones.some((z) => Math.abs(z.lat) > 30 || Math.abs(z.lon) > 30)
    );

    const relayed = await fetchLive({
      lat: 14.74,
      lon: -17.49,
      radiusNm: 60,
      relays: RELAYS,
      fetchImpl: async (url) => {
        if (url.startsWith('https://r.jina.ai/')) {
          return { ok: true, text: async () => 'Markdown Content:\n{"ac":[{"hex":"abc123","lat":14.7,"lon":-17.4}]}\n' };
        }
        throw new TypeError('Failed to fetch');
      },
    });
    check('relais CORS utilisé quand l’appel direct est bloqué', relayed.points.length === 1 && /relais/.test(relayed.provider), relayed.provider);
    let blockingMessage = '';
    try {
      await fetchLive({ lat: 14.74, lon: -17.49, fetchImpl: async () => { throw new TypeError('blocked'); } });
    } catch (err) {
      blockingMessage = err.message;
    }
    check('erreurs détaillées : CORS nommé', /appel bloqué \(CORS\/DNS\)/.test(blockingMessage), blockingMessage.slice(0, 60));
    check('erreurs détaillées : relevé automatique proposé', /relevé automatique/i.test(blockingMessage));

    const urlsTried = [];
    const snapshotFetch = async (url) => {
      urlsTried.push(url);
      if (url.includes('raw.githubusercontent.com')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => raw };
    };
    const fetched = await fetchSnapshot({ fetchImpl: snapshotFetch, timeoutMs: 1000 });
    check('fetchSnapshot : bascule vers le miroir', fetched.samples.length === 3 && urlsTried.length === 2);
    const index = await fetchSnapshotIndex({
      fetchImpl: async () => ({ ok: true, json: async () => ({ zones: [{ id: 'dakar', label: 'Dakar' }] }) }),
    });
    check('fetchSnapshotIndex : zones listées', Array.isArray(index) && index[0].id === 'dakar');

    check('crédits OpenSky : petit rayon = 1 crédit', openSkyCost(14.74, 50) === 1);
    check('crédits OpenSky : grand rayon plus cher', openSkyCost(14.74, 250) >= 2);
    check('crédits OpenSky : quota anonyme', OPENSKY_DAILY_CREDITS === 400);
    check(
      'fournisseurs navigateur : OpenSky d’abord (seul à envoyer CORS)',
      BROWSER_PROVIDERS[0].id === 'opensky' && BROWSER_PROVIDERS.length === 4
    );

    const parsedArgs = parseArgs(['--loop-minutes=7', '--poll-seconds=30', '--out', 'data', '--seed']);
    check(
      'arguments du workflow lus (--clé=valeur)',
      parsedArgs['loop-minutes'] === '7' && parsedArgs['poll-seconds'] === '30' && parsedArgs.out === 'data' && parsedArgs.seed === true,
      JSON.stringify(parsedArgs)
    );

    /* Collecte côté serveur : écriture d'un relevé à partir d'une API simulée. */
    const dir = await mkdtemp(path.join(os.tmpdir(), 'turnstone-live-'));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('raw.githubusercontent.com')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ ac: [{ hex: 'abc123', flight: 'TEST1 ', lat: 14.7, lon: -17.4, alt_baro: 1200, gs: 100, track: 90 }] }) };
    };
    try {
      await collectSnapshot({ out: dir, zonesFile: null, pollSeconds: 0, loopMinutes: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
    const written = JSON.parse(await readFile(path.join(dir, 'dakar.json'), 'utf8'));
    const writtenIndex = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    check('collecte : fichier de zone écrit', written.rows === 1 && written.samples[0][1] === 'abc123');
    check('collecte : index des zones écrit', writtenIndex.zones[0].id === 'dakar' && writtenIndex.zones[0].aircraft === 1);
    check('collecte : relevé relisible par le site', parseSnapshot(written) !== null);
  }

  // --- photo mondiale : balayage réussi, puis échec 429 qui ne doit rien effacer ---
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'turnstone-world-'));
    const prevFetch = globalThis.fetch;
    const worldAc = {
      ac: [
        { hex: 'aaaaaa', flight: 'AFR001', lat: 48.9, lon: 2.4, alt_baro: 30000, gs: 450, track: 90 },
        { hex: 'bbbbbb', flight: 'RAM200', lat: 33.6, lon: -7.6, alt_baro: 35000, gs: 470, track: 200 },
      ],
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('raw.githubusercontent.com')) return { ok: false, status: 404, json: async () => ({}) };
      if (u.includes('/v2/point/0/0/')) return { ok: true, json: async () => worldAc };
      return { ok: true, json: async () => ({ ac: [] }) };
    };
    let first;
    try {
      first = await collectSnapshot({ out: dir, zonesFile: null, pollSeconds: 0, loopMinutes: 0, world: true, worldSleep: async () => {} });
    } finally {
      globalThis.fetch = prevFetch;
    }
    const worldFile = JSON.parse(await readFile(path.join(dir, 'world.json'), 'utf8'));
    check('monde : photo publiée', worldFile.samples.length === 2 && worldFile.aircraft === 2, String(worldFile.samples.length));
    check('monde : index renseigné', first.index.world && first.index.world.aircraft === 2);
    check('monde : champs attendus', worldFile.fields.join(',') === 't,hex,flight,reg,type,lat,lon,alt,gs,track');

    // 429 partout : la photo précédente doit survivre, fichier compris
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/v2/point/0/0/') || u.includes('opensky-network.org')) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      if (u.includes('raw.githubusercontent.com')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ ac: [] }) };
    };
    let second;
    try {
      second = await collectSnapshot({ out: dir, zonesFile: null, pollSeconds: 0, loopMinutes: 0, world: true, worldSleep: async () => {} });
    } finally {
      globalThis.fetch = prevFetch;
    }
    const kept = JSON.parse(await readFile(path.join(dir, 'world.json'), 'utf8'));
    check('monde 429 : photo précédente conservée', kept.samples.length === 2, String(kept.samples.length));
    check('monde 429 : index pointe sur la photo conservée', Boolean(second.index.world));
    const status429 = JSON.parse(await readFile(path.join(dir, 'world-status.json'), 'utf8'));
    check('monde 429 : statut publié', status429.ok === true && status429.total === 0, JSON.stringify(status429));
    check('monde 429 : erreurs lisibles', status429.errors.some((e) => /429/.test(e)), status429.errors.join(' · '));
  }

  console.log(failures ? `\n${failures} test(s) en échec\n` : '\nTous les tests passent\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
