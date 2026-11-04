#!/usr/bin/env python3
"""
Génère le jeu de données de démonstration de Turnstone Lite.

ATTENTION : ces données sont SIMULÉES (pas de vrais relevés ADS-B). Elles imitent
cependant la structure exacte des données Turnstone / tar1090 et un trafic
plausible autour du Sénégal et de l'Afrique de l'Ouest, avec des survols
long-courriers Europe / Afrique / Amérique du Sud.

Usage :
    python3 lite/tools/make_demo_data.py > lite/data/demo.json
"""

import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone

random.seed(20261028)

DAY_START = datetime(2026, 10, 28, 0, 0, tzinfo=timezone.utc)

# --- Aéroports (lat, lon, nom) -------------------------------------------------
AIRPORTS = {
    "DSS": (14.6708, -17.0733, "Dakar Blaise Diagne"),
    "DKR": (14.7397, -17.4902, "Dakar Yoff"),
    "BJL": (13.3379, -16.6522, "Banjul"),
    "OXB": (11.8948, -15.6537, "Bissau"),
    "CKY": (9.5769, -13.6120, "Conakry"),
    "FNA": (8.6164, -13.1955, "Freetown"),
    "BKO": (12.5335, -7.9499, "Bamako"),
    "NKC": (18.0982, -15.9485, "Nouakchott"),
    "SID": (16.7414, -22.9494, "Sal"),
    "RAI": (14.9245, -23.4935, "Praia"),
    "ABJ": (5.2614, -3.9261, "Abidjan"),
    "ACC": (5.6052, -0.1668, "Accra"),
    "LOS": (6.5774, 3.3212, "Lagos"),
    "CMN": (33.3675, -7.5898, "Casablanca"),
    "CDG": (49.0097, 2.5479, "Paris Charles-de-Gaulle"),
    "MAD": (40.4936, -3.5668, "Madrid"),
    "LIS": (38.7742, -9.1342, "Lisbonne"),
    "BRU": (50.9014, 4.4844, "Bruxelles"),
    "IST": (41.2753, 28.7519, "Istanbul"),
    "DXB": (25.2532, 55.3657, "Dubaï"),
    "DOH": (25.2731, 51.6081, "Doha"),
    "JNB": (-26.1392, 28.2460, "Johannesburg"),
    "ADD": (8.9779, 38.7993, "Addis-Abeba"),
    "NBO": (-1.3192, 36.9278, "Nairobi"),
    "TUN": (36.8510, 10.2272, "Tunis"),
    "ALG": (36.6910, 3.2154, "Alger"),
    "CAI": (30.1219, 31.4056, "Le Caire"),
    "SSA": (-12.9086, -38.3225, "Salvador"),
    "REC": (-8.1264, -34.9236, "Recife"),
    "GRU": (-23.4356, -46.4731, "São Paulo"),
    "JFK": (40.6413, -73.7781, "New York JFK"),
    "MIA": (25.7959, -80.2870, "Miami"),
}

