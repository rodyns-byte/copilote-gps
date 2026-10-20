import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LngLat } from './geo';

export type Place = { name: string; label: string; coord: LngLat };
export type Trip = { name: string; coord: LngLat; at: number; hour: number; dow: number; predicted?: number; actual?: number };
export type AlertType = 'accident' | 'bouchon' | 'travaux' | 'police' | 'danger' | 'ferme';
export type RoadAlert = { id: string; type: AlertType; coord: LngLat; at: number; source: string; desc?: string };
export type Settings = { home: Place | null; work: Place | null; claudeKey: string; tomtomKey: string };

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
  getSettings: () => get<Settings>('settings', { home: null, work: null, claudeKey: '', tomtomKey: '' }),
  setSettings: (s: Settings) => set('settings', s),
  getTrips: () => get<Trip[]>('trips', []),
  addTrip: async (t: Trip) => set('trips', [...(await get<Trip[]>('trips', [])), t].slice(-200)),
  getAlerts: () => get<RoadAlert[]>('alerts', []),
  setAlerts: (a: RoadAlert[]) => set('alerts', a.slice(-100)),
};
