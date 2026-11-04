/**
 * Turnstone Lite — décodeur du format binaire "heatmap" de tar1090 / readsb.
 *
 * Ce module est volontairement sans dépendance et fonctionne aussi bien dans le
 * navigateur (module ES) que sous Node (pour les tests).
 *
 * Format (identique à backend-data-loading/process_adsb_data.py) :
 *   - suite d'int32 little-endian ;
 *   - une "trace" commence par un enregistrement dont le 1er int vaut MARKER,
 *     suivi de l'horodatage (2 mots 32 bits) puis du hex de l'aéronef ;
 *   - les enregistrements suivants décrivent une position :
 *       int0 : hex (24 bits) + bit 24 = indicateur "~" (non-ICAO)
 *       int1 : latitude * 1e6  (si > 1073741824 : enregistrement de métadonnées)
 *       int2 : longitude * 1e6 (ou 8 octets du callsign pour les métadonnées)
 *       int3 : altitude sur 16 bits bas (× 25 ft, -123 = au sol)
 *              vitesse sol sur 16 bits hauts (÷ 10 kt, -1 = inconnue)
 */

export const MARKER = 243235997;

const T_OFFSET = 4294967.296; // secondes par incrément du mot haut

/**
 * Décode un fichier heatmap binaire.
 *
 * @param {ArrayBuffer} buffer
 * @param {object} [options]
 * @param {number[]|null} [options.bbox] [minLon, minLat, maxLon, maxLat]
 * @param {number} [options.minIntervalSec] intervalle minimum entre 2 points d'un même aéronef
 * @param {number} [options.limit] nombre maximum de points à produire
 * @param {(rec: object) => void} [options.onPoint] callback appelé pour chaque point retenu
 * @returns {{points:number, traces:number, truncated:boolean}}
 */