# --- Types d'aéronefs ----------------------------------------------------------
TYPES = {
    "A319": ("Airliner", 440, 340, "Airbus A319"),
    "A320": ("Airliner", 445, 350, "Airbus A320"),
    "A321": ("Airliner", 450, 350, "Airbus A321"),
    "A20N": ("Airliner", 450, 360, "Airbus A320neo"),
    "A333": ("Airliner", 470, 370, "Airbus A330-300"),
    "A339": ("Airliner", 470, 380, "Airbus A330-900"),
    "A359": ("Airliner", 480, 390, "Airbus A350-900"),
    "A388": ("Airliner", 490, 400, "Airbus A380-800"),
    "B738": ("Airliner", 445, 360, "Boeing 737-800"),
    "B38M": ("Airliner", 450, 370, "Boeing 737 MAX 8"),
    "B788": ("Airliner", 480, 380, "Boeing 787-8"),
    "B789": ("Airliner", 485, 390, "Boeing 787-9"),
    "B77W": ("Airliner", 490, 390, "Boeing 777-300ER"),
    "B763": ("Airliner", 460, 360, "Boeing 767-300"),
    "BCS3": ("Airliner", 430, 340, "Airbus A220-300"),
    "AT72": ("Airliner", 270, 200, "ATR 72-600"),
    "DH8D": ("Airliner", 290, 240, "De Havilland Dash 8-400"),
    "E190": ("Airliner", 430, 350, "Embraer 190"),
    "CRJ9": ("Airliner", 430, 340, "Bombardier CRJ-900"),
    "B77L": ("Cargo", 480, 380, "Boeing 777F"),
    "B744": ("Cargo", 480, 370, "Boeing 747-400F"),
    "B752": ("Cargo", 450, 370, "Boeing 757-200F"),
    "C130": ("Military", 290, 240, "Lockheed C-130H Hercules"),
    "A400": ("Military", 330, 300, "Airbus A400M"),
    "C17": ("Military", 430, 320, "Boeing C-17 Globemaster III"),
    "P8": ("Military", 440, 340, "Boeing P-8 Poseidon"),
    "K35R": ("Military", 450, 300, "Boeing KC-135"),
    "C25A": ("Business jet", 400, 400, "Cessna Citation CJ2"),
    "GLF6": ("Business jet", 470, 430, "Gulfstream G650"),
    "E55P": ("Business jet", 400, 410, "Embraer Phenom 300"),
    "C172": ("General Aviation", 115, 90, "Cessna 172 Skyhawk"),
    "P28A": ("General Aviation", 120, 85, "Piper PA-28"),
    "SR22": ("General Aviation", 170, 130, "Cirrus SR22"),
    "BE20": ("General Aviation", 250, 240, "Beechcraft King Air 200"),
    "C208": ("General Aviation", 140, 120, "Cessna 208 Caravan"),
    "R44": ("Helicopter", 100, 60, "Robinson R44"),
    "H125": ("Helicopter", 110, 70, "Airbus H125"),
    "M28": ("Military", 200, 180, "PZL M28 Skytruck"),
    "UAV": ("UAV", 95, 120, "Drone tactique"),
}

# --- Compagnies : (code OACI, pays immat, typecodes, routes) -------------------
AIRLINES = {
    "SZN": ("Sénégal", ["A319", "A20N", "A333"], ["DSS", "BJL", "CKY", "ABJ", "CMN", "CDG", "MAD", "DXB", "JFK", "LIS"]),
    "AFR": ("France", ["A359", "B77W", "A320"], ["CDG", "DSS", "ABJ", "LOS", "CMN", "JFK", "CAI"]),
    "RAM": ("Maroc", ["B738", "B788", "A320"], ["CMN", "DSS", "ABJ", "ACC", "BKO", "CDG", "MAD", "DXB"]),
    "ETH": ("Éthiopie", ["B788", "B789", "A359"], ["ADD", "DSS", "ABJ", "LOS", "JNB", "NBO", "DXB"]),
    "THY": ("Turquie", ["A333", "B789", "A321"], ["IST", "DSS", "ABJ", "CMN", "JNB", "DXB"]),
    "UAE": ("Émirats", ["A388", "B77W"], ["DXB", "DSS", "ABJ", "GRU", "JNB"]),
    "QTR": ("Qatar", ["B788", "A359"], ["DOH", "DSS", "ABJ", "ACC", "JNB", "MIA"]),
    "TAP": ("Portugal", ["A320", "A339"], ["LIS", "DSS", "ABJ", "RAI", "SSA", "REC"]),
    "IBE": ("Espagne", ["A320", "A333"], ["MAD", "DSS", "ABJ", "CMN"]),
    "BAW": ("Royaume-Uni", ["B77W", "B788"], ["CDG", "DSS", "ABJ", "JNB"]),
    "DAL": ("États-Unis", ["A333", "B763"], ["JFK", "DSS", "ABJ", "ACC"]),
    "UAL": ("États-Unis", ["B788"], ["JFK", "MIA", "DSS", "ABJ"]),
    "KQA": ("Kenya", ["B738", "E190"], ["NBO", "DSS", "ABJ", "ACC"]),
    "SKX": ("Togo", ["B738"], ["DSS", "BJL", "OXB", "CKY", "FNA", "BKO", "ABJ", "ACC", "LOS", "NKC"]),
    "VRE": ("Côte d'Ivoire", ["A319", "DH8D"], ["ABJ", "DSS", "BKO", "CKY", "ACC", "LOS"]),
    "CVA": ("Cap-Vert", ["AT72", "BCS3"], ["RAI", "SID", "DSS", "BJL", "OXB", "LIS"]),
    "MTL": ("Mauritanie", ["B738", "E190"], ["NKC", "DSS", "ABJ", "CMN"]),
    "GTS": ("Sénégal", ["AT72", "DH8D"], ["DSS", "SID", "RAI", "BJL", "OXB", "CKY", "BKO", "NKC"]),
    "CRL": ("France", ["A339"], ["CDG", "DSS", "ABJ", "MAD"]),
    "MSR": ("Égypte", ["B738", "A320"], ["CAI", "DSS", "ABJ", "CMN"]),
    "TAR": ("Tunisie", ["A320"], ["TUN", "DSS", "ABJ", "CMN"]),
    "DAH": ("Algérie", ["B738"], ["ALG", "DSS", "BKO", "NKC"]),
    "KLM": ("Pays-Bas", ["B77W", "A333"], ["CDG", "DSS", "ABJ", "ACC", "JNB"]),
    "DLH": ("Allemagne", ["A359"], ["CDG", "BRU", "DSS", "JNB"]),
    "SVA": ("Arabie saoudite", ["B789"], ["DXB", "DSS", "JFK"]),
    "FDX": ("États-Unis", ["B77L", "B752"], ["CDG", "DSS", "LOS", "JNB", "DXB"]),
    "BCS": ("Allemagne", ["B752", "B744"], ["CDG", "DSS", "ABJ", "LOS"]),
}

