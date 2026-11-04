#!/usr/bin/env python3
"""
Génère des archives de test au format tar1090 / globe_history afin de valider
le décodeur JavaScript (docs/assets/js/parse.js) sans dépendre de vraies données.

Produit dans docs/test/fixtures/ :
  - sample.tar           : archive complète
  - sample.tar.aa/.ab    : la même archive coupée en deux (test du streaming)
  - expected.json        : les positions attendues (référence)

Usage :
    python3 docs/tools/make_test_fixture.py
"""

import json
import os
import struct
import tarfile
import io
import datetime

MARKER = 243235997
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")

AIRCRAFT = [
    # hex, callsign, squawk, type_code, positions (lat, lon, alt_ft, gs_kt, t_offset_s)
    (
        0x0A0001,
        "SZN204",
        7421,
        0,
        [
            (14.67, -17.07, 0, 4, 0),
            (14.70, -17.20, 2500, 180, 60),
            (14.78, -17.42, 12000, 320, 120),
            (15.10, -17.85, 34000, 450, 180),
            (15.60, -18.40, 36000, 455, 240),
        ],
    ),
    (
        0x0A0002,
        "GTS77",
        1200,
        0,
        [
            (13.34, -16.65, 0, 0, 30),
            (13.40, -16.80, 5000, 240, 90),
            (13.50, -17.00, 18000, 330, 150),
        ],
    ),
    (
        0x3C1234,
        None,
        7000,
        0,
        [
            (16.74, -22.95, 37000, 480, 10),
            (17.20, -22.10, 37000, 480, 70),
        ],
    ),
]

BASE_TIME = datetime.datetime(2026, 10, 28, 6, 0, 0, tzinfo=datetime.timezone.utc).timestamp()


def s32(v):
    """Convertit un entier non signé 32 bits en int32 signé."""
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v > 0x7FFFFFFF else v


def encode_time(t):
    high = int(t // 4294967.296)
    low = int(round((t - high * 4294967.296) * 1000))
    return high, low


def build_heatmap_file(aircraft_list):
    words = []
    expected = []
    for hexcode, callsign, squawk, type_code, positions in aircraft_list:
        hex_field = (type_code << 27) | (hexcode & 0xFFFFFF)
        first_offset = positions[0][4]
        high, low = encode_time(BASE_TIME + first_offset)

        # bloc de métadonnées (callsign + squawk), une fois par aéronef
        words += [MARKER, high, low, hex_field]
        meta_flag = 0x40000000 | (squawk & 0xFFFF)
        cs = (callsign or "").encode("ascii")[:8].ljust(8, b"\0")
        cs_words = list(struct.unpack("<ii", cs))
        words += [hex_field, meta_flag, cs_words[0], cs_words[1]]

        # un bloc horodaté par position, comme dans les fichiers tar1090
        for lat, lon, alt, gs, offset in positions:
            high, low = encode_time(BASE_TIME + offset)
            alt_field = 0 if alt == 0 else int(alt / 25)
            gs_field = -1 if gs is None else int(round(gs * 10))
            packed = ((gs_field & 0xFFFF) << 16) | (alt_field & 0xFFFF)
            words += [
                MARKER, high, low, hex_field,
                hex_field,
                int(round(lat * 1e6)),
                int(round(lon * 1e6)),
                packed,
            ]
            expected.append(
                {
                    "t": BASE_TIME + offset,
                    "hex": f"{hexcode:06x}",
                    "flight": callsign,
                    "lat": round(lat, 5),
                    "lon": round(lon, 5),
                    "alt": alt,
                    "gs": gs,
                }
            )
    words = [s32(w) for w in words]
    return struct.pack(f"<{len(words)}i", *words), expected


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    half = len(AIRCRAFT) // 2 + 1
    files = {
        "v2026.10.28-planes-readsb-prod-0/heatmap/2026-10-28/0": build_heatmap_file(AIRCRAFT[:half]),
        "v2026.10.28-planes-readsb-prod-0/heatmap/2026-10-28/1": build_heatmap_file(AIRCRAFT[half:]),
        "v2026.10.28-planes-readsb-prod-0/heatmap/2026-10-28/README.txt": (b"fichier ignore", []),
        "v2026.10.28-planes-readsb-prod-0/traces/0a0001.json": (b'{"ignored":true}', []),
    }

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, (data, _) in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = int(BASE_TIME)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    archive = buf.getvalue()

    with open(os.path.join(OUT_DIR, "sample.tar"), "wb") as fh:
        fh.write(archive)

    # archive coupée en deux morceaux (comme .tar.aa / .tar.ab)
    cut = len(archive) // 2 + 1234
    with open(os.path.join(OUT_DIR, "sample.tar.aa"), "wb") as fh:
        fh.write(archive[:cut])
    with open(os.path.join(OUT_DIR, "sample.tar.ab"), "wb") as fh:
        fh.write(archive[cut:])

    expected = []
    for _, (_, rows) in files.items():
        expected.extend(rows)
    expected.sort(key=lambda r: r["t"])
    with open(os.path.join(OUT_DIR, "expected.json"), "w", encoding="utf-8") as fh:
        json.dump({"points": expected}, fh, indent=1)

    with open(os.path.join(OUT_DIR, "sample.csv"), "w", encoding="utf-8") as fh:
        fh.write("time,icao24,callsign,lat,lon,altitude,velocity,track,registration,type\n")
        for row in expected:
            fh.write(
                f"{datetime.datetime.fromtimestamp(row['t'], datetime.timezone.utc).isoformat()},"
                f"{row['hex']},{row['flight'] or ''},{row['lat']},{row['lon']},"
                f"{row['alt']},{row['gs']},{120},{'6V-AAA'},{'A320'}\n"
            )

    print(f"{len(expected)} positions attendues · {len(archive)} octets d'archive")


if __name__ == "__main__":
    main()
