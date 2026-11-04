/**
 * Tests du décodeur et du moteur de requête de Turnstone Lite.
 * Exécution : node lite/test/run-tests.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readTarStream, parseHeatmapBuffer, parseCsv } from '../assets/js/parse.js';
import { datasetFromDemoJson, datasetFromRows, describeDataset, mergeDatasets } from '../assets/js/dataset.js';
import { queryDataset, aggregateByAircraft, buildTimeline, resultsToCsv } from '../assets/js/query.js';

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

  console.log(failures ? `\n${failures} test(s) en échec\n` : '\nTous les tests passent\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