# Préfixe d'immatriculation et base hexadécimale plausible par pays
COUNTRY_META = {
    "Sénégal": ("6V-", 0x0A0000),
    "France": ("F-G", 0x3C0000),
    "Maroc": ("CN-R", 0x020000),
    "Éthiopie": ("ET-A", 0x040000),
    "Turquie": ("TC-J", 0x4B8000),
    "Émirats": ("A6-E", 0x896000),
    "Qatar": ("A7-B", 0x06A000),
    "Portugal": ("CS-T", 0x495000),
    "Espagne": ("EC-M", 0x340000),
    "Royaume-Uni": ("G-", 0x400000),
    "États-Unis": ("N", 0xA00000),
    "Kenya": ("5Y-K", 0x04C000),
    "Togo": ("5V-T", 0x03A000),
    "Côte d'Ivoire": ("TU-T", 0x038000),
    "Cap-Vert": ("D4-C", 0x096000),
    "Mauritanie": ("5T-C", 0x0A4000),
    "Égypte": ("SU-G", 0x010000),
    "Tunisie": ("TS-IM", 0x028000),
    "Algérie": ("7T-V", 0x0A6000),
    "Pays-Bas": ("PH-B", 0x480000),
    "Allemagne": ("D-AI", 0x3C8000),
    "Arabie saoudite": ("HZ-A", 0x710000),
}

REG_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"


def great_circle(lat1, lon1, lat2, lon2, f):
    """Interpolation sphérique (slerp) entre deux points."""
    p1, l1 = math.radians(lat1), math.radians(lon1)
    p2, l2 = math.radians(lat2), math.radians(lon2)
    d = 2 * math.asin(
        math.sqrt(
            math.sin((p2 - p1) / 2) ** 2
            + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2
        )
    )
    if d == 0:
        return lat1, lon1
    a = math.sin((1 - f) * d) / math.sin(d)
    b = math.sin(f * d) / math.sin(d)
    x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
    y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
    z = a * math.sin(p1) + b * math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def make_registration(country, typecode):
    prefix = COUNTRY_META[country][0]
    tail = "".join(random.choice(REG_LETTERS) for _ in range(3))
    if prefix == "N":
        return f"N{random.randint(100, 999)}{tail[:2]}"
    if prefix in ("G-", "F-G"):
        return f"{prefix}{tail}"
    return f"{prefix}{tail}"


def make_hex(country):
    base = COUNTRY_META[country][1]
    return f"{(base + random.randint(0, 0x2FFF)) & 0xFFFFFF:06x}"


