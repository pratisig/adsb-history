/**
 * Turnstone Lite — worker d'import.
 * Lit l'archive tar en flux, décode les fichiers heatmap et renvoie un dataset
 * en colonnes (les tableaux typés sont transférés sans copie).
 */

import { readTarStream, parseHeatmapBuffer } from './parse.js';
import { ColumnBuilder } from './dataset.js';

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== 'start') return;
  try {
    await run(msg);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

async function run({ files, options }) {
  const { bbox = null, minIntervalSec = 60, maxPoints = 3000000 } = options || {};
  const builder = new ColumnBuilder();
  const blob = files.length === 1 ? files[0] : new Blob(files);
  const total = blob.size;
  const stream = blob.stream();
  let lastPost = 0;
  let fileCount = 0;
  let truncated = false;

  await readTarStream(
    stream,
    (name, buffer, progress) => {
      const room = maxPoints - builder.size;
      if (room <= 0) {
        truncated = true;
        return;
      }
      fileCount = progress.files;
      const result = parseHeatmapBuffer(buffer, {
        bbox,
        minIntervalSec,
        limit: room,
        onPoint: (rec) => builder.add(rec),
      });
      if (result.truncated) truncated = true;
      const now = performance.now();
      if (now - lastPost > 150) {
        lastPost = now;
        self.postMessage({
          type: 'progress',
          files: progress.files,
          name: progress.name,
          ratio: progress.ratio,
          bytes: progress.bytes,
          totalBytes: total,
          points: builder.size,
        });
      }
    },
    { totalBytes: total }
  );

  const count = builder.size;
  const dataset = builder.finish({
    source: 'import',
    files: fileCount,
    importedAt: Date.now(),
    bbox,
    minIntervalSec,
  });
  self.postMessage(
    { type: 'done', dataset, count, truncated },
    Object.values(dataset.columns).map((a) => a.buffer)
  );
}
