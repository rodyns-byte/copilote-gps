// Planification des arrêts de recharge pour une voiture électrique.
// 1) On suit la batterie le long du trajet. 2) Avant de passer sous la réserve, on cherche une borne
// près de la route (OpenStreetMap). 3) On recharge jusqu'au niveau cible et on continue.
import { dist, type LngLat } from './geo';
import { type Avoid, fetchRoutes, type Route } from './routing';
import { speedFactor, type Vehicle } from './vehicle';

export type Charger = { id: string; name: string; coord: LngLat; powerKw: number | null; operator?: string };
export type ChargeStop = {
  charger: Charger;
  arrivalPct: number; // batterie en arrivant à la borne
  departPct: number; // batterie en repartant
  chargeMin: number; // temps de recharge estimé
  kmFromStart: number;
};
export type ChargePlan = { stops: ChargeStop[]; route: Route; arrivalPct: number; totalChargeMin: number };

export const RESERVE_PCT = 15; // on ne descend pas sous ce niveau
export const TARGET_PCT = 80; // au-delà, la recharge rapide ralentit beaucoup
const SEARCH_RADIUS_M = 3000; // distance maximale entre la route et la borne
const DEFAULT_POWER_KW = 50;

/** Batterie (%) et distance cumulée (km) à chaque point de la route : chaque segment consomme au rythme de son étape. */
export function socProfile(route: Route, v: Vehicle, startPct: number) {
  const line = route.geometry.coordinates;
  const steps = route.legs.flatMap((l) => l.steps);
  const pctPerKm: number[] = new Array(line.length).fill(0);
  steps.forEach((s, i) => {
    const kmh = s.duration > 0 ? (s.distance / s.duration) * 3.6 : 50;
    const rate = ((v.consumption / 100) * speedFactor(kmh) / v.capacityKwh) * 100;
    const end = steps[i + 1]?.shapeIndex ?? line.length;
    for (let k = s.shapeIndex; k < end; k++) pctPerKm[k] = rate;
  });
  let pct = startPct, km = 0;
  return line.map((p, i) => {
    if (i > 0) { const d = dist(line[i - 1], p) / 1000; km += d; pct -= d * pctPerKm[i - 1]; }
    return { pct, km, end: p };
  });
}

/** Temps de recharge (minutes), avec la puissance limitée par la borne et par la voiture. */
export function chargeMinutes(fromPct: number, toPct: number, v: Vehicle, stationKw: number | null): number {
  const kw = Math.min(stationKw ?? DEFAULT_POWER_KW, v.maxChargeKw ?? 100) * 0.85; // pertes et ralentissement
  return Math.max(0, ((toPct - fromPct) / 100) * v.capacityKwh / kw * 60);
}

/** Points de la route entre deux distances (km), un tous les ~5 km : sert à chercher les bornes. */
export function sampleLine(line: LngLat[], fromKm: number, toKm: number): LngLat[] {
  const out: LngLat[] = [];
  let km = 0, lastKm = -Infinity;
  for (let i = 1; i < line.length; i++) {
    km += dist(line[i - 1], line[i]) / 1000;
    if (km >= fromKm && km <= toKm && km - lastKm >= 5) { out.push(line[i]); lastKm = km; }
  }
  return out;
}

const POWER_TAGS = /^(socket:.*:output|charging_station:output|maxpower|capacity:power)$/;
function parsePower(tags: Record<string, string>): number | null {
  let best: number | null = null;
  for (const [k, v] of Object.entries(tags)) {
    if (!POWER_TAGS.test(k)) continue;
    const m = v.match(/([\d.]+)\s*(kw|w)?/i);
    if (!m) continue;
    const kw = m[2]?.toLowerCase() === 'w' ? +m[1] / 1000 : +m[1];
    if (kw > 0 && kw < 1000) best = Math.max(best ?? 0, kw);
  }
  return best;
}

/** Bornes publiques près d'une suite de points (Overpass / OpenStreetMap). */
export async function findChargers(points: LngLat[], url = 'https://overpass-api.de/api/interpreter'): Promise<Charger[]> {
  if (!points.length) return [];
  const around = points.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');
  const q = `[out:json][timeout:25];(node["amenity"="charging_station"](around:${SEARCH_RADIUS_M},${around});` +
    `way["amenity"="charging_station"](around:${SEARCH_RADIUS_M},${around}););out center tags 200;`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
  if (!res.ok) throw new Error('Recherche des bornes indisponible');
  const data = await res.json();
  return (data.elements ?? [])
    .filter((e: any) => e.tags?.access !== 'private' && e.tags?.access !== 'customers')
    .map((e: any) => ({
      id: `${e.type}/${e.id}`,
      name: e.tags.name || e.tags.operator || e.tags.network || 'Borne de recharge',
      operator: e.tags.operator,
      coord: [e.lon ?? e.center.lon, e.lat ?? e.center.lat] as LngLat,
      powerKw: parsePower(e.tags),
    }));
}