export function parseHeatmapBuffer(buffer, options = {}) {
  const {
    bbox = null,
    minIntervalSec = 60,
    limit = Infinity,
    onPoint = () => {},
  } = options;

  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const n = Math.floor(buffer.byteLength / 4);

  const lastSeen = new Map();
  const acinfo = new Map();
  let points = 0;
  let traces = 0;
  let truncated = false;

  const inBbox = (lat, lon) => {
    if (!bbox) return true;
    return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
  };

  let i = 0;
  while (i + 3 < n) {
    if (dv.getInt32(i * 4, true) !== MARKER) {
      i += 4;
      continue;
    }

    traces++;
    const now =
      dv.getUint32(i * 4 + 8, true) / 1e3 + T_OFFSET * dv.getUint32(i * 4 + 4, true);
    let j = i + 4;

    while (j + 3 < n && dv.getInt32(j * 4, true) !== MARKER) {
      const f0 = dv.getInt32(j * 4, true);
      const f1 = dv.getInt32(j * 4 + 4, true);
      const f2 = dv.getInt32(j * 4 + 8, true);
      const f3 = dv.getInt32(j * 4 + 12, true);

      let hex = (f0 & 0xffffff).toString(16).padStart(6, '0');
      if (f0 & (1 << 24)) hex = '~' + hex;

      if (f1 > 1073741824) {
        // Enregistrement de métadonnées : callsign (8 octets) + squawk
        const off = (j + 2) * 4;
        let flight = null;
        if (bytes[off] !== 0) {
          let s = '';
          for (let k = 0; k < 8; k++) {
            const c = bytes[off + k];
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          flight = s.trim() || null;
        }
        acinfo.set(hex, { flight, squawk: String(f1 & 0xffff).padStart(4, '0') });
      } else {
        const lat = f1 / 1e6;
        const lon = f2 / 1e6;

        if (lat > -90 && lat < 90 && lon > -180 && lon < 180) {
          const info = acinfo.get(hex);
          let alt = f3 & 0xffff;
          if (alt & 0x8000) alt -= 0x10000; // extension de signe 16 bits
          alt = alt === -123 ? -123 : alt * 25;

          let gs = f3 >> 16;
          gs = gs === -1 ? null : gs / 10;

          const prev = lastSeen.get(hex);
          if (prev === undefined || now - prev >= minIntervalSec) {
            lastSeen.set(hex, now);
            if (inBbox(lat, lon)) {
              onPoint({
                t: now,
                hex,
                flight: info ? info.flight : null,
                squawk: info ? info.squawk : null,
                lat,
                lon,
                alt,
                gs,
                type: (f0 >>> 27) & 31,
              });
              points++;
              if (points >= limit) {
                truncated = true;
                return { points, traces, truncated };
              }
            }
          }
        }
      }
      j += 4;
    }
    i = j;
  }

  return { points, traces, truncated };
}

/* -------------------------------------------------------------------------- */
/* Lecture d'archives tar en flux (sans charger 3 Go en mémoire)               */
/* -------------------------------------------------------------------------- */

class StreamReader {
  constructor(stream) {
    this.reader = stream.getReader();
    this.chunks = [];
    this.length = 0;
    this.done = false;
    this.consumed = 0;
  }

  async fill(min) {
    while (this.length < min && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      this.chunks.push(value);
      this.length += value.length;
    }
  }

  /** Lit exactement n octets (moins en fin de flux). */
  async read(n) {
    await this.fill(n);
    const size = Math.min(n, this.length);
    const out = new Uint8Array(size);
    let off = 0;
    while (off < size) {
      const c = this.chunks[0];
      const take = Math.min(c.length, size - off);
      out.set(c.subarray(0, take), off);
      off += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
      this.length -= take;
      this.consumed += take;
    }
    return out;
  }

  async skip(n) {
    let left = n;
    while (left > 0 && !this.done) {
      await this.fill(1);
      if (!this.length) break;
      const c = this.chunks[0];
      const take = Math.min(c.length, left);
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
      this.length -= take;
      this.consumed += take;
      left -= take;
    }
  }
}

function cstr(bytes, off, len) {
  let end = off;
  const max = off + len;
  while (end < max && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(off, end));
}

function parseSize(header) {
  // champ "size" : octal ASCII, ou base-256 (bit de poids fort) pour les gros fichiers
  if (header[124] & 0x80) {
    let v = 0;
    for (let i = 125; i < 136; i++) v = v * 256 + header[i];
    return v;
  }
  const s = cstr(header, 124, 12).trim();
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * Parcourt une archive tar (éventuellement découpée puis concaténée) et appelle
 * `onFile(name, data)` pour chaque fichier heatmap rencontré.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {(name: string, data: ArrayBuffer, progress: object) => void} onFile
 * @param {object} [options]
 */
export async function readTarStream(stream, onFile, options = {}) {
  const { totalBytes = null, onProgress = () => {}, signal = null } = options;
  const reader = new StreamReader(stream);
  let pendingName = null;
  let paxPath = null;
  let files = 0;
  let parsedBytes = 0;

  for (;;) {
    if (signal && signal.aborted) throw new DOMException('Import annulé', 'AbortError');
    const header = await reader.read(512);
    if (header.length < 512) break;
    if (isZeroBlock(header)) continue; // fin d'archive / remplissage

    let name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = parseSize(header);
    const type = String.fromCharCode(header[156] || 48);

    if (type === 'L') {
      pendingName = cstr(await reader.read(size), 0, size).replace(/\0+$/, '');
      await reader.skip((512 - (size % 512)) % 512);
      continue;
    }
    if (type === 'x' || type === 'g') {
      const data = await reader.read(size);
      const txt = new TextDecoder().decode(data);
      const m = txt.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      await reader.skip((512 - (size % 512)) % 512);
      continue;
    }

    const fullName = paxPath || pendingName || name;
    paxPath = null;
    pendingName = null;

    const base = fullName.split('/').pop() || '';
    const isHeatmapFile = /^\d{1,2}$/.test(base) || (/\/heatmap\//.test(fullName) && /^\d{1,2}\.(bin|dat)$/.test(base));
    const wanted = isHeatmapFile && !/\/traces\//.test(fullName) && type !== '5';

    if (wanted && size > 0) {
      const data = await reader.read(size);
      parsedBytes += data.byteLength;
      files++;
      onFile(fullName, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
        files,
        bytes: parsedBytes,
        totalBytes,
        name: fullName,
      });
      onProgress({
        files,
        bytes: parsedBytes,
        totalBytes,
        ratio: totalBytes ? Math.min(1, reader.consumed / totalBytes) : null,
        name: fullName,
      });
    } else {
      await reader.skip(size);
      if (totalBytes) {
        onProgress({
          files,
          bytes: parsedBytes,
          totalBytes,
          ratio: Math.min(1, reader.consumed / totalBytes),
          name: fullName,
        });
      }
    }
    await reader.skip((512 - (size % 512)) % 512);
  }

  return { files, bytes: parsedBytes };
}

/* -------------------------------------------------------------------------- */
/* Import CSV                                                                  */
/* -------------------------------------------------------------------------- */

const CSV_ALIASES = {
  t: ['t', 'time', 'timestamp', 'datetime', 'date'],
  hex: ['hex', 'icao', 'icao24', 'icao_hex'],
  flight: ['flight', 'callsign', 'call', 'flight_number'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
  alt: ['alt', 'altitude', 'alt_baro', 'baro_altitude'],
  gs: ['gs', 'speed', 'ground_speed', 'velocity'],
  bearing: ['bearing', 'track', 'heading', 'true_track'],
  registration: ['registration', 'reg', 'tail'],
  typecode: ['typecode', 'type', 'aircraft_type'],
  category: ['category', 'cat'],
  military: ['military', 'mil'],
};

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function detectDelimiter(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const semis = (headerLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

/**
 * Convertit un CSV en lignes normalisées (mêmes champs que le parser heatmap).
 * @param {string} text
 * @param {object} [options]
 * @returns {{rows: object[], skipped: number}}
 */
export function parseCsv(text, options = {}) {
  const { onPoint = null, limit = Infinity } = options;
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { rows: [], skipped: 0 };

  const delim = detectDelimiter(lines[0]);
  const header = lines[0].split(delim).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = {};
  for (const [key, aliases] of Object.entries(CSV_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) col[key] = idx;
  }
  if (col.lat === undefined || col.lon === undefined) {
    throw new Error("Le CSV doit contenir des colonnes 'lat'/'latitude' et 'lon'/'longitude'.");
  }

  const rows = [];
  let skipped = 0;
  for (let li = 1; li < lines.length; li++) {
    const cells = splitCsvLine(lines[li]);
    if (delim === ';') {
      // déjà découpé sur ';' et ','
    }
    const num = (key) => {
      const v = col[key] === undefined ? NaN : parseFloat(String(cells[col[key]]).replace(',', '.'));
      return Number.isFinite(v) ? v : null;
    };
    const lat = num('lat');
    const lon = num('lon');
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      skipped++;
      continue;
    }
    let t = null;
    if (col.t !== undefined) {
      const raw = cells[col.t];
      const asNum = Number(raw);
      if (Number.isFinite(asNum) && String(raw).trim() !== '') t = asNum > 1e11 ? asNum / 1000 : asNum;
      else t = Date.parse(raw) / 1000;
      if (!Number.isFinite(t)) t = null;
    }
    const rec = {
      t: t === null ? Date.now() / 1000 : t,
      hex: col.hex !== undefined ? String(cells[col.hex] || '').trim().toLowerCase() : '',
      flight: col.flight !== undefined ? String(cells[col.flight] || '').trim() || null : null,
      lat,
      lon,
      alt: num('alt'),
      gs: num('gs'),
      bearing: num('bearing'),
      registration: col.registration !== undefined ? String(cells[col.registration] || '').trim() || null : null,
      typecode: col.typecode !== undefined ? String(cells[col.typecode] || '').trim() || null : null,
      category: col.category !== undefined ? String(cells[col.category] || '').trim() || null : null,
      military: col.military !== undefined ? /^(1|true|t|yes|oui|y)$/i.test(String(cells[col.military]).trim()) : null,
    };
    if (!rec.hex) rec.hex = `csv-${Math.abs(hashCode(`${rec.flight}|${rec.registration}`)).toString(16).slice(0, 6)}`;
    if (onPoint) onPoint(rec);
    else rows.push(rec);
    if (rows.length >= limit) break;
  }
  return { rows, skipped };
}

export function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