def vertical_profile(f, climb_frac, descent_frac):
    """Altitude en pieds et vitesse en noeuds le long du vol."""
    if f < climb_frac:
        x = f / climb_frac
        return x ** 0.75, 0.35 + 0.65 * x
    if f > 1 - descent_frac:
        x = (1 - f) / descent_frac
        return x ** 0.8, 0.30 + 0.70 * x
    return 1.0, 1.0


def jitter(scale=0.008):
    return random.uniform(-scale, scale)


def build_flight(flight_no, airline, country, typecode, dep, arr, dep_time, step=60,
                 lateral=0.0, cruise_bonus=0.0, hex=None, reg=None, mil=False):
    info = TYPES[typecode]
    cat, kt, fl, _ = info
    if mil:
        cat = "Military"
    lat1, lon1, _ = AIRPORTS[dep]
    lat2, lon2, _ = AIRPORTS[arr]
    dist = haversine_km(lat1, lon1, lat2, lon2)
    cruise_gs = kt + random.uniform(-8, 8)
    # distance parcourue pendant la montée/descente ~ 40% du trajet sur les vols courts
    climb_frac = min(0.18, 35 / max(dist, 1) * 0.18 * 6)
    descent_frac = min(0.16, 30 / max(dist, 1) * 0.16 * 6)
    climb_frac = max(0.05, min(climb_frac, 0.35))
    descent_frac = max(0.05, min(descent_frac, 0.30))
    duration_h = dist / cruise_gs * (1.12 if dist < 900 else 1.04)
    duration_s = duration_h * 3600
    alt_cruise = int(fl * 100 + random.choice([0, 0, 0, 1000, -1000]) + cruise_bonus)
    alt_cruise = max(8000, min(alt_cruise, 43000))

    hexcode = hex or make_hex(country)
    regcode = reg or make_registration(country, typecode)

    rows = []
    t = dep_time
    end = dep_time + timedelta(seconds=duration_s)
    prev = None
    while t <= end:
        f = min(1.0, max(0.0, (t - dep_time).total_seconds() / duration_s))
        w, speed_factor = vertical_profile(f, climb_frac, descent_frac)
        lat, lon = great_circle(lat1, lon1, lat2, lon2, f)
        if lateral:
            # écart latéral le long de la route (couloirs aériens)
            lat += lateral * math.sin(f * math.pi * 2.0) * (0.4 + 0.6 * math.sin(f * math.pi))
            lon += lateral * 0.6 * math.cos(f * math.pi * 1.5) * (0.4 + 0.6 * math.sin(f * math.pi))
        if 0.02 < f < 0.98:
            lat += jitter()
            lon += jitter()
        alt = int(alt_cruise * w) if w < 1 else alt_cruise
        alt = max(0, alt)
        gs = round(cruise_gs * speed_factor, 1)
        brg = 0.0
        if prev:
            brg = round(bearing_deg(prev[0], prev[1], lat, lon), 1)
        rows.append(
            dict(
                t=int(t.timestamp()),
                hex=hexcode,
                flight=flight_no,
                lat=round(lat, 5),
                lon=round(lon, 5),
                alt=alt,
                gs=gs,
                bearing=brg,
                reg=regcode,
                type=typecode,
                cat=cat,
                mil=mil,
            )
        )
        prev = (lat, lon)
        t += timedelta(seconds=step)
    return rows


def build_local_pattern(flight_no, country, typecode, origin, start, minutes, radius_km=12,
                        alt_max=4500, hexcode=None, regcode=None, mil=False, step=45):
    """Vol local : tours d'aérodrome / patrouille."""
    cat = "Military" if mil else TYPES[typecode][0]
    lat0, lon0, _ = AIRPORTS[origin]
    hexcode = hexcode or make_hex(country)
    regcode = regcode or make_registration(country, typecode)
    rows = []
    t = start
    total = minutes * 60
    prev = None
    phase = random.uniform(0, 6.28)
    for s in range(0, total, step):
        ang = phase + s / total * 6.28 * random.uniform(2.5, 3.5)
        r = radius_km * (0.55 + 0.45 * math.sin(s / total * 3.14))
        lat = lat0 + (r / 111.0) * math.cos(ang)
        lon = lon0 + (r / (111.0 * math.cos(math.radians(lat0)))) * math.sin(ang)
        alt = int(alt_max * (0.45 + 0.55 * abs(math.sin(s / total * 3.14))))
        gs = round(TYPES[typecode][1] * random.uniform(0.85, 1.0), 1)
        brg = 0.0 if not prev else round(bearing_deg(prev[0], prev[1], lat, lon), 1)
        rows.append(dict(t=int((t).timestamp()), hex=hexcode, flight=flight_no,
                         lat=round(lat, 5), lon=round(lon, 5), alt=alt, gs=gs,
                         bearing=brg, reg=regcode, type=typecode, cat=cat, mil=mil))
        prev = (lat, lon)
        t += timedelta(seconds=step)
    return rows