/** Choisit la meilleure borne : rapide d'abord, puis la plus loin possible sur le trajet. */
export function pickCharger(chargers: Charger[], line: LngLat[], windowEnd: LngLat): Charger | null {
  if (!chargers.length) return null;
  const score = (c: Charger) => {
    const kw = c.powerKw ?? DEFAULT_POWER_KW;
    const fast = kw >= 100 ? 3 : kw >= 40 ? 2 : kw >= 20 ? 0.6 : 0.2; // une borne lente coûte des heures
    return fast * 100 - dist(c.coord, windowEnd) / 1000; // 1 point par km d'écart avec la fin de la fenêtre
  };
  return [...chargers].sort((a, b) => score(b) - score(a))[0];
}

type Deps = {
  route: (points: LngLat[]) => Promise<Route>;
  chargers: (points: LngLat[]) => Promise<Charger[]>;
};

/**
 * Calcule les arrêts de recharge pour aller de `from` à `to`.
 * Renvoie null si la batterie suffit sans s'arrêter.
 */
export async function planCharging(from: LngLat, to: LngLat, v: Vehicle, avoid: Avoid, deps?: Partial<Deps>): Promise<ChargePlan | null> {
  const route = deps?.route ?? (async (pts: LngLat[]) => (await fetchRoutes(pts, avoid)).routes[0]);
  const chargers = deps?.chargers ?? findChargers;

  const direct = await route([from, to]);
  const directProfile = socProfile(direct, v, v.batteryPct);
  if (directProfile[directProfile.length - 1].pct >= RESERVE_PCT) return null;

  const stops: ChargeStop[] = [];
  let pos = from, pct = v.batteryPct, kmDone = 0;
  for (let n = 0; n < 6; n++) {
    const leg = await route([pos, to]);
    const prof = socProfile(leg, v, pct);
    if (prof[prof.length - 1].pct >= RESERVE_PCT) break; // on arrive avec assez de batterie
    // Dernier point où l'on est encore au-dessus de la réserve, puis fenêtre de recherche de 60 km avant.
    const lastOk = prof.filter((p) => p.pct >= RESERVE_PCT).pop();
    if (!lastOk) throw new Error("Batterie trop faible pour atteindre une borne : rechargez avant de partir.");
    const line = leg.geometry.coordinates;
    let found: Charger | null = null;
    for (const back of [60, 120]) {
      const pts = sampleLine(line, Math.max(1, lastOk.km - back), lastOk.km);
      found = pickCharger((await chargers(pts)).filter((c) => !stops.some((s) => s.charger.id === c.id)), line, lastOk.end);
      if (found) break;
    }
    if (!found) throw new Error('Aucune borne trouvée près du trajet. Essayez un autre itinéraire.');
    const toCharger = await route([pos, found.coord]);
    const arrive = socProfile(toCharger, v, pct).pop()!.pct;
    const chargeMin = chargeMinutes(arrive, TARGET_PCT, v, found.powerKw);
    kmDone += toCharger.distance / 1000;
    stops.push({ charger: found, arrivalPct: arrive, departPct: TARGET_PCT, chargeMin, kmFromStart: kmDone });
    pos = found.coord;
    pct = TARGET_PCT;
  }
  if (stops.length === 6) throw new Error('Trajet trop long pour être planifié automatiquement.');

  // Itinéraire complet passant par les bornes.
  const full = await route([from, ...stops.map((s) => s.charger.coord), to]);
  const lastStart = stops.length ? stops[stops.length - 1].charger.coord : from;
  const arrivalPct = socProfile(await route([lastStart, to]), v, stops.length ? TARGET_PCT : v.batteryPct).pop()!.pct;
  const totalChargeMin = stops.reduce((s, x) => s + x.chargeMin, 0);
  full.eta = full.duration + totalChargeMin * 60;
  return { stops, route: full, arrivalPct, totalChargeMin };
}
