import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

// A plain Leaflet TileLayer whose tiles come from the main process's
// on-disk MapTileCache (via IPC) instead of a direct https:// request —
// that's what makes the map keep working offline for tiles already seen.
// Not a real react-leaflet <TileLayer>, since that component only knows how
// to build a URL template; overriding createTile is the standard Leaflet
// pattern for non-network tile sources (same approach leaflet.offline uses).
const CachedTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = '';
    window.nexdigi.getMapTile(coords.z, coords.x, coords.y)
      .then(({ data, contentType }) => {
        const blob = new Blob([new Uint8Array(data)], { type: contentType || 'image/png' });
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); done(null, img); };
        img.onerror = () => { URL.revokeObjectURL(url); done(new Error('tile decode failed'), img); };
        img.src = url;
      })
      .catch((err) => done(err, img));
    return img;
  }
});

export default function CachedOsmTileLayer({ attribution, maxZoom = 19 }) {
  const map = useMap();
  useEffect(() => {
    const layer = new CachedTileLayer('', { attribution, maxZoom });
    layer.addTo(map);
    return () => { map.removeLayer(layer); };
  }, [map, attribution, maxZoom]);
  return null;
}
