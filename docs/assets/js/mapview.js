/**
 * Turnstone Lite — carte Leaflet (traces, sélection de zone, fonds de carte).
 */

const BASEMAPS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  },
  sat: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 17, attribution: 'Esri, Maxar, Earthstar Geographics' },
  },
  none: null,
};

export function colorFor(key) {
  let h = 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 85% 62%)`;
}

export class MapView {
  constructor(el, handlers = {}) {
    this.map = L.map(el, {
      zoomControl: true,
      preferCanvas: true,
      worldCopyJump: true,
      minZoom: 2,
    }).setView([14.8, -17.4], 7);

    this.map.attributionControl.setPrefix('');
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.markerLayer = L.layerGroup().addTo(this.map);
    this.rect = null;
    this.drawEnabled = false;
    this.handlers = handlers;
    this.basemapName = 'dark';
    this.canvasRenderer = L.canvas({ padding: 0.4 });
    this.setBasemap('dark');
    this._initDraw();
  }

  setBasemap(name) {
    if (this.basemapLayer) this.map.removeLayer(this.basemapLayer);
    this.basemapName = name;
    const def = BASEMAPS[name];
    if (!def) {
      this.basemapLayer = null;
      const el = this.map.getContainer();
      el.classList.add('no-basemap');
      return;
    }
    this.map.getContainer().classList.remove('no-basemap');
    this.basemapLayer = L.tileLayer(def.url, def.options).addTo(this.map);
    this.basemapLayer.bringToBack();
  }

  getViewBbox() {
    const b = this.map.getBounds();
    const round = (v) => Math.round(v * 1e5) / 1e5;
    return [round(b.getWest()), round(b.getSouth()), round(b.getEast()), round(b.getNorth())];
  }

  setBbox(bbox) {
    this.clearBbox();
    if (!bbox) return;
    const [[minLon, minLat], [maxLon, maxLat]] = [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ];
    this.rect = L.rectangle(
      [
        [minLat, minLon],
        [maxLat, maxLon],
      ],
      { color: '#ffb02e', weight: 2, fillOpacity: 0.06, dashArray: '6 4' }
    ).addTo(this.map);
  }

  clearBbox() {
    if (this.rect) {
      this.map.removeLayer(this.rect);
      this.rect = null;
    }
  }

  fitBbox(bbox, padding = 24) {
    if (!bbox) return;
    this.map.fitBounds(
      [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
      ],
      { padding: [padding, padding], maxZoom: 12 }
    );
  }

  _initDraw() {
    const map = this.map;
    let start = null;
    let temp = null;

    map.on('mousedown', (e) => {
      if (!this.drawEnabled) return;
      this.clearBbox();
      start = e.latlng;
      temp = L.rectangle(L.latLngBounds(start, start), {
        color: '#ffb02e',
        weight: 2,
        fillOpacity: 0.08,
      }).addTo(map);
      map.dragging.disable();
    });

    map.on('mousemove', (e) => {
      if (!this.drawEnabled || !start || !temp) return;
      temp.setBounds(L.latLngBounds(start, e.latlng));
    });

    map.on('mouseup', (e) => {
      if (!this.drawEnabled || !start) return;
      const from = start;
      const to = e.latlng;
      start = null;
      if (temp) {
        map.removeLayer(temp);
        temp = null;
      }
      map.dragging.enable();
      if (Math.abs(to.lat - from.lat) < 0.002 && Math.abs(to.lng - from.lng) < 0.002) return;
      const round = (v) => Math.round(v * 1e5) / 1e5;
      const bbox = [
        round(Math.min(from.lng, to.lng)),
        round(Math.min(from.lat, to.lat)),
        round(Math.max(from.lng, to.lng)),
        round(Math.max(from.lat, to.lat)),
      ];
      this.setBbox(bbox);
      this.enableDraw(false);
      if (this.handlers.onBboxChange) this.handlers.onBboxChange(bbox);
    });
  }

  enableDraw(on) {
    this.drawEnabled = on;
    this.map.getContainer().classList.toggle('drawing', on);
    if (on) this.map.dragging.disable();
    else this.map.dragging.enable();
  }

  render(tracks, selectedKey = null) {
    this.trackLayer.clearLayers();
    this.markerLayer.clearLayers();
    const showMarkers = tracks.length <= 400;

    for (const tr of tracks) {
      const selected = selectedKey !== null && String(tr.key) === String(selectedKey);
      const color = colorFor(tr.hex);
      if (tr.track.length > 1) {
        L.polyline(
          tr.track.map((p) => [p[0], p[1]]),
          {
            color: selected ? '#ffffff' : color,
            weight: selected ? 3 : 1.6,
            opacity: selected ? 1 : 0.75,
            renderer: this.canvasRenderer,
            interactive: false,
          }
        ).addTo(this.trackLayer);
      }
      if (showMarkers) {
        const last = tr.track[tr.track.length - 1];
        const marker = L.circleMarker([last[0], last[1]], {
          radius: selected ? 6 : 3.5,
          color: selected ? '#ffffff' : color,
          weight: selected ? 3 : 1.5,
          fillColor: selected ? '#ffb02e' : color,
          fillOpacity: 0.95,
          renderer: this.canvasRenderer,
        }).addTo(this.markerLayer);
        const label = [tr.callsign || tr.hex, tr.typecode || '', tr.category || '']
          .filter(Boolean)
          .join(' · ');
        marker.bindTooltip(label, { direction: 'top', className: 'track-tip', offset: [0, -6] });
        marker.on('click', () => {
          if (this.handlers.onSelectAircraft) this.handlers.onSelectAircraft(tr.key);
        });
      }
    }
  }

  clearTracks() {
    this.trackLayer.clearLayers();
    this.markerLayer.clearLayers();
  }
}
