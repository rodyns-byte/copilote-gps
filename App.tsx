import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Camera, type CameraRef, GeoJSONSource, Layer, Map, Marker, NativeUserLocation, RasterSource } from '@maplibre/maplibre-react-native';

import { CONFIG } from './src/lib/config';
import { bbox, blur, circle, dist, distToLine, fmtDist, fmtDur, fmtTime } from './src/lib/geo';
import { parseLocal, parseWithClaude, type Command } from './src/lib/nlu';
import { ARROW, type Avoid, lower, fetchRoutes, instruction, personalFactor, rankRoutes, type Route, type Step } from './src/lib/routing';
import { fetchIncidents, geocode, predictDestinations } from './src/lib/services';
import { type AlertType, type Place, type RoadAlert, type Settings, store, type Trip } from './src/lib/storage';
import { type Fix, useLocation } from './src/hooks/useLocation';
import { useVoice } from './src/hooks/useVoice';
import { arrivalPct, LOW_BATTERY_PCT, readCarBattery } from './src/lib/vehicle';
import { type ChargePlan, planCharging, RESERVE_PCT, TARGET_PCT } from './src/lib/charging';
import { AlertSheet, ALERT_ICON, ALERT_LABEL, CONTRAVENTION_ZONE_M } from './src/components/AlertSheet';
import { SettingsSheet } from './src/components/SettingsSheet';
import { carSnapshot, departureText, guide, type Guidance, newGuidance, remainingChargers, remainingSeconds, rerouted } from './src/lib/guidance';
import { carBridge } from './src/car/bridge';
import { C } from './src/components/theme';

