// Zones de contravention automatiques, à partir des radars fixes connus d'OpenStreetMap.
// En France, on n'affiche jamais l'emplacement exact : chaque radar devient une zone de 500 m
// dont le centre est décalé (jusqu'à 250 m) de façon stable, pour que la zone ne bouge pas d'un affichage à l'autre.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTRAVENTION_ZONE_M } from './alerts';
import { dist, type LngLat } from './geo';
import type { RoadAlert } from './storage';

const CELL = 0.25; // taille d'une case de recherche, en degrés (~25 km)
const MAX_AGE = 7 * 24 * 3600e3; // les radars changent peu : une semaine de cache
const BLUR_M = CONTRAVENTION_ZONE_M / 2;
const OVERPASS = 'https://overpass-api.de/api/interpreter';

type Cell = { at: number; zones: RoadAlert[] };
const memory = new Map<string, Cell>();
const loading = new Map<string, Promise<RoadAlert[]>>();

const cellKey = ([lon, lat]: LngLat) => `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;

/** Décalage pseudo-aléatoire mais toujours le même pour un radar donné. */
function stableBlur(id: string, [lon, lat]: LngLat): LngLat {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const u = ((h >>> 0) % 10000) / 10000, v = ((Math.imul(h, 2654435761) >>> 0) % 10000) / 10000;
  const d = BLUR_M * Math.sqrt(u), a = v * 2 * Math.PI;
  const k = 111320;
  return [lon + (d * Math.cos(a)) / (k * Math.cos((lat * Math.PI) / 180)), lat + (d * Math.sin(a)) / k];
}

async function fetchCell(key: string): Promise<RoadAlert[]> {
  const [x, y] = key.split(':').map(Number);
  const [w, s, e, n] = [x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL];
  const bb = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(node["highway"="speed_camera"](${bb});relation["type"="enforcement"]["enforcement"~"maxspeed|average_speed|traffic_signals"](${bb}););out center 400;`;
  const res = await fetch(OVERPASS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
  if (!res.ok) throw new Error('Radars indisponibles');
  const data = await res.json();
  const zones: RoadAlert[] = [];
  for (const el of data.elements ?? []) {
    const c: LngLat | null = el.lon != null ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
    if (!c) continue;
    const id = `osm-${el.type}-${el.id}`;
    const coord = stableBlur(id, c);
    // Plusieurs radars proches (feux, tronçon) : une seule zone.
    if (zones.some((z) => dist(z.coord, coord) < CONTRAVENTION_ZONE_M * 0.8)) continue;
    zones.push({ id, type: 'police', coord, at: Date.now(), source: 'OpenStreetMap' });
  }
  return zones;
}

/** Zones des cases demandées : mémoire, puis téléphone, puis Internet. */
async function getCell(key: string): Promise<RoadAlert[]> {
  const m = memory.get(key);
  if (m && Date.now() - m.at < MAX_AGE) return m.zones;
  if (loading.has(key)) return loading.get(key)!;
  const p = (async () => {
    try {
      const saved = await AsyncStorage.getItem('copilote.radars.' + key);
      if (saved) {
        const c: Cell = JSON.parse(saved);
        if (Date.now() - c.at < MAX_AGE) { memory.set(key, c); return c.zones; }
      }
    } catch {}
    const zones = await fetchCell(key);
    const c = { at: Date.now(), zones };
    memory.set(key, c);
    AsyncStorage.setItem('copilote.radars.' + key, JSON.stringify(c)).catch(() => {});
    return zones;
  })().finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

/** Cases couvrant une zone de la carte (limitée pour ne pas surcharger le service). */
export function cellsForBounds([w, s, e, n]: [number, number, number, number], max = 6): string[] {
  const keys: string[] = [];
  for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++)
    for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) keys.push(`${x}:${y}`);
  return keys.length <= max ? keys : [];
}

/** Cases traversées par les prochains kilomètres du trajet (et celle où l'on se trouve). */
export function cellsAhead(pos: LngLat, line: LngLat[], fromIdx: number, meters = 30000): string[] {
  const keys = new Set([cellKey(pos)]);
  let d = 0;
  for (let i = Math.max(0, fromIdx); i < line.length - 1 && d < meters; i++) {
    d += dist(line[i], line[i + 1]);
    keys.add(cellKey(line[i + 1]));
  }
  return [...keys];
}

export async function loadZones(keys: string[]): Promise<RoadAlert[]> {
  const res = await Promise.allSettled(keys.map(getCell));
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
