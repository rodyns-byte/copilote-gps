import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Camera, type CameraRef, GeoJSONSource, Layer, Map, Marker, NativeUserLocation, RasterSource } from '@maplibre/maplibre-react-native';

import { CONFIG } from './src/lib/config';
import { bbox, blur, circle, dist, distToLine, fmtDist, fmtDur, fmtTime } from './src/lib/geo';
import { parseLocal, parseWithClaude, type Command } from './src/lib/nlu';
import { type Avoid, lower, fetchRoutes, instruction, personalFactor, rankRoutes, type Route, type Step } from './src/lib/routing';
import { fetchIncidents, geocode, predictDestinations } from './src/lib/services';
import { type AlertType, DEFAULT_SETTINGS, type Place, type RoadAlert, type Settings, store, type Trip } from './src/lib/storage';
import { cellsAhead, cellsForBounds, loadZones } from './src/lib/radars';
import { type Fix, useLocation } from './src/hooks/useLocation';
import { useVoice } from './src/hooks/useVoice';
import { arrivalPct, LOW_BATTERY_PCT, readCarBattery } from './src/lib/vehicle';
import { type ChargePlan, planCharging, RESERVE_PCT, TARGET_PCT } from './src/lib/charging';
import { AlertSheet, ALERT_LABEL, ALERT_MI, CONTRAVENTION_ZONE_M } from './src/components/AlertSheet';
import { SettingsSheet } from './src/components/SettingsSheet';
import { carSnapshot, departureText, guide, type Guidance, inZone, newGuidance, remainingChargers, remainingSeconds, rerouted } from './src/lib/guidance';
import { carBridge } from './src/car/bridge';
import { C } from './src/components/theme';

type Nav = Guidance & { startedAt: number; predicted: number; dest: Place };
type IconName = keyof typeof MaterialIcons.glyphMap;

/** Icône de la manœuvre (Valhalla type + direction). */
function maneuverIcon(m: Step['maneuver']): IconName {
  const side = m.modifier?.includes('left') ? 'left' : 'right';
  switch (m.type) {
    case 'arrive': return 'flag';
    case 'waypoint': return 'ev-station';
    case 'depart': return 'navigation';
    case 'roundabout': case 'exit roundabout': return 'roundabout-right';
    case 'fork': return m.modifier === 'straight' ? 'straight' : `fork-${side}`;
    case 'on ramp': case 'off ramp': return m.modifier === 'straight' ? 'straight' : `ramp-${side}`;
    case 'merge': return 'merge';
    case 'turn':
      if (m.modifier === 'uturn') return 'u-turn-left';
      if (m.modifier?.startsWith('sharp')) return `turn-sharp-${side}`;
      if (m.modifier?.startsWith('slight')) return `turn-slight-${side}`;
      return `turn-${side}`;
    default: return 'straight';
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <GpsScreen />
    </SafeAreaProvider>
  );
}

