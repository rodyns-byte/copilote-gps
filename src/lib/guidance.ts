// Guidage pas à pas, commun au téléphone et à l'écran de la voiture.
// guide() fait avancer la navigation à chaque position GPS et dit ce qu'il faut annoncer.
import { ALERT_LABEL, CONTRAVENTION_ZONE_M } from './alerts';
import type { ChargePlan, ChargeStop } from './charging';
import { CONFIG } from './config';
import { dist, distToLine, fmtDist, type LngLat } from './geo';
import { instruction, lower, type Route, type Step } from './routing';
import { DEFAULT_ZONES, type RoadAlert, type ZoneSettings } from './storage';
import { arrivalPct, LOW_BATTERY_PCT, type Vehicle } from './vehicle';

export type Guidance = {
  route: Route; steps: Step[]; stepIdx: number;
  announced: Set<string>; alerted: Set<string>; offCount: number; rerouting: boolean; lowBatteryWarned: boolean;
  charge: ChargePlan | null; stopsDone: number; // arrêts de recharge déjà atteints
};

export type GuidanceEvent =
  | { type: 'say'; text: string }
  | { type: 'reroute' }
  | { type: 'arrive' }
  | { type: 'charger'; stop: ChargeStop; text: string }
  | { type: 'alert'; alert: RoadAlert; text: string; spoken: string };

export function newGuidance(route: Route, charge: ChargePlan | null): Guidance {
  const steps = route.legs.flatMap((l) => l.steps);
  return { route, steps, stepIdx: Math.min(1, steps.length - 1), announced: new Set(), alerted: new Set(), offCount: 0,
    rerouting: false, lowBatteryWarned: !!charge, charge, stopsDone: 0 };
}

/** Consigne annoncée au départ. */
export function departureText(g: Guidance): string {
  const [a, b] = g.steps;
  return instruction(a) + (b ? '. Puis ' + lower(instruction(b)) : '');
}

/** Remplace l'itinéraire après un recalcul. */
export function rerouted(g: Guidance, r: Route) {
  Object.assign(g, { route: r, steps: r.legs.flatMap((l) => l.steps), stepIdx: 1, announced: new Set(), offCount: 0 });
}

/** Bornes du plan de recharge qui restent à atteindre (pour un recalcul). */
export const remainingChargers = (g: Guidance): LngLat[] => g.charge ? g.charge.stops.slice(g.stopsDone).map((s) => s.charger.coord) : [];

