import { CONFIG } from './config';
import { distToLine, type LngLat } from './geo';
import type { RoadAlert, Trip } from './storage';

export type Step = {
  distance: number; // m
  duration: number; // s
  name: string;
  text: string; // consigne complète en français, fournie par Valhalla
  maneuver: { type: string; modifier?: string; exit?: number; location: LngLat };
};
export type Route = {
  distance: number;
  duration: number;
  geometry: { type: 'LineString'; coordinates: LngLat[] };
  legs: { summary: string; steps: Step[] }[];
  hasToll: boolean;
  // ajoutés par rankRoutes
  eta: number;
  hazards: RoadAlert[];
};
export type Avoid = { toll: boolean; motorway: boolean };

/** Décode une polyligne Valhalla (précision 6) en [lon, lat]. */
export function decodePolyline6(str: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) { lat += next(); lon += next(); out.push([lon / 1e6, lat / 1e6]); }
  return out;
}

// Types de manœuvre Valhalla -> type et direction utilisés par l'affichage.
const MANEUVER: Record<number, [string, string?]> = {
  1: ['depart'], 2: ['depart', 'right'], 3: ['depart', 'left'], 4: ['arrive'], 5: ['arrive', 'right'], 6: ['arrive', 'left'],
  7: ['continue', 'straight'], 8: ['continue', 'straight'], 9: ['turn', 'slight right'], 10: ['turn', 'right'], 11: ['turn', 'sharp right'],
  12: ['turn', 'uturn'], 13: ['turn', 'uturn'], 14: ['turn', 'sharp left'], 15: ['turn', 'left'], 16: ['turn', 'slight left'],
  17: ['on ramp', 'straight'], 18: ['on ramp', 'right'], 19: ['on ramp', 'left'], 20: ['off ramp', 'right'], 21: ['off ramp', 'left'],
  22: ['fork', 'straight'], 23: ['fork', 'right'], 24: ['fork', 'left'], 25: ['merge'], 26: ['roundabout'], 27: ['exit roundabout'],
};

type VManeuver = { type: number; instruction: string; verbal_pre_transition_instruction?: string; street_names?: string[];
  time: number; length: number; begin_shape_index: number; roundabout_exit_count?: number };
type VTrip = { summary: { time: number; length: number; has_toll: boolean }; legs: { shape: string; maneuvers: VManeuver[] }[] };

function toRoute(trip: VTrip): Route {
  const coords = trip.legs.flatMap((l) => decodePolyline6(l.shape));
  const steps: Step[] = [];
  for (const leg of trip.legs) {
    const shape = decodePolyline6(leg.shape);
    for (const m of leg.maneuvers) {
      const [type, modifier] = MANEUVER[m.type] ?? ['continue'];
      steps.push({
        distance: m.length * 1000, duration: m.time, name: m.street_names?.[0] ?? '',
        text: (m.verbal_pre_transition_instruction || m.instruction).replace(/\.$/, ''),
        maneuver: { type, modifier, exit: m.roundabout_exit_count, location: shape[m.begin_shape_index] ?? coords[0] },
      });
    }
  }
  const names = [...new Set(steps.filter((s) => s.name && s.distance > 5000).sort((a, b) => b.distance - a.distance).map((s) => s.name))].slice(0, 2);
  return {
    distance: trip.summary.length * 1000, duration: trip.summary.time, hasToll: trip.summary.has_toll,
    geometry: { type: 'LineString', coordinates: coords }, legs: [{ summary: names.join(', '), steps }], eta: trip.summary.time, hazards: [],
  };
}

export async function fetchRoutes(from: LngLat, to: LngLat, avoid: Avoid): Promise<{ routes: Route[]; avoidIgnored: boolean }> {
  const body = {
    locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }],
    costing: 'auto',
    costing_options: { auto: { use_tolls: avoid.toll ? 0 : 0.5, use_highways: avoid.motorway ? 0 : 1 } },
    alternates: 2,
    units: 'kilometers',
    language: 'fr-FR',
  };
  const res = await fetch(CONFIG.valhallaUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || !data.trip) throw new Error(data.error ? `Aucun itinéraire trouvé (${data.error})` : 'Aucun itinéraire trouvé');
  const routes = [data.trip, ...(data.alternates ?? []).map((a: { trip: VTrip }) => a.trip)].map(toRoute);
  // « Éviter » est une préférence : s'il n'existe aucun trajet sans péage, Valhalla en garde un.
  return { routes, avoidIgnored: avoid.toll && routes.every((r) => r.hasToll) };
}

/** Écart habituel entre la durée réelle et la durée prévue (médiane des 20 derniers trajets). */
export function personalFactor(trips: Trip[]): number {
  const r = trips.filter((t) => t.actual && t.predicted).slice(-20).map((t) => t.actual! / t.predicted!).sort((a, b) => a - b);
  if (r.length < 3) return 1;
  return Math.min(1.5, Math.max(0.8, r[Math.floor(r.length / 2)]));
}

const PENALTY: Partial<Record<RoadAlert['type'], number>> = { ferme: 3600, accident: 600, bouchon: 480, travaux: 300 };

/** Ajuste chaque trajet selon vos habitudes et les incidents connus. Renvoie l'index du meilleur. */
export function rankRoutes(routes: Route[], alerts: RoadAlert[], factor: number): number {
  let best = 0;
  routes.forEach((r, i) => {
    r.hazards = alerts.filter((a) => distToLine(a.coord, r.geometry.coordinates).d < 80);
    r.eta = r.duration * factor + r.hazards.reduce((s, a) => s + (PENALTY[a.type] ?? 0), 0);
    if (r.eta < routes[best].eta) best = i;
  });
  return best;
}

export const ARROW: Record<string, string> = {
  left: '←', right: '→', 'sharp left': '↰', 'sharp right': '↱', 'slight left': '↖', 'slight right': '↗', straight: '↑', uturn: '↶',
};

export function instruction(step: Step): string {
  return step.text;
}

/** Consigne en milieu de phrase (« Dans 300 m, tournez… ») sans abîmer les noms de rue. */
export const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
