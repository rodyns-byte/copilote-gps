// Écran de la voiture : Android Auto et Apple CarPlay (bibliothèque @iternio/react-native-auto-play).
// Carte avec l'itinéraire, manœuvres et temps restant affichés par la voiture, destinations, signalements.
import { useSyncExternalStore } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, NativeUserLocation } from '@maplibre/maplibre-react-native';
import {
  AutoPlayCluster, type AutoGlyphByName, type AutoManeuver, CarPlayDashboard, ForkType, HybridAutoPlay, KeepType, ListTemplate,
  ManeuverType, MapTemplate, OffRampType, OnRampType, type RootComponentInitialProps, type RoutingManeuver, setIconFont,
  TrafficSide, type TripPoint, TurnType,
} from '@iternio/react-native-auto-play';

import { ALERT_LABEL } from '../lib/alerts';
import { CONFIG } from '../lib/config';
import { fmtDist } from '../lib/geo';
import type { Step } from '../lib/routing';
import { predictDestinations } from '../lib/services';
import { type AlertType, type Place, store } from '../lib/storage';
import { type CarNav, carBridge } from './bridge';
import { startCarLocation } from './headless';

// Icônes : police Material Icons fournie avec l'application (assets/fonts/material_icons.ttf).
const GLYPHS = {
  search: 59574, warning: 57346, home: 59530, work: 59641, history: 59529, place: 58719, ev_station: 58733,
  turn_left: 60326, turn_right: 60331, turn_slight_left: 60324, turn_slight_right: 60314, turn_sharp_left: 60327,
  turn_sharp_right: 60330, u_turn_left: 60321, u_turn_right: 60322, straight: 60309, roundabout_right: 60323,
  fork_right: 60332, fork_left: 60320, merge: 60312, ramp_right: 60310, ramp_left: 60316, flag: 57683, navigation: 58717,
  close: 58829, car_crash: 60402, traffic: 58725, construction: 59964, local_police: 61270, report: 57696, block: 57675,
};
type Glyph = keyof typeof GLYPHS;
const icon = (name: Glyph): AutoGlyphByName => ({ type: 'glyph', name });

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
const km = (m: number) => ({ value: Math.round(m / 100) / 10, unit: 'kilometers' as const });
const estimates = (m: number, s: number) => ({ distanceRemaining: km(m), timeRemaining: { timezone: TZ, seconds: Math.round(s) } });

const ALERT_GLYPH: Record<AlertType, Glyph> = {
  accident: 'car_crash', bouchon: 'traffic', travaux: 'construction', police: 'local_police', danger: 'report', ferme: 'block',
};

// ---------- carte affichée sur l'écran de la voiture ----------
function useCar() {
  return useSyncExternalStore(carBridge.subscribe, carBridge.get);
}

