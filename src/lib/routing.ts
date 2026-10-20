import { CONFIG } from './config';
import { distToLine, type LngLat } from './geo';
import type { RoadAlert, Trip } from './storage';

export type Step = {
  distance: number;
  duration: number;
  name: string;
  maneuver: { type: string; modifier?: string; exit?: number; location: LngLat };
};
export type Route = {
  distance: number;
  duration: number;
  geometry: { type: 'LineString'; coordinates: LngLat[] };
  legs: { summary: string; steps: Step[] }[];
  // ajoutés par rankRoutes
  eta: number;
  hazards: RoadAlert[];
};
export type Avoid = { toll: boolean; motorway: boolean };

export async function fetchRoutes(from: LngLat, to: LngLat, avoid: Avoid): Promise<{ routes: Route[]; avoidIgnored: boolean }> {
  const exclude = [avoid.toll && 'toll', avoid.motorway && 'motorway'].filter(Boolean).join(',');
  const base = `${CONFIG.osrmUrl}${from.join(',')};${to.join(',')}?alternatives=3&steps=true&overview=full&geometries=geojson`;
  let res = await fetch(base + (exclude ? '&exclude=' + exclude : ''));
  let avoidIgnored = false;
  if (!res.ok && exclude) {
    avoidIgnored = true; // le serveur ne sait pas exclure ces routes
    res = await fetch(base);
  }
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('Aucun itinéraire trouvé');
  return { routes: data.routes.map((r: Route) => ({ ...r, eta: r.duration, hazards: [] })), avoidIgnored };
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

const DIR: Record<string, string> = {
  left: 'à gauche', right: 'à droite', 'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite',
  'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite', straight: 'tout droit', uturn: 'demi-tour',
};
export const ARROW: Record<string, string> = {
  left: '←', right: '→', 'sharp left': '↰', 'sharp right': '↱', 'slight left': '↖', 'slight right': '↗', straight: '↑', uturn: '↶',
};

export function instruction(step: Step): string {
  const m = step.maneuver;
  const dir = (m.modifier && DIR[m.modifier]) || '';
  const road = step.name ? ` sur ${step.name}` : '';
  switch (m.type) {
    case 'depart': return `Partez${road}`;
    case 'arrive': return 'Vous êtes arrivé à destination';
    case 'roundabout':
    case 'rotary': return `Au rond-point, prenez la ${m.exit || 1}${(m.exit || 1) === 1 ? 're' : 'e'} sortie${road}`;
    case 'merge': return `Insérez-vous${road}`;
    case 'on ramp': return `Prenez la bretelle ${dir}${road}`;
    case 'off ramp': return `Prenez la sortie ${dir}${road}`;
    case 'fork': return `À l'embranchement, restez ${dir}${road}`;
    case 'end of road': return `Au bout de la route, tournez ${dir}${road}`;
    case 'continue':
    case 'new name': return m.modifier === 'straight' || !m.modifier ? `Continuez${road}` : `Continuez ${dir}${road}`;
    default: return m.modifier === 'uturn' ? 'Faites demi-tour' : `Tournez ${dir}${road}`;
  }
}
