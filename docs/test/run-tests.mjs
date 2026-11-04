/**
 * Tests du décodeur et du moteur de requête de Turnstone Lite.
 * Exécution : node docs/test/run-tests.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readTarStream, parseHeatmapBuffer, parseCsv } from '../assets/js/parse.js';
import { datasetFromDemoJson, datasetFromRows, describeDataset, mergeDatasets } from '../assets/js/dataset.js';
import { queryDataset, aggregateByAircraft, buildTimeline, resultsToCsv } from '../assets/js/query.js';
import { normalizeAircraft, parseAcList, parseOpenSky, bboxAround, fetchLive } from '../assets/js/live.js';

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

  console.log(failures ? `\n${failures} test(s) en échec\n` : '\nTous les tests passent\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