function CarMap(_: RootComponentInitialProps) {
  const { nav, position, planning } = useCar();
  const route: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: nav ? [{ type: 'Feature', geometry: nav.route.geometry, properties: {} }] : [],
  };
  const chargers: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: (nav?.charge?.stops.slice(nav.stopsDone) ?? []).map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: s.charger.coord }, properties: {} })),
  };
  return (
    <View style={StyleSheet.absoluteFill}>
      <Map style={StyleSheet.absoluteFill} mapStyle={CONFIG.mapStyle} androidView="texture" compass={false} logo={false} attribution={false}>
        <Camera
          initialViewState={{ center: position ?? [2.35, 48.86], zoom: 15 }}
          trackUserLocation={nav ? 'course' : 'default'}
          pitch={nav ? 55 : 0}
          zoom={nav ? 16 : 14}
        />
        <GeoJSONSource id="car-route" data={route}>
          <Layer type="line" id="car-route-casing" paint={{ 'line-color': '#0a4a3e', 'line-width': 11 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="car-route-line" paint={{ 'line-color': '#17a589', 'line-width': 7 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        </GeoJSONSource>
        <GeoJSONSource id="car-chargers" data={chargers}>
          <Layer type="circle" id="car-chargers-dot" paint={{ 'circle-radius': 9, 'circle-color': '#f1c40f', 'circle-stroke-color': '#0a4a3e', 'circle-stroke-width': 3 }} />
        </GeoJSONSource>
        <NativeUserLocation mode={nav ? 'course' : 'default'} />
      </Map>
      {planning ? <View style={styles.badge}><Text style={styles.badgeText}>{planning}</Text></View> : null}
    </View>
  );
}

// Écran du tableau de bord (CarPlay) et du combiné d'instruments : la prochaine consigne en grand.
function CarInstruction(_: RootComponentInitialProps) {
  const { nav } = useCar();
  const step = nav?.steps[nav.stepIdx];
  return (
    <View style={styles.cluster}>
      <Text style={styles.clusterDist}>{step ? fmtDist(nav!.stepDist) : ''}</Text>
      <Text style={styles.clusterText} numberOfLines={3}>{step ? step.text : 'Copilote GPS'}</Text>
    </View>
  );
}

// ---------- manœuvres et estimations envoyées à la voiture ----------
const TURN: Record<string, [TurnType, Glyph]> = {
  'slight left': [TurnType.SlightLeft, 'turn_slight_left'], 'slight right': [TurnType.SlightRight, 'turn_slight_right'],
  left: [TurnType.NormalLeft, 'turn_left'], right: [TurnType.NormalRight, 'turn_right'],
  'sharp left': [TurnType.SharpLeft, 'turn_sharp_left'], 'sharp right': [TurnType.SharpRight, 'turn_sharp_right'],
  uturn: [TurnType.UTurnLeft, 'u_turn_left'],
};

function toManeuver(step: Step, id: string, distM: number, timeS: number): RoutingManeuver {
  const base = {
    id, travelEstimates: estimates(distM, timeS), trafficSide: TrafficSide.Right, roadName: step.name ? [step.name] : undefined,
    attributedInstructionVariants: [{ text: step.text }], cardBackgroundColor: '#0a4a3e', type: 'routing' as const,
  };
  const mod = step.maneuver.modifier ?? '';
  const right = mod.includes('right');
  switch (step.maneuver.type) {
    case 'depart': return { ...base, maneuverType: ManeuverType.Depart, symbolImage: icon('navigation') };
    case 'arrive': return { ...base, maneuverType: ManeuverType.Arrive, symbolImage: icon('flag') };
    case 'waypoint': return { ...base, maneuverType: ManeuverType.Arrive, symbolImage: icon('ev_station') };
    case 'roundabout': case 'exit roundabout':
      return { ...base, maneuverType: ManeuverType.Roundabout, exitNumber: step.maneuver.exit, symbolImage: icon('roundabout_right') };
    case 'on ramp':
      return { ...base, maneuverType: ManeuverType.OnRamp, onRampType: right ? OnRampType.NormalRight : OnRampType.NormalLeft, symbolImage: icon(right ? 'ramp_right' : 'ramp_left') };
    case 'off ramp':
      return { ...base, maneuverType: ManeuverType.OffRamp, offRampType: right ? OffRampType.NormalRight : OffRampType.NormalLeft, symbolImage: icon(right ? 'ramp_right' : 'ramp_left') };
    case 'fork':
      if (mod === 'straight') return { ...base, maneuverType: ManeuverType.Keep, keepType: KeepType.FollowRoad, symbolImage: icon('straight') };
      return { ...base, maneuverType: ManeuverType.Fork, forkType: right ? ForkType.Right : ForkType.Left, symbolImage: icon(right ? 'fork_right' : 'fork_left') };
    case 'merge': return { ...base, maneuverType: ManeuverType.Straight, symbolImage: icon('merge') };
    case 'turn': {
      const t = TURN[mod];
      if (t) return { ...base, maneuverType: ManeuverType.Turn, turnType: t[0], symbolImage: icon(t[1]) };
    }
  }
  return { ...base, maneuverType: ManeuverType.Straight, symbolImage: icon('straight') };
}

/** Étapes du voyage vues par la voiture : chaque borne de recharge restante, puis la destination. */
function tripPoints(n: CarNav): TripPoint[] {
  const pts: TripPoint[] = [];
  let m = 0, s = 0, waypointsSeen = 0;
  for (let i = 0; i < n.steps.length; i++) {
    const st = n.steps[i];
    if (st.maneuver.type === 'waypoint') waypointsSeen++;
    if (i < n.stepIdx) continue;
    if (st.maneuver.type === 'waypoint' && n.charge) {
      const c = n.charge.stops[waypointsSeen - 1];
      if (c) pts.push({ latitude: c.charger.coord[1], longitude: c.charger.coord[0], name: `⚡ ${c.charger.name}`, travelEstimates: estimates(m, s) });
      s += c?.chargeMin ? c.chargeMin * 60 : 0;
    }
    m += st.distance; s += st.duration;
  }
  // Le temps restant affiché comprend les recharges.
  pts.push({ latitude: n.dest.coord[1], longitude: n.dest.coord[0], name: n.dest.name, travelEstimates: estimates(n.remainingM, n.remainingS) });
  return pts;
}

function sync(map: MapTemplate) {
  let running: string | null = null;
  let lastStep = -1;
  return () => {
    const n = carBridge.get().nav;
    if (!n) {
      if (running) { running = null; lastStep = -1; map.stopNavigation(); }
      return;
    }
    const tripId = `${n.dest.name}-${n.route.distance}`;
    const steps = tripPoints(n);
    if (running !== tripId) {
      running = tripId;
      lastStep = -1;
      map.startNavigation({
        id: tripId,
        routeChoice: {
          id: tripId, summaryVariants: [n.dest.name], selectionSummaryVariants: [n.dest.label || n.dest.name],
          additionalInformationVariants: [n.charge ? `${n.charge.stops.length} arrêt(s) de recharge` : n.route.legs[0].summary || n.dest.name],
          steps,
        },
      }).catch(() => {});
    }
    const step = n.steps[n.stepIdx];
    const next = n.steps[n.stepIdx + 1];
    const timeToStep = Math.max(0, step.duration * (n.stepDist / Math.max(1, step.distance)));
    const list = [toManeuver(step, `${tripId}:${n.stepIdx}`, n.stepDist, timeToStep)];
    if (next && n.stepDist < 1000) list.push(toManeuver(next, `${tripId}:${n.stepIdx + 1}`, n.stepDist + next.distance, timeToStep + next.duration));
    map.updateManeuvers(list as AutoManeuver);
    map.updateTravelEstimates(steps);
    lastStep = n.stepIdx;
  };
}

// ---------- listes : destinations et signalements ----------
async function openDestinations() {
  const [settings, trips] = await Promise.all([store.getSettings(), store.getTrips()]);
  const items: { title: string; detail: string; glyph: Glyph; place: Place }[] = [];
  if (settings.home) items.push({ title: 'Maison', detail: settings.home.label, glyph: 'home', place: settings.home });
  if (settings.work) items.push({ title: 'Travail', detail: settings.work.label, glyph: 'work', place: settings.work });
  for (const p of predictDestinations(trips)) items.push({ title: p.name, detail: 'Trajet habituel', glyph: 'history', place: { ...p, label: p.name } });
  const go = (p: Place) => { HybridAutoPlay.popToRootTemplate().catch(() => {}); carBridge.controller()?.go(p); };
  const list = new ListTemplate({
    title: { text: 'Où allez-vous ?' },
    headerActions: { android: { startHeaderAction: { type: 'back', onPress: () => { HybridAutoPlay.popTemplate().catch(() => {}); } } } },
    sections: {
      type: 'default',
      items: items.length
        ? items.map((it) => ({ type: 'default' as const, title: { text: it.title }, detailedText: { text: it.detail }, image: icon(it.glyph), onPress: () => go(it.place) }))
        : [{ type: 'text' as const, title: { text: 'Enregistrez Maison et Travail dans l’application sur le téléphone' } }],
    },
  });
  list.push();
}

function openReport() {
  const types: AlertType[] = ['police', 'accident', 'bouchon', 'travaux', 'danger', 'ferme'];
  const list = new ListTemplate({
    title: { text: 'Signaler' },
    headerActions: { android: { startHeaderAction: { type: 'back', onPress: () => { HybridAutoPlay.popTemplate().catch(() => {}); } } } },
    sections: {
      type: 'default',
      items: types.map((t) => ({
        type: 'default' as const, title: { text: ALERT_LABEL[t] }, image: icon(ALERT_GLYPH[t]),
        onPress: () => { carBridge.controller()?.report(t); HybridAutoPlay.popTemplate().catch(() => {}); },
      })),
    },
  });
  list.push();
}

// ---------- enregistrement ----------
let alertId = 1;

export function registerCar() {
  setIconFont('material_icons', GLYPHS);
  let cleanup: (() => void)[] = [];

  HybridAutoPlay.addListener('didConnect', () => {
    startCarLocation();
    const map = new MapTemplate({
      component: CarMap,
      headerActions: {
        android: [
          { type: 'image', image: icon('search'), onPress: openDestinations },
          { type: 'image', image: icon('warning'), onPress: openReport },
        ],
        ios: {
          leadingNavigationBarButtons: [{ type: 'image', image: icon('search'), onPress: openDestinations }],
          trailingNavigationBarButtons: [{ type: 'image', image: icon('warning'), onPress: openReport }],
        },
      },
      onStopNavigation: () => carBridge.controller()?.stop(),
    });
    map.setRootTemplate();
    const update = sync(map);
    cleanup = [
      carBridge.subscribe(update),
      carBridge.onNotice((n) => map.showAlert({
        id: alertId++, title: { text: n.title }, subtitle: n.subtitle ? { text: n.subtitle } : undefined, durationMs: 6000, priority: 'medium',
        primaryAction: { title: 'OK', onPress: () => {} },
      })),
    ];
    update();
  });
  HybridAutoPlay.addListener('didDisconnect', () => { cleanup.forEach((c) => c()); cleanup = []; });

  AutoPlayCluster.setComponent(CarInstruction);
  if (Platform.OS === 'ios') CarPlayDashboard.setComponent(CarInstruction);
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: '#0a4a3e', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  badgeText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cluster: { flex: 1, backgroundColor: '#0a4a3e', justifyContent: 'center', padding: 16 },
  clusterDist: { color: '#fff', fontSize: 34, fontWeight: '700' },
  clusterText: { color: '#e8f6f3', fontSize: 20, marginTop: 6 },
});