function GpsScreen() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const camera = useRef<CameraRef>(null);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [osmZones, setOsmZones] = useState<RoadAlert[]>([]);
  const [follow, setFollow] = useState(true); // la carte suit la voiture pendant le guidage
  const [trips, setTrips] = useState<Trip[]>([]);
  const [userAlerts, setUserAlerts] = useState<RoadAlert[]>([]);
  const [incidents, setIncidents] = useState<RoadAlert[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [assistant, setAssistant] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [dest, setDest] = useState<Place | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [sel, setSel] = useState(0);
  const [avoid, setAvoid] = useState<Avoid>({ toll: false, motorway: false });
  const [nav, setNav] = useState<Nav | null>(null);
  const [charge, setCharge] = useState<ChargePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [is3d, setIs3d] = useState(false);
  const [sheet, setSheet] = useState<'settings' | 'alert' | null>(null);
  const [bounds, setBounds] = useState<[number, number, number, number] | null>(null);
  const [, force] = useState(0); // rafraîchit le bandeau de navigation

  const navRef = useRef<Nav | null>(null);
  navRef.current = nav;
  const fixRef = useRef<Fix | null>(null);

  const alerts = [...userAlerts.filter((a) => Date.now() - a.at < CONFIG.alertLifetimeMs), ...incidents, ...(settings.zones.osm ? osmZones : [])];
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  const showToast = useCallback((t: string) => { setToast(t); setTimeout(() => setToast(''), 3500); }, []);

  // ---------- chargement ----------
  useEffect(() => {
    store.getSettings().then(setSettings);
    store.getTrips().then(setTrips);
    store.getAlerts().then(setUserAlerts);
  }, []);

  // ---------- trafic TomTom (toutes les 2 min, si une clé est saisie) ----------
  useEffect(() => {
    if (!settings.tomtomKey || !bounds) return;
    const load = () => fetchIncidents(bounds, settings.tomtomKey).then(setIncidents).catch(() => {});
    const t = setTimeout(load, 1500);
    const i = setInterval(load, 120000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [settings.tomtomKey, bounds?.join()]);

  // ---------- zones de contravention (radars fixes OpenStreetMap) ----------
  const zonesKey = useRef('');
  function refreshZones(keys: string[]) {
    const k = keys.sort().join();
    if (!keys.length || k === zonesKey.current) return;
    zonesKey.current = k;
    loadZones(keys).then(setOsmZones).catch(() => {});
  }
  useEffect(() => {
    if (!settings.zones.osm || nav || !bounds) return;
    const t = setTimeout(() => refreshZones(cellsForBounds(bounds)), 1200);
    return () => clearTimeout(t);
  }, [settings.zones.osm, !!nav, bounds?.join()]);
  useEffect(() => {
    if (!settings.zones.osm || !nav) return;
    const load = () => {
      const n = navRef.current, f = fixRef.current;
      if (n && f) refreshZones(cellsAhead(f.coord, n.route.geometry.coordinates, distToLine(f.coord, n.route.geometry.coordinates).i));
    };
    load();
    const i = setInterval(load, 30e3);
    return () => clearInterval(i);
  }, [settings.zones.osm, !!nav]);

  // ---------- batterie de la voiture (lue toutes les 5 min pendant la navigation si la voiture est connectée) ----------
  const vehicle = settings.vehicle;
  async function refreshBattery(silent = true) {
    const v = settingsRef.current.vehicle;
    if (!v?.smartcarToken) return;
    try {
      const pct = await readCarBattery(v);
      const s = { ...settingsRef.current, vehicle: { ...v, batteryPct: pct, updatedAt: Date.now(), source: 'voiture' as const } };
      setSettings(s); store.setSettings(s);
    } catch (e) { if (!silent) showToast((e as Error).message); }
  }
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!nav || !vehicle?.smartcarToken) return;
    const i = setInterval(refreshBattery, 5 * 60e3);
    return () => clearInterval(i);
  }, [!!nav, vehicle?.smartcarToken]);

  // ---------- voix ----------
  const voice = useVoice((text) => { setQuery(text); handleCommand(text); });
  const say = voice.say;
  const assistantSays = (t: string) => { setAssistant(t); if (t) say(t); };

  // ---------- position + guidage ----------
  const { fix, denied } = useLocation((f) => {
    const first = !fixRef.current;
    fixRef.current = f;
    if (first) camera.current?.jumpTo({ center: f.coord, zoom: 15 });
    if (navRef.current) navTick(f);
    else carBridge.publish({ position: f.coord });
  });

  function navTick(f: Fix) {
    const n = navRef.current!;
    for (const ev of guide(n, f, alertsRef.current, settingsRef.current.vehicle, settingsRef.current.zones)) {
      if (ev.type === 'reroute') { reroute(); return; }
      if (ev.type === 'arrive') { finishNav(); return; }
      if (ev.type === 'say') say(ev.text);
      if (ev.type === 'charger') { say(ev.text); carBridge.notice({ title: ev.stop.charger.name, subtitle: `Rechargez jusqu'à ${ev.stop.departPct} %` }); }
      if (ev.type === 'alert') { showToast(ev.text); if (ev.spoken) say(ev.spoken); carBridge.notice({ title: ev.text }); }
    }
    carBridge.publish({ nav: carSnapshot(n, n.dest, f.coord, personalFactor(trips), settingsRef.current.vehicle), position: f.coord });
    if (followRef.current) followCar(f, 1000);
    force((x) => x + 1);
  }
  const is3dRef = useRef(is3d);
  is3dRef.current = is3d;
  const followRef = useRef(follow);
  followRef.current = follow;

  /**
   * La caméra suit la voiture, orientée dans le sens de la marche, avec la position en bas de l'écran
   * (marge haute) pour voir loin devant. Animation linéaire d'une position GPS à la suivante : mouvement continu.
   */
  function followCar(f: Fix, duration: number) {
    const zoom = f.speed > 30 ? 15 : f.speed > 17 ? 16 : 17;
    camera.current?.easeTo({ center: f.coord, bearing: f.heading, pitch: is3dRef.current ? 55 : 0, zoom, duration, easing: 'linear',
      padding: { top: height * 0.45, left: 0, right: 0, bottom: 0 } });
  }
  function recenter() {
    setFollow(true); followRef.current = true;
    if (fixRef.current) followCar(fixRef.current, 600);
  }
  function overview() {
    const n = navRef.current, f = fixRef.current;
    if (!n || !f) return;
    setFollow(false); followRef.current = false;
    const line = n.route.geometry.coordinates;
    const [w, s, e, no] = bbox([f.coord, ...line.slice(distToLine(f.coord, line).i)]);
    camera.current?.fitBounds([w, s, e, no], { padding: { top: 220, bottom: 200, left: 50, right: 50 }, bearing: 0, pitch: 0, duration: 800 });
  }

  // ---------- commandes (texte ou voix) ----------
  async function handleCommand(text: string) {
    if (!text.trim()) return;
    setResults([]);
    let cmd: Command | null = null;
    if (settings.claudeKey) {
      try { cmd = await parseWithClaude(text, settings.claudeKey); } catch { /* repli sur l'analyse locale */ }
    }
    cmd ??= parseLocal(text);

    if (cmd.intent === 'stop') { stopNav(); return assistantSays('Navigation arrêtée.'); }
    if (cmd.intent === 'report' && cmd.report) return addAlert(cmd.report);
    if (cmd.intent === 'unknown') return assistantSays(cmd.reply || "Je n'ai pas compris la destination. Essayez « emmène-moi à Lyon ».");

    const nextAvoid = { toll: cmd.avoid.toll, motorway: cmd.avoid.motorway };
    setAvoid(nextAvoid);
    let target: Place | null = null;
    if (cmd.place) {
      target = settings[cmd.place];
      if (!target) {
        setSheet('settings');
        return assistantSays(`Indiquez d'abord votre adresse ${cmd.place === 'home' ? 'de domicile' : 'de travail'} dans les réglages.`);
      }
    } else if (cmd.destination) {
      try {
        const r = await geocode(cmd.destination, fixRef.current?.coord ?? null, 1);
        if (!r.length) return assistantSays(`Je ne trouve pas « ${cmd.destination} ».`);
        target = r[0];
      } catch { return assistantSays('Recherche impossible sans connexion. Choisissez un lieu enregistré.'); }
    }
    if (!target) return;
    const opts = [nextAvoid.toll && 'sans péage', nextAvoid.motorway && 'sans autoroute'].filter(Boolean).join(' et ');
    assistantSays(cmd.reply || `Je prépare l'itinéraire vers ${target.name}${opts ? ', ' + opts : ''}.`);
    planTo(target, nextAvoid);
  }

  // ---------- recherche au clavier ----------
  useEffect(() => {
    if (query.trim().length < 3 || voice.listening) { setResults([]); return; }
    const t = setTimeout(() => geocode(query, fixRef.current?.coord ?? null).then(setResults).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [query]);

  // ---------- itinéraires ----------
  async function planTo(target: Place, av: Avoid = avoid): Promise<Route | null> {
    const f = fixRef.current;
    if (!f) { showToast('En attente de la position GPS…'); return null; }
    setDest(target);
    setResults([]);
    setCharge(null);
    setBusy(true);
    try {
      const { routes: rs, avoidIgnored } = await fetchRoutes([f.coord, target.coord], av);
      if (avoidIgnored) showToast('Aucun trajet sans péage trouvé : cet itinéraire en contient.');
      const best = rankRoutes(rs, alertsRef.current, personalFactor(trips));
      setRoutes(rs);
      setSel(best);
      const [w, s, e, n] = bbox(rs[best].geometry.coordinates);
      camera.current?.fitBounds([w, s, e, n], { padding: { top: 140, bottom: 320, left: 40, right: 40 }, duration: 800 });
      return rs[best];
    } catch (e) {
      showToast(e instanceof TypeError ? "Pas de connexion : le calcul d'itinéraire a besoin d'Internet." : (e as Error).message);
      return null;
    } finally { setBusy(false); }
  }

  function clearRoute() {
    setRoutes([]); setDest(null); setAssistant(''); setCharge(null);
  }

  // ---------- arrêts de recharge ----------
  async function planStops(target = dest): Promise<ChargePlan | null> {
    const f = fixRef.current, v = settingsRef.current.vehicle;
    if (!f || !target || !v) return null;
    setPlanning(true);
    carBridge.publish({ planning: 'Recherche des bornes de recharge…' });
    try {
      const plan = await planCharging(f.coord, target.coord, v, avoid);
      if (!plan) { showToast("Pas besoin de recharger : la batterie suffit."); return null; }
      setCharge(plan);
      setRoutes([plan.route]); setSel(0);
      const n = plan.stops.length;
      say(`${n} arrêt${n > 1 ? 's' : ''} de recharge, environ ${Math.round(plan.totalChargeMin)} minutes de recharge au total.`);
      const [w, s, e, no] = bbox(plan.route.geometry.coordinates);
      camera.current?.fitBounds([w, s, e, no], { padding: { top: 140, bottom: 380, left: 40, right: 40 }, duration: 800 });
      return plan;
    } catch (e) {
      showToast(e instanceof TypeError ? 'Connexion nécessaire pour chercher les bornes.' : (e as Error).message);
      return null;
    } finally { setPlanning(false); carBridge.publish({ planning: null }); }
  }

  function startNav(route = routes[sel], plan = charge, target = dest) {
    if (!route || !target) return;
    const n: Nav = { ...newGuidance(route, plan), startedAt: Date.now(), predicted: route.duration, dest: target };
    setNav(n); navRef.current = n;
    setRoutes([route]); setSel(0); setIs3d(true); is3dRef.current = true; setFollow(true); followRef.current = true;
    activateKeepAwakeAsync().catch(() => {});
    refreshBattery();
    say(departureText(n));
    if (fixRef.current) navTick(fixRef.current);
  }

  /** Demandé depuis l'écran de la voiture : trajet, recharges si nécessaire, puis départ. */
  async function goFromCar(target: Place) {
    if (navRef.current) stopNav();
    carBridge.publish({ planning: `Calcul de l'itinéraire vers ${target.name}…` });
    try {
      const route = await planTo(target);
      if (!route) return;
      const v = settingsRef.current.vehicle;
      const plan = v && arrivalPct(route.legs.flatMap((l) => l.steps), v) < RESERVE_PCT ? await planStops(target) : null;
      startNav(plan ? plan.route : route, plan, target);
    } finally { carBridge.publish({ planning: null }); }
  }
  const carRef = useRef({ goFromCar, stop: () => { logTrip(false); stopNav(); }, addAlert });
  carRef.current = { goFromCar, stop: () => { logTrip(false); stopNav(); }, addAlert };
  useEffect(() => {
    carBridge.setPhoneController({
      go: (p) => carRef.current.goFromCar(p),
      stop: () => carRef.current.stop(),
      report: (t) => carRef.current.addAlert(t),
    });
    return () => carBridge.setPhoneController(null);
  }, []);

  async function reroute() {
    const n = navRef.current, f = fixRef.current;
    if (!n || !f) return;
    n.rerouting = true;
    say("Recalcul de l'itinéraire");
    try {
      // Avec un plan de recharge, on repasse par les bornes qui restent.
      const { routes: rs } = await fetchRoutes([f.coord, ...remainingChargers(n), n.dest.coord], avoid);
      const r = rs[rankRoutes(rs, alertsRef.current, personalFactor(trips))];
      rerouted(n, r);
      setRoutes([r]);
    } catch { showToast('Recalcul impossible pour le moment.'); }
    n.rerouting = false;
  }

  async function logTrip(complete: boolean) {
    const n = navRef.current;
    if (!n) return;
    const started = new Date(n.startedAt);
    const t: Trip = { name: n.dest.name, coord: n.dest.coord, at: n.startedAt, hour: started.getHours(), dow: started.getDay(),
      ...(complete ? { predicted: n.predicted, actual: (Date.now() - n.startedAt) / 1000 } : {}) };
    await store.addTrip(t);
    setTrips((x) => [...x, t]);
  }

  function finishNav() { logTrip(true); say('Vous êtes arrivé à destination.'); carBridge.notice({ title: 'Vous êtes arrivé' }); stopNav(); }
  function stopNav() {
    setNav(null); navRef.current = null; clearRoute(); setIs3d(false);
    carBridge.publish({ nav: null });
    deactivateKeepAwake();
    if (fixRef.current) camera.current?.easeTo({ center: fixRef.current.coord, pitch: 0, bearing: 0, zoom: 15, duration: 600,
      padding: { top: 0, left: 0, right: 0, bottom: 0 } });
  }

  // ---------- signalements ----------
  async function addAlert(type: AlertType) {
    const f = fixRef.current;
    setSheet(null);
    if (!f) return showToast('Position inconnue : signalement impossible.');
    const coord = type === 'police' ? blur(f.coord, CONTRAVENTION_ZONE_M / 2) : f.coord; // zone, pas d'emplacement exact
    const next = [...userAlerts, { id: 'u' + Date.now(), type, coord, at: Date.now(), source: 'vous' }];
    setUserAlerts(next);
    store.setAlerts(next);
    showToast(`${ALERT_LABEL[type]} signalé. Merci !`);
    say(`${ALERT_LABEL[type]} signalé`);
    // Étape serveur : envoyer le signalement pour le partager avec les autres conducteurs.
  }

  // ---------- rendu ----------
  const preds = predictDestinations(trips).filter((p) => p.score > 0.5);
  const chips: { label: string; icon: IconName; place: Place }[] = [];
  if (preds[0]?.score > 3) chips.push({ label: `${preds[0].name}`, icon: 'auto-awesome', place: { ...preds[0], label: preds[0].name } });
  if (settings.home) chips.push({ label: 'Maison', icon: 'home', place: settings.home });
  if (settings.work) chips.push({ label: 'Travail', icon: 'work', place: settings.work });
  preds.slice(preds[0]?.score > 3 ? 1 : 0).forEach((p) => chips.push({ label: p.name, icon: 'history', place: { ...p, label: p.name } }));

  const routeFeatures: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: routes.map((r, i) => ({ type: 'Feature', geometry: r.geometry, properties: { idx: i, sel: i === sel } })),
  };

  const zones = alerts.filter((a) => a.type === 'police');
  const zoneFeatures: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: settings.zones.show ? zones.map((a) => ({
      type: 'Feature', geometry: { type: 'Polygon', coordinates: [circle(a.coord, CONTRAVENTION_ZONE_M)] }, properties: {} })) : [],
  };
  const inside = !!fix && settings.zones.show && inZone(fix.coord, zones);
  const batteryText = (steps: Step[]) => {
    if (!vehicle) return '';
    const pct = arrivalPct(steps, vehicle);
    return pct <= 0 ? 'Recharge nécessaire' : `${Math.round(pct)} % à l'arrivée`;
  };

  const step = nav ? nav.steps[nav.stepIdx] : null;
  const next = nav ? nav.steps[nav.stepIdx + 1] : null;
  const stepDist = step && fix ? dist(fix.coord, step.maneuver.location) : 0;
  const remaining = nav ? remainingSeconds(nav, personalFactor(trips)) : 0;
  const remainingM = nav ? nav.steps.slice(nav.stepIdx).reduce((s, x) => s + x.distance, 0) : 0;
  const bottomCard = insets.bottom + 108;
  const fastest = routes.length ? routes.reduce((b, r, i) => (r.eta < routes[b].eta ? i : b), 0) : 0;

  return (
    <View style={styles.root}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={CONFIG.mapStyle}
        compass={false}
        attributionPosition={{ bottom: 8, left: 8 }}
        onRegionWillChange={(e) => { if (navRef.current && e.nativeEvent.userInteraction) { setFollow(false); followRef.current = false; } }}
        onRegionDidChange={(e) => {
          const b = e.nativeEvent.bounds;
          setBounds([b[0], b[1], b[2], b[3]]);
        }}
      >
        <Camera ref={camera} initialViewState={{ center: [2.35, 48.86], zoom: 12 }} />
        {settings.tomtomKey ? (
          <RasterSource id="traffic" tileSize={256}
            tiles={[`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${settings.tomtomKey}`]}>
            <Layer type="raster" id="traffic" paint={{ 'raster-opacity': 0.75 }} />
          </RasterSource>
        ) : null}
        <GeoJSONSource id="zones" data={zoneFeatures}>
          <Layer type="fill" id="zones-fill" paint={{ 'fill-color': C.warn, 'fill-opacity': 0.16 }} />
          <Layer type="line" id="zones-line" paint={{ 'line-color': C.warn, 'line-width': 2.5, 'line-dasharray': [2, 1.5] }} />
        </GeoJSONSource>
        <GeoJSONSource id="routes" data={routeFeatures}>
          <Layer type="line" id="routes-alt" filter={['!=', ['get', 'sel'], true]}
            paint={{ 'line-color': C.alt, 'line-width': 7, 'line-opacity': 0.9 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="routes-casing" filter={['==', ['get', 'sel'], true]}
            paint={{ 'line-color': C.routeCasing, 'line-width': 12 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="routes-sel" filter={['==', ['get', 'sel'], true]}
            paint={{ 'line-color': C.route, 'line-width': 8 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        </GeoJSONSource>
        {alerts.filter((a) => a.type !== 'police').map((a) => (
          <Marker key={a.id} id={a.id} lngLat={a.coord}>
            <View style={[styles.pin, { backgroundColor: ALERT_MI[a.type].color }]}><MaterialIcons name={ALERT_MI[a.type].icon} size={18} color="#fff" /></View>
          </Marker>
        ))}
        {charge?.stops.map((s, i) => (
          <Marker key={'c' + i} id={'charge' + i} lngLat={s.charger.coord}>
            <View style={[styles.pin, { backgroundColor: '#1971c2' }]}><MaterialIcons name="ev-station" size={18} color="#fff" /></View>
          </Marker>
        ))}
        {dest ? (
          <Marker id="dest" lngLat={dest.coord} anchor="bottom">
            <MaterialIcons name="place" size={44} color={C.danger} style={styles.destPin} />
          </Marker>
        ) : null}
        {fix ? <NativeUserLocation mode={nav ? 'course' : 'default'} /> : null}
      </Map>

      {/* Recherche */}
      {!nav ? (
        <View style={[styles.top, { top: insets.top + 10 }]}>
          <View style={styles.searchBar}>
            <MaterialIcons name="search" size={24} color={C.muted} />
            <TextInput
              style={styles.search}
              placeholder="Où allez-vous ?"
              placeholderTextColor={C.muted}
              value={voice.listening ? voice.partial : query}
              onChangeText={setQuery}
              onSubmitEditing={() => handleCommand(query)}
              returnKeyType="go"
            />
            {query && !voice.listening ? (
              <Pressable hitSlop={10} onPress={() => { setQuery(''); setResults([]); }}><MaterialIcons name="close" size={22} color={C.muted} /></Pressable>
            ) : null}
            <Pressable onPress={voice.listen} style={[styles.mic, voice.listening && { backgroundColor: C.danger }]} accessibilityLabel="Parler à l'assistant">
              <MaterialIcons name={voice.listening ? 'stop' : 'mic'} size={22} color={voice.listening ? '#fff' : C.accent} />
            </Pressable>
            <Pressable onPress={() => setSheet('settings')} style={styles.mic} accessibilityLabel="Réglages">
              <MaterialIcons name="settings" size={22} color={C.fg} />
            </Pressable>
          </View>
          {results.length ? (
            <View style={styles.card}>
              {results.map((r, i) => (
                <Pressable key={i} style={({ pressed }) => [styles.result, pressed && { backgroundColor: C.surface }]} onPress={() => planTo(r)}>
                  <View style={styles.resultIcon}><MaterialIcons name="place" size={20} color={C.accent} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultName} numberOfLines={1}>{r.name}</Text>
                    <Text style={styles.muted} numberOfLines={1}>{r.label}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
          {assistant ? <Bubble icon="auto-awesome" text={assistant} /> : null}
          {voice.error ? <Bubble icon="mic-off" text={voice.error} /> : null}
          {denied ? <Bubble icon="location-off" text="Autorisez la localisation dans les réglages du téléphone pour utiliser le GPS." /> : null}
          {!routes.length && !results.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {chips.length ? chips.map((c, i) => (
                <Pressable key={i} style={styles.chip} onPress={() => planTo(c.place)}>
                  <MaterialIcons name={c.icon} size={18} color={C.accent} /><Text style={styles.chipText} numberOfLines={1}>{c.label}</Text>
                </Pressable>
              )) : (
                <Pressable style={styles.chip} onPress={() => setSheet('settings')}>
                  <MaterialIcons name="home" size={18} color={C.accent} /><Text style={styles.chipText}>Enregistrer Maison et Travail</Text>
                </Pressable>
              )}
            </ScrollView>
          ) : null}
          {inside ? <ZoneBanner /> : null}
        </View>
      ) : null}

      {/* Boutons de carte */}
      {!routes.length || nav ? (
        <View style={[styles.fabs, { bottom: nav ? bottomCard + 16 : insets.bottom + 24 }]}>
          <Fab icon={is3d ? 'map' : 'view-in-ar'} label={is3d ? '2D' : '3D'} onPress={() => {
            const on = !is3d; setIs3d(on); is3dRef.current = on;
            camera.current?.setStop({ pitch: on ? 55 : 0, duration: 600 });
          }} />
          {!nav ? <Fab icon="my-location" onPress={() => fix && camera.current?.easeTo({ center: fix.coord, zoom: 16, duration: 500 })} /> : null}
          {!nav ? <Fab icon="report" color={C.warn} onPress={() => setSheet('alert')} /> : null}
        </View>
      ) : null}

      {/* Choix d'itinéraire */}
      {routes.length && !nav ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}>
          <View style={styles.handle} />
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.destName} numberOfLines={1}>{dest?.name}</Text>
              <Text style={styles.muted} numberOfLines={1}>{dest?.label}</Text>
            </View>
            <Pressable style={styles.iconBtn} onPress={clearRoute} accessibilityLabel="Annuler"><MaterialIcons name="close" size={22} color={C.fg} /></Pressable>
          </View>
          <ScrollView style={{ maxHeight: 230 }} contentContainerStyle={{ gap: 8 }}>
            {routes.map((r, i) => {
              const steps = r.legs.flatMap((l) => l.steps);
              const low = vehicle && !charge && arrivalPct(steps, vehicle) < LOW_BATTERY_PCT;
              return (
                <Pressable key={i} style={[styles.route, i === sel && styles.routeSel]} onPress={() => setSel(i)}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={styles.rowCenter}>
                      <Text style={[styles.routeMain, i === sel && { color: C.accent }]}>{fmtDur(r.eta)}</Text>
                      <Text style={styles.routeDist}>{fmtDist(r.distance)}</Text>
                      {i === fastest && routes.length > 1 ? <Text style={styles.tag}>Le plus rapide</Text> : null}
                      {r.hasToll ? <Text style={[styles.tag, styles.tagGrey]}>Péage</Text> : null}
                    </View>
                    <Text style={styles.muted} numberOfLines={1}>
                      Arrivée {fmtTime(new Date(Date.now() + r.eta * 1000))}{r.legs[0].summary ? ` · via ${r.legs[0].summary}` : ''}
                    </Text>
                    {r.hazards.length ? <Text style={[styles.muted, { color: C.warn }]}>{r.hazards.length} signalement(s) sur le trajet</Text> : null}
                  </View>
                  {charge || vehicle ? (
                    <View style={styles.batt}>
                      <MaterialIcons name={low ? 'battery-alert' : 'battery-charging-full'} size={18} color={low ? C.danger : C.accent} />
                      <Text style={[styles.battText, low && { color: C.danger }]}>
                        {charge ? `${Math.round(charge.arrivalPct)} %` : batteryText(steps).replace(" à l'arrivée", '')}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
          {charge ? (
            <View style={styles.chargeBox}>
              <View style={styles.rowCenter}>
                <MaterialIcons name="ev-station" size={20} color="#1971c2" />
                <Text style={styles.chargeTitle}>{charge.stops.length} arrêt{charge.stops.length > 1 ? 's' : ''} de recharge · {fmtDur(charge.totalChargeMin * 60)} de charge</Text>
              </View>
              {charge.stops.map((s, i) => (
                <Text key={i} style={styles.muted} numberOfLines={1}>
                  {i + 1}. {s.charger.name} · km {Math.round(s.kmFromStart)} · {Math.round(s.arrivalPct)} % → {s.departPct} % en {Math.round(s.chargeMin)} min{s.charger.powerKw ? ` (${Math.round(s.charger.powerKw)} kW)` : ''}
                </Text>
              ))}
            </View>
          ) : vehicle && routes[sel] && arrivalPct(routes[sel].legs.flatMap((l) => l.steps), vehicle) < RESERVE_PCT ? (
            <Pressable style={styles.chargeBtn} onPress={() => planStops()} disabled={planning}>
              {planning ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="ev-station" size={20} color="#fff" />}
              <Text style={styles.primaryText}>{planning ? 'Recherche des bornes…' : `Planifier les recharges (charge à ${TARGET_PCT} %)`}</Text>
            </Pressable>
          ) : null}
          <View style={styles.row}>
            <Toggle icon="money-off" label="Sans péage" on={avoid.toll} onPress={() => { const a = { ...avoid, toll: !avoid.toll }; setAvoid(a); dest && planTo(dest, a); }} />
            <Toggle icon="add-road" label="Sans autoroute" on={avoid.motorway} onPress={() => { const a = { ...avoid, motorway: !avoid.motorway }; setAvoid(a); dest && planTo(dest, a); }} />
          </View>
          <Pressable style={({ pressed }) => [styles.start, pressed && { opacity: 0.85 }]} onPress={() => startNav()}>
            <MaterialIcons name="navigation" size={24} color="#fff" />
            <Text style={styles.startText}>Démarrer</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Guidage */}
      {nav && step ? (
        <>
          <View style={[styles.navTopWrap, { top: insets.top + 8 }]}>
            <View style={styles.maneuver}>
              <View style={styles.maneuverMain}>
                <MaterialIcons name={maneuverIcon(step.maneuver)} size={58} color="#fff" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.navDist}>{fmtDist(stepDist)}</Text>
                  <Text style={styles.navText} numberOfLines={2}>{instruction(step)}</Text>
                </View>
              </View>
              {next ? (
                <View style={styles.thenRow}>
                  <Text style={styles.thenText}>Puis</Text>
                  <MaterialIcons name={maneuverIcon(next.maneuver)} size={20} color="#cfe9e1" />
                  <Text style={styles.thenText} numberOfLines={1}>{next.name || lower(instruction(next))}</Text>
                </View>
              ) : null}
            </View>
            {inside ? <ZoneBanner /> : null}
          </View>

          {fix ? (
            <View style={[styles.speed, { bottom: bottomCard + 16 }]}>
              <Text style={styles.speedNum}>{Math.round(fix.speed * 3.6)}</Text>
              <Text style={styles.speedUnit}>km/h</Text>
            </View>
          ) : null}
          {!follow ? (
            <Pressable style={[styles.recenter, { bottom: bottomCard + 16 }]} onPress={recenter}>
              <MaterialIcons name="navigation" size={20} color={C.accent} />
              <Text style={styles.recenterText}>Recentrer</Text>
            </Pressable>
          ) : null}

          <View style={[styles.navBottom, { paddingBottom: insets.bottom + 12 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.navEta}>{fmtDur(remaining)}</Text>
              <Text style={styles.navSub}>{fmtDist(remainingM)} · {fmtTime(new Date(Date.now() + remaining * 1000))}</Text>
              {nav.charge ? (
                <Text style={styles.navBatt}>{Math.round(nav.charge.arrivalPct)} % à l'arrivée · {nav.charge.stops.length - nav.stopsDone} recharge(s)</Text>
              ) : vehicle ? <Text style={styles.navBatt}>{batteryText(nav.steps.slice(nav.stepIdx))}</Text> : null}
            </View>
            <IconBtn icon={voice.isMuted ? 'volume-off' : 'volume-up'} onPress={voice.toggleMute} />
            <IconBtn icon="report" color={C.warn} onPress={() => setSheet('alert')} />
            <IconBtn icon="alt-route" onPress={overview} />
            <IconBtn icon="close" color="#fff" bg={C.danger} onPress={() => { logTrip(false); stopNav(); }} />
          </View>
        </>
      ) : null}

      {busy ? (
        <View style={[styles.busy, { top: insets.top + 74 }]}>
          <ActivityIndicator color={C.accent} /><Text style={styles.text}>Calcul de l'itinéraire…</Text>
        </View>
      ) : null}
      {toast ? <View style={[styles.toast, { bottom: (nav ? bottomCard : insets.bottom) + 90 }]}><Text style={styles.toastText}>{toast}</Text></View> : null}

      <SettingsSheet
        visible={sheet === 'settings'}
        settings={settings}
        bounds={bounds}
        near={fix?.coord ?? null}
        onClose={(s) => { setSheet(null); if (s) { setSettings(s); store.setSettings(s); zonesKey.current = ''; } }}
      />
      <AlertSheet visible={sheet === 'alert'} onPick={addAlert} onClose={() => setSheet(null)} />
    </View>
  );
}

function ZoneBanner() {
  return (
    <View style={styles.zone}>
      <MaterialIcons name="speed" size={22} color="#fff" />
      <View style={{ flex: 1 }}>
        <Text style={styles.zoneTitle}>Zone de contravention</Text>
        <Text style={styles.zoneSub}>Respectez les limitations de vitesse</Text>
      </View>
    </View>
  );
}

function Bubble({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.assistant}>
      <MaterialIcons name={icon} size={20} color={C.accent} />
      <Text style={[styles.text, { flex: 1 }]}>{text}</Text>
    </View>
  );
}

function Fab({ icon, label, onPress, color = C.fg }: { icon: IconName; label?: string; onPress: () => void; color?: string }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.fab, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={label}>
      {label ? <Text style={styles.fabText}>{label}</Text> : <MaterialIcons name={icon} size={24} color={color} />}
    </Pressable>
  );
}

function IconBtn({ icon, onPress, color = C.fg, bg = C.surface }: { icon: IconName; onPress: () => void; color?: string; bg?: string }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.iconBtn, { backgroundColor: bg }, pressed && { opacity: 0.7 }]} accessibilityRole="button">
      <MaterialIcons name={icon} size={24} color={color} />
    </Pressable>
  );
}

function Toggle({ icon, label, on, onPress }: { icon: IconName; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <MaterialIcons name={on ? 'check' : icon} size={18} color={on ? '#fff' : C.fg} />
      <Text style={[styles.toggleText, on && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

const shadow = { shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 };
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  text: { color: C.fg, fontSize: 15 },
  muted: { color: C.muted, fontSize: 13 },
  row: { flexDirection: 'row', gap: 10 },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  top: { position: 'absolute', left: 12, right: 12, gap: 10 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.bg, borderRadius: 28, height: 56, paddingLeft: 16, paddingRight: 6, ...shadow },
  search: { flex: 1, color: C.fg, fontSize: 17, height: '100%' },
  mic: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
  card: { backgroundColor: C.bg, borderRadius: 20, paddingVertical: 6, ...shadow },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  resultIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  resultName: { color: C.fg, fontWeight: '600', fontSize: 16 },
  assistant: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', backgroundColor: C.bg, borderRadius: 16, padding: 12, ...shadow },
  chips: { gap: 8, paddingVertical: 2, paddingRight: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.bg, borderRadius: 20, paddingHorizontal: 14, height: 38, maxWidth: 220, ...shadow },
  chipText: { color: C.fg, fontSize: 14, fontWeight: '600' },

  fabs: { position: 'absolute', right: 12, gap: 12 },
  fab: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', ...shadow },
  fabText: { fontSize: 16, color: C.fg, fontWeight: '800' },
  pin: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff', ...shadow },
  destPin: { textShadowColor: 'rgba(0,0,0,0.3)', textShadowRadius: 4 },

  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 16, paddingTop: 8, gap: 12, ...shadow },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.line },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  destName: { color: C.fg, fontSize: 20, fontWeight: '800' },
  route: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.surface, borderRadius: 16, padding: 14, borderWidth: 2, borderColor: 'transparent' },
  routeSel: { borderColor: C.accent, backgroundColor: C.accentSoft },
  routeMain: { color: C.fg, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  routeDist: { color: C.muted, fontSize: 15, fontWeight: '600' },
  tag: { fontSize: 11, fontWeight: '700', color: '#fff', backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  tagGrey: { backgroundColor: C.muted },
  batt: { alignItems: 'center', gap: 2 },
  battText: { color: C.fg, fontSize: 13, fontWeight: '700' },
  chargeBox: { backgroundColor: '#e7f1fb', borderRadius: 14, padding: 12, gap: 4 },
  chargeTitle: { color: C.fg, fontWeight: '700', fontSize: 15, flex: 1 },
  chargeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#1971c2', borderRadius: 14, padding: 13 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: C.surface, borderRadius: 14, paddingVertical: 11 },
  toggleOn: { backgroundColor: C.fg },
  toggleText: { color: C.fg, fontSize: 14, fontWeight: '600' },
  start: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.accent, borderRadius: 30, height: 58 },
  startText: { color: '#fff', fontSize: 19, fontWeight: '800' },

  navTopWrap: { position: 'absolute', left: 10, right: 10, gap: 8 },
  maneuver: { backgroundColor: C.nav, borderRadius: 22, overflow: 'hidden', ...shadow },
  maneuverMain: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  navDist: { color: '#fff', fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'] },
  navText: { color: '#e3f3ee', fontSize: 17, fontWeight: '600' },
  thenRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.navDark, paddingHorizontal: 16, paddingVertical: 8 },
  thenText: { color: '#cfe9e1', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  zone: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.warn, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, ...shadow },
  zoneTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  zoneSub: { color: '#fff4e0', fontSize: 13 },
  speed: { position: 'absolute', left: 12, width: 66, height: 66, borderRadius: 33, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', ...shadow },
  speedNum: { color: C.fg, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'], lineHeight: 26 },
  speedUnit: { color: C.muted, fontSize: 11, fontWeight: '600' },
  recenter: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.bg, borderRadius: 24,
    paddingHorizontal: 18, height: 46, ...shadow },
  recenterText: { color: C.accent, fontSize: 15, fontWeight: '800' },
  navBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.bg, flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingHorizontal: 16, paddingTop: 14, borderTopLeftRadius: 26, borderTopRightRadius: 26, ...shadow },
  navEta: { color: C.accent, fontSize: 26, fontWeight: '800', fontVariant: ['tabular-nums'] },
  navSub: { color: C.fg, fontSize: 14, fontWeight: '600' },
  navBatt: { color: C.muted, fontSize: 12 },
  iconBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },

  busy: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: C.bg, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, ...shadow },
  toast: { position: 'absolute', alignSelf: 'center', backgroundColor: 'rgba(18,26,24,0.92)', borderRadius: 20, paddingHorizontal: 18, paddingVertical: 11, maxWidth: '90%' },
  toastText: { color: '#fff', textAlign: 'center', fontSize: 15 },
});
