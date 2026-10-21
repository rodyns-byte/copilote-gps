// Guidage lancé depuis la voiture quand l'écran du téléphone n'est pas ouvert
// (Android Auto ou CarPlay démarrent l'application sans afficher son écran principal).
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';

import { planCharging, RESERVE_PCT } from '../lib/charging';
import type { LngLat } from '../lib/geo';
import { carSnapshot, departureText, guide, type Guidance, newGuidance, remainingChargers, rerouted } from '../lib/guidance';
import { fetchRoutes, personalFactor, rankRoutes } from '../lib/routing';
import { type AlertType, type Place, type RoadAlert, type Settings, store, type Trip } from '../lib/storage';
import { arrivalPct } from '../lib/vehicle';
import { CONFIG } from '../lib/config';
import { blur, distToLine } from '../lib/geo';
import { cellsAhead, loadZones } from '../lib/radars';
import { ALERT_LABEL, CONTRAVENTION_ZONE_M } from '../lib/alerts';
import { carBridge } from './bridge';

const say = (t: string) => { Speech.stop(); Speech.speak(t, { language: 'fr-FR' }); };

let nav: (Guidance & { dest: Place; startedAt: number; predicted: number }) | null = null;
let sub: Location.LocationSubscription | null = null;
let pos: LngLat | null = null;
let settings: Settings | null = null;
let trips: Trip[] = [];
let alerts: RoadAlert[] = [];
let zones: RoadAlert[] = []; // zones de contravention connues (OpenStreetMap)
let zonesAt = 0;

async function load() {
  [settings, trips, alerts] = await Promise.all([store.getSettings(), store.getTrips(), store.getAlerts()]);
  alerts = alerts.filter((a) => Date.now() - a.at < CONFIG.alertLifetimeMs);
}

async function watch() {
  if (sub) return;
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Autorisez la localisation sur le téléphone.');
  sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 3 }, (p) => {
    pos = [p.coords.longitude, p.coords.latitude];
    if (nav) tick(pos, p.coords.speed ?? 0);
    else carBridge.publish({ position: pos });
  });
  if (!pos) {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    pos = [p.coords.longitude, p.coords.latitude];
  }
}

function tick(p: LngLat, speed: number) {
  const n = nav!;
  if (settings?.zones.osm !== false && Date.now() - zonesAt > 60e3) {
    zonesAt = Date.now();
    loadZones(cellsAhead(p, n.route.geometry.coordinates, distToLine(p, n.route.geometry.coordinates).i)).then((z) => { zones = z; }).catch(() => {});
  }
  for (const ev of guide(n, { coord: p, speed }, [...alerts, ...zones], settings?.vehicle ?? null, settings?.zones)) {
    if (ev.type === 'reroute') { reroute(); return; }
    if (ev.type === 'arrive') { finish(true); return; }
    if (ev.type === 'say') say(ev.text);
    if (ev.type === 'charger') { say(ev.text); carBridge.notice({ title: ev.stop.charger.name, subtitle: `Rechargez jusqu'à ${ev.stop.departPct} %` }); }
    if (ev.type === 'alert') { if (ev.spoken) say(ev.spoken); carBridge.notice({ title: ev.text }); }
  }
  carBridge.publish({ nav: carSnapshot(n, n.dest, p, personalFactor(trips), settings?.vehicle ?? null), position: p });
}

async function reroute() {
  const n = nav;
  if (!n || !pos) return;
  n.rerouting = true;
  say("Recalcul de l'itinéraire");
  try {
    const { routes } = await fetchRoutes([pos, ...remainingChargers(n), n.dest.coord], { toll: false, motorway: false });
    rerouted(n, routes[rankRoutes(routes, alerts, personalFactor(trips))]);
  } catch { /* on réessaiera au prochain écart */ }
  n.rerouting = false;
}

async function finish(arrived: boolean) {
  const n = nav;
  if (!n) return;
  nav = null;
  carBridge.publish({ nav: null });
  if (arrived) { say('Vous êtes arrivé à destination.'); carBridge.notice({ title: 'Vous êtes arrivé' }); }
  const started = new Date(n.startedAt);
  await store.addTrip({ name: n.dest.name, coord: n.dest.coord, at: n.startedAt, hour: started.getHours(), dow: started.getDay(),
    ...(arrived ? { predicted: n.predicted, actual: (Date.now() - n.startedAt) / 1000 } : {}) });
}

async function go(dest: Place) {
  if (nav) await finish(false);
  carBridge.publish({ planning: `Calcul de l'itinéraire vers ${dest.name}…` });
  try {
    await load();
    await watch();
    const from = pos!;
    const { routes } = await fetchRoutes([from, dest.coord], { toll: false, motorway: false });
    let route = routes[rankRoutes(routes, alerts, personalFactor(trips))];
    const v = settings?.vehicle ?? null;
    let plan = null;
    if (v && arrivalPct(route.legs.flatMap((l) => l.steps), v) < RESERVE_PCT) {
      carBridge.publish({ planning: 'Recherche des bornes de recharge…' });
      plan = await planCharging(from, dest.coord, v, { toll: false, motorway: false });
      if (plan) {
        route = plan.route;
        say(`${plan.stops.length} arrêt${plan.stops.length > 1 ? 's' : ''} de recharge prévu${plan.stops.length > 1 ? 's' : ''}.`);
      }
    }
    nav = { ...newGuidance(route, plan), dest, startedAt: Date.now(), predicted: route.duration };
    say(departureText(nav));
    tick(from, 0);
  } catch (e) {
    const msg = e instanceof TypeError ? 'Pas de connexion Internet' : (e as Error).message;
    carBridge.notice({ title: 'Itinéraire impossible', subtitle: msg });
  } finally { carBridge.publish({ planning: null }); }
}

async function report(type: AlertType) {
  if (!pos) return;
  const coord = type === 'police' ? blur(pos, CONTRAVENTION_ZONE_M / 2) : pos;
  const next = [...(await store.getAlerts()), { id: 'u' + Date.now(), type, coord, at: Date.now(), source: 'vous' }];
  await store.setAlerts(next);
  alerts = next;
  say(`${ALERT_LABEL[type]} signalé`);
}

carBridge.setFallbackController({ go, stop: () => { finish(false); }, report, active: () => !!nav });

/** Position pour la carte de la voiture, même sans navigation. */
export function startCarLocation() { watch().catch(() => {}); }