def build_grid_survey(flight_no, country, typecode, start, hexcode=None, regcode=None, step=60):
    """Avion de relevé (photogrammétrie) : serpentin au-dessus de Dakar."""
    lat0, lon0 = 14.72, -17.20
    hexcode = hexcode or make_hex(country)
    regcode = regcode or make_registration(country, typecode)
    rows = []
    t = start
    prev = None
    legs = 7
    for leg in range(legs):
        lon_a = lon0 - 0.28
        lon_b = lon0 + 0.28
        if leg % 2:
            lon_a, lon_b = lon_b, lon_a
        lat = lat0 + leg * 0.035
        n = 22
        for k in range(n + 1):
            lon = lon_a + (lon_b - lon_a) * k / n
            brg = 0.0 if not prev else round(bearing_deg(prev[0], prev[1], lat, lon), 1)
            rows.append(dict(t=int(t.timestamp()), hex=hexcode, flight=flight_no,
                             lat=round(lat, 5), lon=round(lon, 5), alt=1750, gs=132.0,
                             bearing=brg, reg=regcode, type=typecode,
                             cat=TYPES[typecode][0], mil=False))
            prev = (lat, lon)
            t += timedelta(seconds=step)
    return rows


DAYS = 3  # nombre de jours simulés


def build_day_rows(day_start, step_scale=1.0, seed=20261028):
    """Construit un jour de trafic simulé."""
    random.seed(seed)
    rows = []
    used = set()

    def unique_flight(prefix):
        while True:
            n = random.randint(100, 9899)
            code = f"{prefix}{n if n > 999 else n:03d}"
            if code not in used:
                used.add(code)
                return code

    # 1. Vols réguliers
    n_flights = 0
    for airline, (country, fleet, routes) in AIRLINES.items():
        nb = {"SZN": 9, "GTS": 8, "CVA": 6, "SKX": 6, "VRE": 5}.get(airline, 4)
        for _ in range(nb):
            dep, arr = random.sample(routes, 2)
            typecode = random.choice(fleet)
            dep_time = day_start + timedelta(minutes=random.uniform(0, 1439))
            step = int(random.choice([60, 60, 60, 45, 90]) * step_scale)
            rows.extend(
                build_flight(
                    unique_flight(airline), airline, country, typecode, dep, arr,
                    dep_time, step=step, lateral=random.uniform(0, 0.35),
                )
            )
            n_flights += 1

    # 2. Aviation d'affaires
    for _ in range(9):
        route = random.choice([
            ("DSS", "CMN"), ("DSS", "CDG"), ("DSS", "ABJ"), ("DSS", "LIS"),
            ("BJL", "DSS"), ("DSS", "SID"), ("CMN", "ABJ"), ("DSS", "MAD"),
        ])
        rows.extend(
            build_flight(
                flight_no=unique_flight(random.choice(["FJO", "EJO", "GJE"])),
                airline="Sénégal",
                country="Sénégal",
                typecode=random.choice(["C25A", "GLF6", "E55P"]),
                dep=route[0],
                arr=route[1],
                dep_time=day_start + timedelta(minutes=random.uniform(300, 1200)),
                step=90,
            )
        )

    # 3. Aviation générale autour de Dakar
    for _ in range(7):
        rows.extend(build_local_pattern(unique_flight("HB"), "Sénégal",
                                        random.choice(["C172", "P28A", "SR22", "BE20"]),
                                        random.choice(["DKR", "DSS"]),
                                        day_start + timedelta(minutes=random.uniform(420, 1080)),
                                        random.randint(35, 110),
                                        radius_km=random.uniform(8, 45),
                                        alt_max=random.randint(1800, 9500),
                                        step=int(45 * step_scale)))

    # 4. Hélicoptères
    for _ in range(3):
        rows.extend(build_local_pattern(unique_flight("HEL"), "Sénégal",
                                        random.choice(["R44", "H125"]), "DKR",
                                        day_start + timedelta(minutes=random.uniform(480, 1020)),
                                        random.randint(25, 60), radius_km=18, alt_max=2200,
                                        step=int(60 * step_scale)))

    # 5. Militaires
    mil_specs = [
        ("C130", "DSS", 260, 32, 9500),
        ("A400", "DSS", 380, 45, 16000),
        ("C17", "DSS", 610, 40, 19000),
        ("P8", "DSS", 520, 55, 12000),
    ]
    for typecode, origin, start_min, minutes, alt in mil_specs:
        rows.extend(build_local_pattern(unique_flight("CTM"), "France", typecode, origin,
                                        day_start + timedelta(minutes=start_min),
                                        minutes, radius_km=random.uniform(30, 120),
                                        alt_max=alt, mil=True, step=int(60 * step_scale)))
    # patrouille sénégalaise + drone
    rows.extend(build_local_pattern("SEN01", "Sénégal", "M28", "DSS",
                                    day_start + timedelta(minutes=520), 70,
                                    radius_km=65, alt_max=7000, mil=True,
                                    step=int(60 * step_scale)))
    rows.extend(build_local_pattern("SEN02", "Sénégal", "UAV", "DSS",
                                    day_start + timedelta(minutes=610), 95,
                                    radius_km=85, alt_max=11000, mil=True,
                                    step=int(60 * step_scale)))

    # 6. Avion de relevé
    rows.extend(build_grid_survey("HB-SUR", "Sénégal", "C208",
                                  day_start + timedelta(minutes=450)))

    # 7. Trafic non-ICAO (TIS-B), hex précédés de "~"
    for _ in range(3):
        rows.extend(build_local_pattern(unique_flight("TIS"), "Sénégal",
                                        random.choice(["C172", "C208"]),
                                        random.choice(["DKR", "DSS"]),
                                        day_start + timedelta(minutes=random.uniform(500, 1000)),
                                        random.randint(20, 50), radius_km=25,
                                        alt_max=3200, step=int(75 * step_scale)))

    # Ne garder que la journée demandée (les vols qui débordent sont tronqués)
    day_end = day_start + timedelta(days=1)
    rows = [r for r in rows if r["t"] < day_end.timestamp()]
    return rows


