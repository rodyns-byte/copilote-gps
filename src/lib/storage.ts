import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LngLat } from './geo';
import type { Vehicle } from './vehicle';

export type Place = { name: string; label: string; coord: LngLat };
export type Trip = { name: string; coord: LngLat; at: number; hour: number; dow: number; predicted?: number; actual?: number };
export type AlertType = 'accident' | 'bouchon' | 'travaux' | 'police' | 'danger' | 'ferme';
export type RoadAlert = { id: string; type: AlertType; coord: LngLat; at: number; source: string; desc?: string };
// Zones de contravention : affichage sur la carte, annonce vocale, distance d'avertissement avant la zone.
export type ZoneSettings = { show: boolean; voice: boolean; warnM: number; osm: boolean };
export const DEFAULT_ZONES: ZoneSettings = { show: true, voice: true, warnM: 500, osm: true };
export type Settings = { home: Place | null; work: Place | null; claudeKey: string; tomtomKey: string; vehicle: Vehicle | null;
  zones: ZoneSettings; regcheckUser: string };
export const DEFAULT_SETTINGS: Settings = { home: null, work: null, claudeKey: '', tomtomKey: '', vehicle: null, zones: DEFAULT_ZONES, regcheckUser: '' };

const KEY = 'copilote.';

async function get<T>(k: string, fallback: T): Promise<T> {
  try {
    const v = await AsyncStorage.getItem(KEY + k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
async function set<T>(k: string, v: T): Promise<void> {
  try { await AsyncStorage.setItem(KEY + k, JSON.stringify(v)); } catch {}
}

export const store = {
  getSettings: () => get<Partial<Settings>>('settings', {}).then((s): Settings => ({ ...DEFAULT_SETTINGS, ...s, zones: { ...DEFAULT_ZONES, ...s.zones } })),
  setSettings: (s: Settings) => set('settings', s),
  getTrips: () => get<Trip[]>('trips', []),
  addTrip: async (t: Trip) => set('trips', [...(await get<Trip[]>('trips', [])), t].slice(-200)),
  getAlerts: () => get<RoadAlert[]>('alerts', []),
  setAlerts: (a: RoadAlert[]) => set('alerts', a.slice(-100)),
};
