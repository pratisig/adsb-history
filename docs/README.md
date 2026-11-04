# Turnstone Lite — historique de vols ADS-B, sans installation

> Ce dossier **est** le site : il est publié par GitHub Pages
> (*Settings → Pages → branch `main`, folder `/docs`*) à l'adresse
> <https://pratisig.github.io/adsb-history/>.

**Turnstone Lite** est une version allégée de [Turnstone](https://github.com/bellingcat/adsb-history)
qui tourne **entirement dans le navigateur** : pas de PostgreSQL/PostGIS, pas d'API Flask,
pas de Firebase, pas de `npm install`, pas de compte, pas de clé API.

Vous ouvrez une page, vous déposez une archive ADS-B, vous dessinez une zone sur la carte et
vous explorez les vols — puis vous exportez les résultats en CSV.

---

## 1. Démarrer en 10 secondes

### Option A — hébergement statique (recommandé)

Ce dossier n'est fait que de fichiers statiques : il peut être publié tel quel sur GitHub
Pages (c'est déjà le cas), Netlify, Vercel, Cloudflare Pages, un simple bucket S3… (voir §6).

### Option B — en local, sans rien installer

Un serveur de fichiers suffit (Python est déjà présent sur macOS/Linux) :

```bash
# depuis la racine du dépôt
python3 -m http.server 8000 --directory docs
```

Puis ouvrez <http://localhost:8000>. Sur Windows : `py -m http.server 8000 --directory docs`.

> Pourquoi un serveur ? Les modules JavaScript et le fichier `data/demo.json` ne se chargent pas
> via `file://`. Aucune dépendance à installer, aucun backend : c'est juste un serveur de fichiers.

---

## 2. Ce que vous voyez au premier lancement

Un jeu de données **de démonstration** de **3 jours** (28 → 30/10/2026, Dakar et Afrique de
l'Ouest, plus quelques survols long-courriers) est livré avec l'application : 100 000 positions,
450 aéronefs, explorable immédiatement.

⚠️ Ces données de démonstration sont **simulées** (elles imitent un trafic plausible et le
format exact de Turnstone, mais ne proviennent pas de vrais relevés). Le badge `démo simulée`
le rappelle. Importez vos propres données pour travailler sur du réel.

La fenêtre temporelle de l'outil n'est **pas** limitée à 24 h : la période proposée s'étend
toujours sur toute la couverture du jeu de données chargé (« Tout »). La démo ne fait que 3
jours parce qu'elle est simulée ; vos imports réels peuvent couvrir plusieurs semaines (§3.3).

---

## 2 bis. Voir les données réelles tout de suite (sans archive)

Carte **« 5 · Données réelles »**. Elle s'ouvre **d'elle-même au chargement** : la carte, le
résumé, les tableaux et les exports travaillent alors sur du trafic réel (la démonstration
simulée reste disponible dans la liste des jeux de données).

### a) Le relevé automatique (source fiable)

Un **workflow GitHub Actions** (`.github/workflows/live-snapshot.yml`) interroge les API ADS-B
publiques depuis un runner — donc hors navigateur — pour les zones de
`docs/data/live-zones.json` (Dakar, Saint-Louis, Ziguinchor, Paris, Montréal) :

- une relève **toutes les 30 s**, fenêtre glissante de **3 heures**, cascade `adsb.lol` →
  `adsb.fi` → `OpenSky` ;
- publication du résultat sur la branche `live` (JSON compact, ≈ 100 Ko par zone) ;
- après chaque modification du dépôt, **3 passes de 8 minutes** (≈ 24 min de relevé continu,
  publication après chaque passe) ; en exécution planifiée, une passe de 8 minutes.

Dans la carte : choisissez la **zone** et la **fenêtre** (30 min, 1 h, 3 h ou tout le relevé),
puis **Afficher sur la carte** (dernière position + traînée) ou **Explorer l'historique réel**
(le relevé devient un jeu de données interrogeable : filtres, timeline, tableaux, export CSV).

> **Pour rafraîchir** : le lien *« demander une mise à jour »* ouvre la page du workflow — le
> bouton **Run workflow** lance un nouveau relevé. Pour un rafraîchissement **automatique toutes
> les 10 minutes**, autorisez une fois les workflows planifiés : onglet **Actions** du dépôt →
> *I have read and I understand my workflows, go ahead and enable them* (GitHub désactive les
> tâches planifiées des forks par défaut). Sans cette autorisation, le relevé se met à jour à
> chaque modification du dépôt et la page indique l'âge du dernier relevé.

### b) Le direct depuis le navigateur (facultatif)

**Aucune** API ADS-B publique n'envoie d'en-tête `Access-Control-Allow-Origin` : `api.adsb.lol`,
`opendata.adsb.fi`, `api.airplanes.live` (vérifié : 200 sans en-tête CORS) **et**
`opensky-network.org` (essayé depuis un navigateur : bloqué). Un navigateur ne peut donc pas lire
ces réponses, quel que soit le réseau — ce n'est pas un problème de DNS ni de bloqueur.

Le mode direct ne peut fonctionner que via un **relais CORS** (proxy qui ajoute l'en-tête). Trois
relais publics sont essayés automatiquement — `api.allorigins.win`, `api.codetabs.com`,
`r.jina.ai` — et celui qui répond est mémorisé pour les relèves suivantes. Ces relais sont
gratuits, parfois lents ou limités : à considérer comme un bonus, pas comme la source principale.
Le champ *« Relais personnalisé »* accepte votre propre relais (`https://mon-relais/{url}`).

Rayon 10 à 250 NM, relève toutes les 1 à 15 min, bouton **Actualiser** pour une relève unique.
Cochez *« Enregistrer pour l'historique »* pour accumuler les positions reçues (1 point / 10 s et
par aéronef) puis *« Ouvrir l'historique enregistré »* pour l'interroger comme un jeu de données.
L'onglet en arrière-plan met la relève en pause.

---

## 3. Importer de vraies données ADS-B

### 3.0 D'où viennent les données ?

Le site n'embarque aucune donnée d'exemple réelle : il affiche le **relevé automatique** du dépôt
(voir §2 bis) et, pour aller plus loin, ce que vous y chargez. Sources possibles :

| Source | Ce que vous obtenez | Poids | Comment l'importer |
| --- | --- | --- | --- |
| **Relevé automatique** (workflow du dépôt) | les dernières heures de trafic autour des zones suivies | ≈ 100 Ko | automatique — carte « 5 · Données réelles » |
| **[Archives adsb.lol](https://github.com/adsblol/globe_history_2025/releases)** | toutes les positions ADS-B mondiales, **1 jour par archive** | ≈ 3 Go / jour (`.tar.aa` + `.tar.ab`) | glisser-déposer **ou** coller l'URL de téléchargement |
| **CSV** (export OpenSky, dump1090/tar1090, votre récepteur, relevé perso) | les positions que vous avez | quelques Ko → centaines de Mo | glisser-déposer |
| **Turnstone complet** (PostgreSQL/PostGIS) | des mois, voire des années | — | hors navigateur (voir le README principal) |

**Pour démarrer sans télécharger 3 Go**, le plus simple est un CSV : un export OpenSky pour un
aéronef et une journée pèse quelques centaines de Ko et s'importe en une seconde.

**Recommandation pour une première archive adsb.lol** : prenez une seule journée, sélectionnez
la zone *« zone visible de la carte »* (par exemple le Sénégal) et gardez 1 point/minute →
quelques dizaines de milliers de positions seulement, import en une à deux minutes.

### 3.1 Archives `globe_history` (recommandé)

Les données historiques mondiales au format tar1090 sont publiées chaque jour par adsb.lol :

- <https://github.com/adsblol/globe_history_2025/releases>

Pour une journée, téléchargez les fichiers `.tar.aa`, `.tar.ab`, … (archive découpée,
~3 Go au total), **sans les extraire**, puis :

1. cliquez sur **Importer des données** ;
2. glissez les morceaux (ou le `.tar` entier) dans la fenêtre — sélectionnez **tous** les
   morceaux d'une même journée, ils sont recollés automatiquement ;
3. choisissez la **zone** (« zone visible de la carte » pour ne garder que votre région) et
   l'**échantillonnage** (1 point/minute, comme Turnstone) ;
4. lancez l'import.

L'archive est lue **en flux** dans un Web Worker : rien n'est uploadé, et un fichier de
plusieurs gigaoctets n'est jamais chargé d'un coup en mémoire.

Alternative : collez l'**URL directe** de l'archive dans le champ « importer depuis une URL »
de la fenêtre d'import — le fichier est téléchargé et décodé en flux, sans passer par le disque.
Certains serveurs (dont parfois GitHub) refusent le téléchargement direct depuis un navigateur
pour des raisons de CORS : dans ce cas le message vous invite à télécharger le fichier
manuellement.

**Conseils de volume** : une journée mondiale complète représente plusieurs dizaines de
millions de positions — trop pour un navigateur. Limitez la zone (un pays, une FIR) et gardez
1 point/minute : vous obtenez quelques dizaines de milliers de positions, très confortables.
Utilisez la limite de positions pour être averti avant de saturer la mémoire.

### 3.2 Importer plusieurs jours (cumul)

Un import = un **jeu de données**. Pour couvrir plusieurs jours, importez-les à la suite en
choisissant, dans la fenêtre d'import, la destination **« Ajouter au jeu de données actif »** :
le nouvel extrait est fusionné dans le jeu courant (les positions, la couverture temporelle et
la liste des aéronefs s'additionnent), et le tout est ré-enregistré localement.

Vous pouvez aussi sélectionner **plusieurs archives d'un coup** (jours différents, ou morceaux
`aa/ab/ac…` d'une même journée) : elles sont lues à la suite dans le même flux.

### 3.3 CSV

N'importe quel CSV contenant au minimum `lat`/`latitude` et `lon`/`longitude` est accepté.
Les colonnes reconnues (alias multiples) : `t`/`time`/`timestamp`, `hex`/`icao24`,
`flight`/`callsign`, `alt`/`altitude`, `gs`/`speed`/`velocity`, `track`/`bearing`,
`registration`, `typecode`/`type`, `category`, `military`.

---

## 3 bis. Combien d'historique puis-je charger ?

Le navigateur travaille **en mémoire** : il faut donc arbitrer entre *durée*, *zone* et
*résolution temporelle*. Ordres de grandeur mesurés avec cet outil :

| Ce que vous chargez | Positions | Mémoire | Usage |
| --- | --- | --- | --- |
| Démo (3 jours, Afrique de l'Ouest) | 100 000 | ~60 Mo | découverte |
| 1 journée, un pays, 1 point/min | 20 000 – 80 000 | ~10 Mo | analyse fine |
| 1 semaine, un pays, 1 point/min | 150 000 – 500 000 | ~40 Mo | suivi d'un aéronef |
| 1 mois, une région, 1 point/5 min | 300 000 – 1 000 000 | ~50 Mo | tendances |
| 1 journée **mondiale** complète (adsb.lol) | 10 – 20 millions | plusieurs Go | ✗ impossible dans un navigateur |

Autrement dit : **un extrait régional sur plusieurs semaines, oui ; la totalité de l'historique
mondial, non.** Pour cela il faut une vraie base de données — c'est exactement le rôle du
backend PostgreSQL/PostGIS de Turnstone (`backend-data-loading/` + `backend-api/`).

Règles pratiques :

- importez **une zone** (bouton « Dessiner » ou « zone visible ») plutôt que le monde entier ;
- baissez la résolution (1 point/2 min ou /5 min) pour couvrir plus longtemps ;
- la limite de positions de la fenêtre d'import (jusqu'à 5 M) borne la mémoire utilisée ;
- les jeux de données fusionnés restent dans IndexedDB : ~50 Mo pour 1 M de positions.

---

## 4. Fonctionnalités

| Domaine | Détail |
| --- | --- |
| **Zone** | zone visible de la carte, monde entier, ou rectangle dessiné à la souris |
| **Période** | préréglages 1 h / 6 h / 24 h / tout, ou bornes précises (UTC) |
| **Aéronef** | recherche par code ICAO 24 bits (hex) ou par indicatif (ex. `SZN204`) |
| **Filtres de vol** | altitude, vitesse sol, cap (avec gestion du passage 0°/360°), catégorie, statut militaire |
| **Carte** | traces colorées par aéronef, extrémités cliquables, fond sombre/clair/satellite/aucun |
| **Tableaux** | positions (triables, paginées) et synthèse par aéronef (durée, alt. max, distance suivie…) |
| **Détail** | panneau par aéronef : métadonnées, statistiques, profil d'altitude, isolement du vol |
| **Chronologie** | histogramme des positions et du nombre d'aéronefs dans la sélection |
| **Export** | CSV des positions filtrées et CSV de la synthèse par aéronef |
| **Données réelles** | relevé automatique des API ADS-B publiques (workflow du dépôt, zones paramétrables) et, en option, direct navigateur via relais |
| **Cumul** | import jour par jour fusionné dans un même jeu de données (couverture multi-jours) |
| **Import URL** | téléchargement + décodage en flux d'une archive depuis son adresse (si CORS autorisé) |
| **Stockage** | jeux de données importés conservés localement (IndexedDB), suppression possible |

Tout est calculé côté client : `filtrage → agrégation → rendu` en quelques dizaines de
millisecondes sur des dizaines de milliers de positions.

---

## 5. Différences avec Turnstone « complet »

| | Turnstone | Turnstone Lite |
| --- | --- | --- |
| Installation | PostgreSQL + PostGIS, Python, Node, Firebase | aucun (fichiers statiques) |
| Authentification | Firebase | aucune (outil personnel/local) |
| Stockage | base PostgreSQL (jours/mois de données) | mémoire + IndexedDB (une zone, quelques jours max) |
| Enrichissement `modes.csv` | immatriculation, type, catégorie, militaire | fourni par les données importées (souvent absent) |
| Requêtes | SQL/PostGIS sur de gros volumes | filtres en mémoire |
| Multi-utilisateurs | oui | non |

Turnstone Lite est pensé pour **explorer rapidement** un extrait d'historique et exporter des
résultats ; pour des mois de données et des requêtes lourdes, utilisez le Turnstone complet.

---

## 6. Héberger le site

Tous les chemins sont relatifs : ce dossier fonctionne à la racine d'un domaine comme dans un
sous-dossier.

- **GitHub Pages** (3 clics, sans workflow) :
  *Settings → Pages → Source: Deploy from a branch* → **Branch** = `main`,
  **Folder** = **`/docs`** (GitHub ne propose que `/` ou `/docs`) → *Save*.
  Le fichier `.nojekyll` est déjà présent : la page est publiée en une minute sur
  **<https://pratisig.github.io/adsb-history/>**.
- **Netlify / Cloudflare Pages** : *publish directory* = `docs`.
- **Vercel** : `vercel --cwd docs` ou import du dépôt avec *Root Directory* = `docs`,
  framework *Other*, aucune commande de build.
- **Docker / nginx** : servez simplement le contenu de `docs/`.

Aucune variable d'environnement, aucun secret.

---

## 7. Architecture

```
docs/
├── images/                    captures utilisées par le README principal
├── index.html                 interface (aucun build)
├── assets/
│   ├── css/app.css
│   ├── js/
│   │   ├── app.js             contrôleur UI, stockage IndexedDB, import
│   │   ├── parse.js           décodeur heatmap tar1090 + lecture tar en flux + CSV
│   │   ├── import-worker.js   worker d'import (parsing hors du thread principal)
│   │   ├── dataset.js         modèle colonnaire compact (Float32/Float64/Uint32)
│   │   ├── query.js           filtres, agrégation par aéronef, chronologie, CSV
│   │   └── mapview.js         carte Leaflet, traces, sélection de zone
│   └── vendor/leaflet/        Leaflet 1.9.4 (BSD-2, embarqué pour fonctionner hors-ligne)
├── data/demo.json             jeu de démonstration (généré, voir tools/)
├── tools/
│   ├── make_demo_data.py      génère data/demo.json
│   └── make_test_fixture.py   génère les archives de test du décodeur
└── test/
    ├── run-tests.mjs          tests Node du décodeur et du moteur de requête
    └── fixtures/              archives tar de test + positions attendues
```

Le format binaire décodé est exactement celui de
[`backend-data-loading/process_adsb_data.py`](../backend-data-loading/process_adsb_data.py) :
marqueur `243235997`, horodatage 64 bits sur deux mots, hex sur 24 bits (+ bit « ~ »),
altitude ×25 ft, vitesse sol ÷10 kt, `-123` = au sol.

### Tests

```bash
node docs/test/run-tests.mjs
```

Couvre : décodage d'une archive tar, archive découpée (`.aa` + `.ab`), filtrage géographique à
l'import, import CSV, filtres, agrégation, chronologie et export.

### Régénérer les données de démonstration

```bash
python3 docs/tools/make_demo_data.py > docs/data/demo.json
python3 docs/tools/make_test_fixture.py
```

---

## 8. Vie privée

Aucune donnée ne quitte votre appareil : pas de télémétrie, pas d'appel API, pas de cookies.
Les jeux de données importés restent dans l'IndexedDB de votre navigateur. Seuls les **fonds de
carte** (CARTO/Esri) sont chargés depuis Internet — vous pouvez choisir « Aucun fond » pour un
usage 100 % hors-ligne.

## 9. Licence

MIT, comme le projet Turnstone d'origine (© Bellingcat). Leaflet est distribué sous licence
BSD-2-Clause (voir `assets/vendor/leaflet/LICENSE`).