def main():
    rows = []
    for day_index in range(DAYS):
        rows.extend(
            build_day_rows(
                DAY_START + timedelta(days=day_index),
                step_scale=1.0 if day_index == 0 else 2.0,
                seed=20261028 + day_index,
            )
        )
    rows.sort(key=lambda r: r["t"])

    # Dictionnaires
    dicts = {k: [] for k in ("hex", "flight", "reg", "type", "cat")}
    index = {k: {} for k in dicts}
    out_rows = []
    for r in rows:
        ids = []
        for k in dicts:
            v = r[k]
            if v not in index[k]:
                index[k][v] = len(dicts[k])
                dicts[k].append(v)
            ids.append(index[k][v])
        out_rows.append([
            r["t"], ids[0], ids[1], r["lat"], r["lon"], r["alt"], r["gs"],
            r["bearing"], ids[2], ids[3], ids[4], 1 if r["mil"] else 0,
        ])

    for i in range(0, len(dicts["hex"])):
        if random.random() < 0.03:
            dicts["hex"][i] = "~" + dicts["hex"][i]

    payload = {
        "meta": {
            "name": f"Démonstration — Dakar & Afrique de l'Ouest ({DAYS} jours)",
            "source": "demo",
            "synthetic": True,
            "day": DAY_START.strftime("%Y-%m-%d"),
            "days": DAYS,
            "note": "Données simulées à des fins de démonstration de l'interface.",
        },
        "dict": dicts,
        "rows": out_rows,
    }

    json.dump(payload, sys.stdout, separators=(",", ":"), ensure_ascii=False)
    sys.stderr.write(
        f"{len(out_rows)} positions, {len(set(r['hex'] for r in rows))} aéronefs, "
        f"{DAYS} jours\n"
    )


if __name__ == "__main__":
    main()