type Nav = Guidance & { startedAt: number; predicted: number; dest: Place };

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
  const camera = useRef<CameraRef>(null);

  const [settings, setSettings] = useState<Settings>({ home: null, work: null, claudeKey: '', tomtomKey: '', vehicle: null });
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

  const alerts = [...userAlerts.filter((a) => Date.now() - a.at < CONFIG.alertLifetimeMs), ...incidents];
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
    for (const ev of guide(n, f, alertsRef.current, settingsRef.current.vehicle)) {
      if (ev.type === 'reroute') { reroute(); return; }
      if (ev.type === 'arrive') { finishNav(); return; }
      if (ev.type === 'say') say(ev.text);
      if (ev.type === 'charger') { say(ev.text); carBridge.notice({ title: ev.stop.charger.name, subtitle: `Rechargez jusqu'à ${ev.stop.departPct} %` }); }
      if (ev.type === 'alert') { showToast(ev.text); say(ev.spoken); carBridge.notice({ title: ev.text }); }
    }
    carBridge.publish({ nav: carSnapshot(n, n.dest, f.coord, personalFactor(trips), settingsRef.current.vehicle), position: f.coord });
    // 5) la caméra suit
    camera.current?.easeTo({ center: f.coord, bearing: is3dRef.current ? f.heading : 0, pitch: is3dRef.current ? 60 : 0,
      zoom: f.speed > 25 ? 15 : 17, duration: 900, padding: { top: 0, left: 0, right: 0, bottom: 200 } });
    force((x) => x + 1);
  }
  const is3dRef = useRef(is3d);
  is3dRef.current = is3d;

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
    setRoutes([route]); setSel(0); setIs3d(true); is3dRef.current = true;
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
    if (fixRef.current) camera.current?.easeTo({ center: fixRef.current.coord, pitch: 0, bearing: 0, zoom: 15, duration: 600 });
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
  const chips: { label: string; place: Place }[] = [];
  if (preds[0]?.score > 3) chips.push({ label: `✨ ${preds[0].name} (habituel à cette heure)`, place: { ...preds[0], label: preds[0].name } });
  if (settings.home) chips.push({ label: '🏠 Maison', place: settings.home });
  if (settings.work) chips.push({ label: '💼 Travail', place: settings.work });
  preds.slice(preds[0]?.score > 3 ? 1 : 0).forEach((p) => chips.push({ label: `🕘 ${p.name}`, place: { ...p, label: p.name } }));

  const routeFeatures: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: routes.map((r, i) => ({ type: 'Feature', geometry: r.geometry, properties: { idx: i, sel: i === sel } })),
  };

  const zoneFeatures: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: alerts.filter((a) => a.type === 'police').map((a) => ({
      type: 'Feature', geometry: { type: 'Polygon', coordinates: [circle(a.coord, CONTRAVENTION_ZONE_M)] }, properties: {} })),
  };
  const batteryLine = (steps: Step[]) => {
    if (!vehicle) return '';
    const pct = arrivalPct(steps, vehicle);
    return pct <= 0 ? '🔋 recharge nécessaire' : `🔋 ${Math.round(pct)} % à l'arrivée`;
  };

  const step = nav ? nav.steps[nav.stepIdx] : null;
  const stepDist = step && fix ? dist(fix.coord, step.maneuver.location) : 0;
  const remaining = nav ? remainingSeconds(nav, personalFactor(trips)) : 0;

  return (
    <View style={styles.root}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={CONFIG.mapStyle}
        compass={false}
        attributionPosition={{ bottom: 8, left: 8 }}
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
        <GeoJSONSource id="routes" data={routeFeatures}>
          <Layer type="line" id="routes-alt" filter={['!=', ['get', 'sel'], true]}
            paint={{ 'line-color': C.alt, 'line-width': 6, 'line-opacity': 0.8 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="routes-casing" filter={['==', ['get', 'sel'], true]}
            paint={{ 'line-color': '#0a4a3e', 'line-width': 10 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="routes-sel" filter={['==', ['get', 'sel'], true]}
            paint={{ 'line-color': '#17a589', 'line-width': 6 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        </GeoJSONSource>
        <GeoJSONSource id="zones" data={zoneFeatures}>
          <Layer type="fill" id="zones-fill" paint={{ 'fill-color': '#e67e22', 'fill-opacity': 0.18 }} />
          <Layer type="line" id="zones-line" paint={{ 'line-color': '#e67e22', 'line-width': 2, 'line-dasharray': [2, 2] }} />
        </GeoJSONSource>
        {alerts.filter((a) => a.type !== 'police').map((a) => (
          <Marker key={a.id} id={a.id} lngLat={a.coord}>
            <Text style={styles.alertIcon}>{ALERT_ICON[a.type]}</Text>
          </Marker>
        ))}
        {charge?.stops.map((s, i) => (
          <Marker key={'c' + i} id={'charge' + i} lngLat={s.charger.coord} anchor="bottom">
            <Text style={styles.destPin}>⚡</Text>
          </Marker>
        ))}
        {dest ? (
          <Marker id="dest" lngLat={dest.coord} anchor="bottom">
            <Text style={styles.destPin}>📍</Text>
          </Marker>
        ) : null}
        {fix ? <NativeUserLocation mode={nav ? 'course' : 'default'} /> : null}
      </Map>

      {/* Barre du haut */}
      {!nav ? (
        <View style={[styles.top, { top: insets.top + 8 }]}>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.search}
              placeholder="Où allez-vous ? ou dites « rentre chez moi sans péage »"
              placeholderTextColor={C.muted}
              value={voice.listening ? voice.partial : query}
              onChangeText={setQuery}
              onSubmitEditing={() => handleCommand(query)}
              returnKeyType="go"
            />
            <RoundButton label={voice.listening ? '■' : '🎤'} active={voice.listening} onPress={voice.listen} />
          </View>
          {results.length ? (
            <View style={styles.card}>
              {results.map((r, i) => (
                <Pressable key={i} style={styles.result} onPress={() => planTo(r)}>
                  <Text style={styles.resultName}>{r.name}</Text>
                  <Text style={styles.muted} numberOfLines={1}>{r.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {assistant ? <View style={styles.assistant}><Text style={styles.text}>{assistant}</Text></View> : null}
          {voice.error ? <View style={styles.assistant}><Text style={styles.text}>{voice.error}</Text></View> : null}
          {denied ? <View style={styles.assistant}><Text style={styles.text}>Autorisez la localisation dans les réglages du téléphone pour utiliser le GPS.</Text></View> : null}
          {!routes.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {chips.length ? chips.map((c, i) => (
                <Pressable key={i} style={styles.chip} onPress={() => planTo(c.place)}><Text style={styles.text}>{c.label}</Text></Pressable>
              )) : (
                <Pressable style={styles.chip} onPress={() => setSheet('settings')}><Text style={styles.text}>⚙ Enregistrer Maison et Travail</Text></Pressable>
              )}
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      {/* Boutons de carte */}
      <View style={[styles.fabs, { bottom: insets.bottom + (routes.length || nav ? 240 : 32) }]}>
        <RoundButton label="◎" onPress={() => fix && camera.current?.easeTo({ center: fix.coord, zoom: 16, duration: 500 })} />
        <RoundButton label={is3d ? '2D' : '3D'} onPress={() => {
          const on = !is3d; setIs3d(on);
          camera.current?.setStop({ pitch: on ? 60 : 0, duration: 600 });
        }} />
        <RoundButton label="⚠" onPress={() => setSheet('alert')} />
        {!nav ? <RoundButton label="☰" onPress={() => setSheet('settings')} /> : null}
      </View>

      {/* Choix d'itinéraire */}
      {routes.length && !nav ? (
        <View style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
          {routes.map((r, i) => (
            <Pressable key={i} style={[styles.route, i === sel && styles.routeSel]} onPress={() => setSel(i)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.routeMain}>{fmtDur(r.eta)} · {fmtDist(r.distance)}</Text>
                <Text style={styles.muted} numberOfLines={1}>
                  via {r.legs[0].summary || `itinéraire ${i + 1}`}{r.hazards.length ? ` · ⚠ ${r.hazards.length} signalement(s)` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.muted}>Arrivée {fmtTime(new Date(Date.now() + r.eta * 1000))}</Text>
                {charge ? (
                  <Text style={styles.muted}>🔋 {Math.round(charge.arrivalPct)} % à l'arrivée</Text>
                ) : vehicle ? (
                  <Text style={[styles.muted, arrivalPct(r.legs.flatMap((l) => l.steps), vehicle) < LOW_BATTERY_PCT && styles.low]}>
                    {batteryLine(r.legs.flatMap((l) => l.steps))}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
          {charge ? (
            <View style={styles.chargeBox}>
              <Text style={styles.chargeTitle}>⚡ {charge.stops.length} arrêt{charge.stops.length > 1 ? 's' : ''} de recharge · {fmtDur(charge.totalChargeMin * 60)} de charge</Text>
              {charge.stops.map((s, i) => (
                <Text key={i} style={styles.muted} numberOfLines={1}>
                  {i + 1}. {s.charger.name} · km {Math.round(s.kmFromStart)} · {Math.round(s.arrivalPct)} % → {s.departPct} % en {Math.round(s.chargeMin)} min{s.charger.powerKw ? ` (${Math.round(s.charger.powerKw)} kW)` : ''}
                </Text>
              ))}
            </View>
          ) : vehicle && routes[sel] && arrivalPct(routes[sel].legs.flatMap((l) => l.steps), vehicle) < RESERVE_PCT ? (
            <Pressable style={[styles.btn, styles.chargeBtn]} onPress={() => planStops()} disabled={planning}>
              <Text style={styles.primaryText}>{planning ? 'Recherche des bornes…' : `⚡ Planifier les recharges (réserve ${RESERVE_PCT} %, charge à ${TARGET_PCT} %)`}</Text>
            </Pressable>
          ) : null}
          <View style={styles.row}>
            <Toggle label="Éviter les péages" on={avoid.toll} onPress={() => { const a = { ...avoid, toll: !avoid.toll }; setAvoid(a); dest && planTo(dest, a); }} />
            <Toggle label="Éviter les autoroutes" on={avoid.motorway} onPress={() => { const a = { ...avoid, motorway: !avoid.motorway }; setAvoid(a); dest && planTo(dest, a); }} />
          </View>
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.primary]} onPress={() => startNav()}><Text style={styles.primaryText}>Démarrer</Text></Pressable>
            <Pressable style={styles.btn} onPress={clearRoute}><Text style={styles.text}>Annuler</Text></Pressable>
          </View>
        </View>
      ) : null}

      {/* Bandeau de navigation */}
      {nav && step ? (
        <>
          <View style={[styles.navTop, { paddingTop: insets.top + 12 }]}>
            <Text style={styles.navArrow}>{step.maneuver.type === 'arrive' ? '⚑' : step.maneuver.type === 'waypoint' ? '⚡' : ARROW[step.maneuver.modifier ?? ''] ?? '↑'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.navDist}>{fmtDist(stepDist)}</Text>
              <Text style={styles.navText}>{instruction(step)}</Text>
            </View>
          </View>
          <View style={[styles.navBottom, { paddingBottom: insets.bottom + 14 }]}>
            <View>
              <Text style={styles.navEta}>{fmtDur(remaining)}</Text>
              <Text style={styles.muted}>Arrivée {fmtTime(new Date(Date.now() + remaining * 1000))}</Text>
              {nav.charge ? <Text style={styles.muted}>🔋 {Math.round(nav.charge.arrivalPct)} % à l'arrivée · ⚡ {nav.charge.stops.length - nav.stopsDone} arrêt(s) restant(s)</Text>
                : vehicle ? <Text style={styles.muted}>{batteryLine(nav.steps.slice(nav.stepIdx))}</Text> : null}
            </View>
            <RoundButton label={voice.isMuted ? '🔇' : '🔊'} onPress={voice.toggleMute} />
            <Pressable style={[styles.btn, styles.danger]} onPress={() => { logTrip(false); stopNav(); }}>
              <Text style={styles.primaryText}>Arrêter</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {busy ? <ActivityIndicator style={styles.busy} size="large" color={C.accent} /> : null}
      {toast ? <View style={[styles.toast, { bottom: insets.bottom + 250 }]}><Text style={styles.toastText}>{toast}</Text></View> : null}

      <SettingsSheet
        visible={sheet === 'settings'}
        settings={settings}
        bounds={bounds}
        near={fix?.coord ?? null}
        onClose={(s) => { setSheet(null); if (s) { setSettings(s); store.setSettings(s); } }}
      />
      <AlertSheet visible={sheet === 'alert'} onPick={addAlert} onClose={() => setSheet(null)} />
    </View>
  );
}

function RoundButton({ label, onPress, active }: { label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.round, active && { backgroundColor: C.danger }]} accessibilityRole="button">
      <Text style={[styles.roundText, active && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <Text style={[styles.text, on && { color: C.accentFg }]}>{on ? '✓ ' : ''}{label}</Text>
    </Pressable>
  );
}

const shadow = { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 4 };
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  text: { color: C.fg, fontSize: 15 },
  muted: { color: C.muted, fontSize: 13 },
  top: { position: 'absolute', left: 12, right: 12, gap: 8 },
  searchRow: { flexDirection: 'row', gap: 8 },
  search: { flex: 1, backgroundColor: C.bg, color: C.fg, borderRadius: 12, paddingHorizontal: 14, height: 48, fontSize: 16, ...shadow },
  card: { backgroundColor: C.bg, borderRadius: 12, padding: 4, ...shadow },
  result: { padding: 10 },
  resultName: { color: C.fg, fontWeight: '600', fontSize: 15 },
  assistant: { backgroundColor: C.bg, borderLeftWidth: 4, borderLeftColor: C.accent, borderRadius: 10, padding: 10, ...shadow },
  chips: { gap: 8, paddingVertical: 4 },
  chip: { backgroundColor: C.bg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, ...shadow },
  fabs: { position: 'absolute', right: 12, gap: 10 },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', ...shadow },
  roundText: { fontSize: 18, color: C.fg, fontWeight: '600' },
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 16, gap: 10, ...shadow },
  route: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12 },
  routeSel: { borderColor: C.accent, borderWidth: 2 },
  routeMain: { color: C.fg, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 10 },
  toggle: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10, alignItems: 'center' },
  toggleOn: { backgroundColor: C.accent, borderColor: C.accent },
  btn: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, alignItems: 'center' },
  primary: { backgroundColor: C.accent, borderColor: C.accent },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  danger: { backgroundColor: C.danger, borderColor: C.danger, flex: 0, paddingHorizontal: 20 },
  navTop: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: C.nav, flexDirection: 'row', alignItems: 'center',
    gap: 14, paddingHorizontal: 16, paddingBottom: 14 },
  navArrow: { color: '#fff', fontSize: 46, width: 64, textAlign: 'center' },
  navDist: { color: '#fff', fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  navText: { color: '#e6f2ef', fontSize: 17 },
  navBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.bg, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', padding: 16, gap: 12, ...shadow },
  navEta: { color: C.fg, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  busy: { position: 'absolute', alignSelf: 'center', top: '45%' },
  toast: { position: 'absolute', alignSelf: 'center', backgroundColor: C.fg, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '90%' },
  toastText: { color: C.bg, textAlign: 'center' },
  alertIcon: { fontSize: 24 },
  destPin: { fontSize: 32 },
  low: { color: C.danger, fontWeight: '700' },
  chargeBox: { backgroundColor: '#eef7f4', borderRadius: 10, padding: 10, gap: 4 },
  chargeTitle: { color: C.fg, fontWeight: '700', fontSize: 15 },
  chargeBtn: { backgroundColor: '#1f6fb2', borderColor: '#1f6fb2', flex: 0 },
});