export function guide(g: Guidance, f: { coord: LngLat; speed: number }, alerts: RoadAlert[], vehicle: Vehicle | null,
  zones: ZoneSettings = DEFAULT_ZONES): GuidanceEvent[] {
  const out: GuidanceEvent[] = [];
  const line = g.route.geometry.coordinates;
  // 1) hors trajet ? -> recalcul automatique
  const near = distToLine(f.coord, line);
  if (near.d > CONFIG.offRouteMeters) {
    g.offCount++;
    if (g.offCount >= CONFIG.offRouteFixes && !g.rerouting) return [{ type: 'reroute' }];
  } else g.offCount = 0;
  // 2) prochaine manœuvre
  const atStop = (i: number) => { // arrivée à une borne du plan de recharge (annoncée une seule fois)
    if (g.steps[i].maneuver.type !== 'waypoint' || !g.charge || g.announced.has(`${i}:borne`)) return;
    g.announced.add(`${i}:borne`);
    const stop = g.charge.stops[g.stopsDone++];
    if (stop) out.push({ type: 'charger', stop,
      text: `Vous êtes à la borne ${stop.charger.name}. Rechargez jusqu'à ${stop.departPct} pour cent, environ ${Math.round(stop.chargeMin)} minutes.` });
  };
  while (g.stepIdx < g.steps.length - 1 && dist(f.coord, g.steps[g.stepIdx].maneuver.location) < 20) { atStop(g.stepIdx); g.stepIdx++; }
  const step = g.steps[g.stepIdx];
  const d = dist(f.coord, step.maneuver.location);
  for (const th of [800, 300, 60]) {
    const k = `${g.stepIdx}:${th}`;
    if (d < th && !g.announced.has(k) && (th !== 800 || f.speed > 15)) {
      g.announced.add(k);
      out.push({ type: 'say', text: th === 60 ? instruction(step) : `Dans ${fmtDist(d)}, ${lower(instruction(step))}` });
      break;
    }
  }
  if (step.maneuver.type === 'arrive' && d < 30) return [...out, { type: 'arrive' }];
  if (d < 40) atStop(g.stepIdx);
  // 3) dangers devant nous
  for (const a of alerts) {
    const zone = a.type === 'police';
    if (g.alerted.has(a.id) || (zone && !zones.show && !zones.voice)) continue;
    const ad = dist(f.coord, a.coord);
    const reach = zone ? CONTRAVENTION_ZONE_M + zones.warnM : CONFIG.alertAheadMeters;
    if (ad > reach) continue;
    const onLine = distToLine(a.coord, line);
    if (onLine.i < near.i - 1 || onLine.d > (zone ? CONTRAVENTION_ZONE_M : 80)) continue;
    g.alerted.add(a.id);
    if (zone) {
      // Zone de contravention : on annonce la zone, jamais l'emplacement exact d'un radar.
      const inside = ad <= CONTRAVENTION_ZONE_M;
      const text = inside ? 'Vous entrez dans une zone de contravention' : `Zone de contravention dans ${fmtDist(ad - CONTRAVENTION_ZONE_M)}`;
      out.push({ type: 'alert', alert: a, text, spoken: zones.voice ? text + ', respectez les limitations' : '' });
    } else {
      out.push({ type: 'alert', alert: a, text: `${ALERT_LABEL[a.type]} à ${fmtDist(ad)}`,
        spoken: `Attention, ${ALERT_LABEL[a.type].toLowerCase()} signalé à ${fmtDist(ad)}` });
    }
  }
  // 4) batterie à l'arrivée trop basse ?
  if (vehicle && !g.lowBatteryWarned && arrivalPct(g.steps.slice(g.stepIdx), vehicle) < LOW_BATTERY_PCT) {
    g.lowBatteryWarned = true;
    out.push({ type: 'say', text: `Attention, il vous restera moins de ${LOW_BATTERY_PCT} pour cent de batterie à l'arrivée. Prévoyez une recharge.` });
  }
  return out;
}

/** Temps restant (s) : étapes restantes, ajustées à vos habitudes, plus les recharges à venir. */
export function remainingSeconds(g: Guidance, factor: number): number {
  const drive = g.steps.slice(g.stepIdx).reduce((s, x) => s + x.duration, 0) * factor;
  const charging = g.charge ? g.charge.stops.slice(g.stopsDone).reduce((s, x) => s + x.chargeMin * 60, 0) : 0;
  return drive + charging;
}

/** Résumé envoyé à l'écran de la voiture. */
export function carSnapshot(g: Guidance, dest: { name: string; label: string; coord: LngLat }, pos: LngLat, factor: number, vehicle: Vehicle | null) {
  const step = g.steps[g.stepIdx];
  return {
    dest, route: g.route, steps: g.steps, stepIdx: g.stepIdx, charge: g.charge, stopsDone: g.stopsDone,
    stepDist: dist(pos, step.maneuver.location),
    remainingS: remainingSeconds(g, factor),
    remainingM: g.steps.slice(g.stepIdx).reduce((s, x) => s + x.distance, 0),
    batteryPct: g.charge ? g.charge.arrivalPct : vehicle ? arrivalPct(g.steps.slice(g.stepIdx), vehicle) : null,
  };
}

/** Êtes-vous dans une zone de contravention ? (pour le bandeau orange) */
export const inZone = (pos: LngLat, alerts: RoadAlert[]) =>
  alerts.some((a) => a.type === 'police' && dist(pos, a.coord) <= CONTRAVENTION_ZONE_M);
