import { CONFIG } from './config';
import type { LngLat } from './geo';
import type { Place, RoadAlert, Trip } from './storage';

/** Recherche d'adresses (Nominatim), en privilégiant les résultats proches. */
export async function geocode(q: string, near: LngLat | null, limit = 5): Promise<Place[]> {
  const p = new URLSearchParams({ q, format: 'jsonv2', limit: String(limit), 'accept-language': 'fr' });
  if (near) p.set('viewbox', [near[0] - 0.5, near[1] + 0.5, near[0] + 0.5, near[1] - 0.5].join(','));
  const res = await fetch(`${CONFIG.nominatimUrl}search?${p}`, { headers: { 'User-Agent': CONFIG.userAgent } });
  if (!res.ok) throw new Error('Recherche indisponible');
  const list: { display_name: string; lon: string; lat: string }[] = await res.json();
  return list.map((r) => ({ name: r.display_name.split(',')[0], label: r.display_name, coord: [+r.lon, +r.lat] }));
}

/** Incidents TomTom dans une zone [ouest, sud, est, nord]. */
export async function fetchIncidents(bounds: [number, number, number, number], key: string): Promise<RoadAlert[]> {
  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,events{description}}}}';
  const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=${bounds.map((v) => v.toFixed(4)).join(',')}` +
    `&fields=${encodeURIComponent(fields)}&language=fr-FR&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Trafic indisponible');
  const data = await res.json();
  const cat: Record<number, RoadAlert['type']> = { 1: 'accident', 6: 'bouchon', 7: 'ferme', 8: 'ferme', 9: 'travaux' };
  return (data.incidents || []).map((i: any, k: number) => {
    const c: LngLat = i.geometry.type === 'Point' ? i.geometry.coordinates : i.geometry.coordinates[0];
    return { id: `t${k}-${c.join()}`, type: cat[i.properties.iconCategory] ?? 'danger', coord: c, at: Date.now(), source: 'TomTom',
      desc: i.properties.events?.[0]?.description };
  });
}

/** Destinations probables à cette heure-ci, d'après l'historique des trajets. */
export function predictDestinations(trips: Trip[], now = new Date()) {
  const h = now.getHours(), weekend = [0, 6].includes(now.getDay());
  const groups: Record<string, { name: string; coord: LngLat; score: number }> = {};
  for (const t of trips) {
    const key = t.coord.map((c) => c.toFixed(3)).join(',');
    const gap = Math.abs(t.hour - h);
    const sameSlot = Math.min(gap, 24 - gap) <= 1;
    const sameDayType = [0, 6].includes(t.dow) === weekend;
    const ageDays = (now.getTime() - t.at) / 864e5;
    const w = (sameSlot ? 3 : 0.5) * (sameDayType ? 2 : 1) * Math.exp(-ageDays / 60);
    (groups[key] ??= { name: t.name, coord: t.coord, score: 0 }).score += w;
  }
  return Object.values(groups).sort((a, b) => b.score - a.score).slice(0, 4);
}
