import { type ReactNode, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { OfflineManager } from '@maplibre/maplibre-react-native';
import { CONFIG } from '../lib/config';
import type { LngLat } from '../lib/geo';
import { geocode } from '../lib/services';
import { DEFAULT_ZONES, type Place, type Settings, type ZoneSettings } from '../lib/storage';
import { type EvModel, searchEvs } from '../lib/evs';
import { lookupPlate } from '../lib/plate';
import { DEFAULT_VEHICLE, readCarBattery, type Vehicle } from '../lib/vehicle';
import { C } from './theme';

type Props = {
  visible: boolean;
  settings: Settings;
  bounds: [number, number, number, number] | null;
  near: LngLat | null;
  onClose: (s: Settings | null) => void;
};

export function SettingsSheet({ visible, settings, bounds, near, onClose }: Props) {
  const [home, setHome] = useState('');
  const [work, setWork] = useState('');
  const [claudeKey, setClaudeKey] = useState('');
  const [tomtomKey, setTomtomKey] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [ev, setEv] = useState(false);
  const [capacity, setCapacity] = useState('');
  const [consumption, setConsumption] = useState('');
  const [battery, setBattery] = useState('');
  const [scToken, setScToken] = useState('');
  const [scVehicle, setScVehicle] = useState('');
  const [carStatus, setCarStatus] = useState('');
  const [maxKw, setMaxKw] = useState('');
  const [model, setModel] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [plate, setPlate] = useState('');
  const [regUser, setRegUser] = useState('');
  const [plateStatus, setPlateStatus] = useState('');
  const [plateBusy, setPlateBusy] = useState(false);
  const [zones, setZones] = useState<ZoneSettings>(DEFAULT_ZONES);

  useEffect(() => {
    if (!visible) return;
    setHome(settings.home?.label ?? ''); setWork(settings.work?.label ?? '');
    setClaudeKey(settings.claudeKey); setTomtomKey(settings.tomtomKey); setStatus('');
    const v = settings.vehicle ?? DEFAULT_VEHICLE;
    setEv(!!settings.vehicle); setCapacity(String(v.capacityKwh)); setConsumption(String(v.consumption));
    setBattery(String(v.batteryPct)); setScToken(v.smartcarToken ?? ''); setScVehicle(v.smartcarVehicleId ?? ''); setCarStatus('');
    setMaxKw(v.maxChargeKw ? String(v.maxChargeKw) : ''); setModel(v.model ?? ''); setModelQuery(''); setPlate(v.plate ?? '');
    setRegUser(settings.regcheckUser); setPlateStatus(''); setZones(settings.zones);
  }, [visible]);

  async function resolve(text: string, current: Place | null, name: string): Promise<Place | null> {
    if (!text.trim()) return null;
    if (current?.label === text) return current;
    const r = await geocode(text, near, 1);
    if (!r[0]) throw new Error(`Adresse introuvable : ${text}`);
    return { ...r[0], name, label: text };
  }

  const num = (s: string, min: number, max: number) => {
    const n = Number(s.replace(',', '.'));
    if (!isFinite(n) || n < min || n > max) throw new Error(`Valeur invalide : ${s || '(vide)'} (entre ${min} et ${max})`);
    return n;
  };
  function buildVehicle(): Vehicle | null {
    if (!ev) return null;
    const pct = num(battery, 0, 100);
    const prev = settings.vehicle;
    return {
      capacityKwh: num(capacity, 5, 250), consumption: num(consumption, 5, 50), batteryPct: pct,
      maxChargeKw: maxKw.trim() ? num(maxKw, 3, 400) : undefined, model: model || undefined, plate: plate.trim() || undefined,
      updatedAt: prev && prev.batteryPct === pct ? prev.updatedAt : Date.now(),
      source: prev && prev.batteryPct === pct ? prev.source : 'manuel',
      smartcarToken: scToken.trim() || undefined, smartcarVehicleId: scVehicle.trim() || undefined,
    };
  }

  function pickModel(e: EvModel) {
    setEv(true); setModel(`${e.brand} ${e.model}`); setModelQuery('');
    setCapacity(String(e.kwh)); setConsumption(String(e.consumption)); setMaxKw(String(e.maxKw));
  }

  async function findPlate() {
    setPlateBusy(true); setPlateStatus('Recherche de la plaque…');
    try {
      const r = await lookupPlate(plate, regUser);
      if (r.ev) { pickModel(r.ev); setPlateStatus(`Trouvé : ${r.description}${r.year ? ` (${r.year})` : ''}. Caractéristiques remplies.`); }
      else if (!r.electric) setPlateStatus(`Trouvé : ${r.description}. Ce n'est pas une voiture électrique, l'estimation de batterie ne s'applique pas.`);
      else { setModelQuery(r.description.split(' ').slice(0, 2).join(' ')); setPlateStatus(`Trouvé : ${r.description}. Choisissez la version exacte ci-dessous.`); }
    } catch (e) {
      setPlateStatus(e instanceof TypeError ? 'Connexion nécessaire pour la recherche par plaque.' : (e as Error).message);
    } finally { setPlateBusy(false); }
  }

  async function readFromCar() {
    try {
      setCarStatus('Lecture de la batterie…');
      const pct = await readCarBattery({ ...(buildVehicle() ?? DEFAULT_VEHICLE), smartcarToken: scToken.trim(), smartcarVehicleId: scVehicle.trim() });
      setBattery(String(pct));
      setCarStatus(`Batterie de la voiture : ${pct} %`);
    } catch (e) { setCarStatus(e instanceof TypeError ? 'Connexion nécessaire pour joindre la voiture.' : (e as Error).message); }
  }

  async function save() {
    setSaving(true);
    try {
      onClose({
        home: await resolve(home, settings.home, 'Maison'),
        work: await resolve(work, settings.work, 'Travail'),
        claudeKey: claudeKey.trim(),
        tomtomKey: tomtomKey.trim(),
        vehicle: buildVehicle(),
        zones,
        regcheckUser: regUser.trim(),
      });
    } catch (e) {
      setStatus(e instanceof TypeError ? 'Connexion nécessaire pour enregistrer une adresse.' : (e as Error).message);
    } finally { setSaving(false); }
  }

  async function downloadZone() {
    if (!bounds) return setStatus("Déplacez d'abord la carte sur la zone voulue.");
    setStatus('Préparation du téléchargement…');
    try {
      await OfflineManager.createPack(
        { mapStyle: CONFIG.mapStyle, bounds, minZoom: 10, maxZoom: 15, metadata: { name: `Zone du ${new Date().toLocaleDateString('fr-FR')}` } },
        (_pack, s) => setStatus(s.state === 'complete' ? 'Zone disponible hors connexion.' : `Téléchargement : ${Math.round(s.percentage)} %`),
        (_pack, err) => setStatus('Échec du téléchargement : ' + err.message),
      );
    } catch (e) { setStatus('Échec du téléchargement : ' + (e as Error).message); }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => onClose(null)}>
      <View style={styles.header}>
        <Pressable onPress={() => onClose(null)} hitSlop={12} accessibilityLabel="Fermer"><MaterialIcons name="close" size={26} color={C.fg} /></Pressable>
        <Text style={styles.title}>Réglages</Text>
        <Pressable style={styles.saveBtn} onPress={save} disabled={saving}>
          <Text style={styles.primaryText}>{saving ? '…' : 'Enregistrer'}</Text>
        </Pressable>
      </View>
      <ScrollView style={{ backgroundColor: C.surface }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Section icon="place" title="Mes adresses">
          <Field label="Domicile" value={home} onChange={setHome} placeholder="ex. 12 rue de la Paix, Paris" />
          <Field label="Travail" value={work} onChange={setWork} placeholder="ex. La Défense" />
        </Section>

        <Section icon="electric-car" title="Ma voiture">
          <Text style={styles.label}>Rechercher le modèle</Text>
          <View style={styles.searchBox}>
            <MaterialIcons name="search" size={20} color={C.muted} />
            <TextInput style={styles.searchInput} value={modelQuery} onChangeText={setModelQuery} placeholder="ex. Zoe, Tesla Model Y, e-208…"
              placeholderTextColor={C.muted} autoCorrect={false} />
          </View>
          {searchEvs(modelQuery).map((e, i) => (
            <Pressable key={i} style={styles.option} onPress={() => pickModel(e)}>
              <MaterialIcons name="directions-car" size={20} color={C.accent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.text}>{e.brand} {e.model}</Text>
                <Text style={styles.hint}>{e.kwh} kWh · {e.consumption} kWh/100 km · charge jusqu'à {e.maxKw} kW</Text>
              </View>
            </Pressable>
          ))}
          {modelQuery.trim().length > 1 && !searchEvs(modelQuery).length ? (
            <Text style={styles.hint}>Modèle absent de la liste : saisissez ses caractéristiques ci-dessous.</Text>
          ) : null}

          <Text style={styles.label}>Ou par la plaque d'immatriculation</Text>
          <View style={styles.row}>
            <TextInput style={[styles.input, styles.plate]} value={plate} onChangeText={(t) => setPlate(t.toUpperCase())} placeholder="AB-123-CD"
              placeholderTextColor={C.muted} autoCapitalize="characters" autoCorrect={false} />
            <Pressable style={[styles.smallBtn, styles.primary]} onPress={findPlate} disabled={plateBusy}>
              {plateBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Chercher</Text>}
            </Pressable>
          </View>
          {plateStatus ? <Text style={styles.hint}>{plateStatus}</Text> : null}
          <Text style={styles.hint}>
            Il n'existe pas de service gratuit pour les plaques françaises. Cette recherche utilise RegCheck
            (10 recherches offertes à l'inscription sur regcheck.org.uk, puis payant). Indiquez votre nom d'utilisateur :
          </Text>
          <Field label="Nom d'utilisateur RegCheck" value={regUser} onChange={setRegUser} placeholder="votre identifiant" secret />

          <ToggleRow label="Ma voiture est électrique" value={ev} onChange={setEv} />
          {ev ? (
            <>
              {model ? <View style={styles.carChip}><MaterialIcons name="check-circle" size={18} color={C.accent} /><Text style={styles.text}>{model}</Text></View> : null}
              <View style={styles.row}>
                <View style={{ flex: 1 }}><Field label="Batterie (kWh)" value={capacity} onChange={setCapacity} placeholder="52" numeric /></View>
                <View style={{ flex: 1 }}><Field label="Conso. (kWh/100)" value={consumption} onChange={setConsumption} placeholder="16" numeric /></View>
                <View style={{ flex: 1 }}><Field label="Charge max (kW)" value={maxKw} onChange={setMaxKw} placeholder="100" numeric /></View>
              </View>
              <Field label="Batterie actuelle (%)" value={battery} onChange={setBattery} placeholder="80" numeric />
              <Text style={styles.hint}>
                Pour lire la batterie directement depuis la voiture, connectez-la via Smartcar (la plupart des marques récentes).
                Dans cette version d'essai, collez le jeton d'accès et l'identifiant du véhicule obtenus sur dashboard.smartcar.com.
              </Text>
              <Field label="Jeton Smartcar" value={scToken} onChange={setScToken} placeholder="jeton d'accès" secret />
              <Field label="Identifiant du véhicule" value={scVehicle} onChange={setScVehicle} placeholder="ex. 36ab27d0-…" secret />
              {scToken && scVehicle ? (
                <Pressable style={styles.btn} onPress={readFromCar}><Text style={styles.text}>Lire la batterie de la voiture</Text></Pressable>
              ) : null}
              {carStatus ? <Text style={styles.hint}>{carStatus}</Text> : null}
            </>
          ) : null}
        </Section>

        <Section icon="speed" title="Zones de contravention">
          <Text style={styles.hint}>
            Les radars fixes connus (OpenStreetMap) et ceux signalés par les conducteurs apparaissent comme des zones de 500 m,
            sans emplacement exact, comme l'exige la loi française.
          </Text>
          <ToggleRow label="Radars fixes automatiques" value={zones.osm} onChange={(osm) => setZones({ ...zones, osm })} />
          <ToggleRow label="Afficher les zones sur la carte" value={zones.show} onChange={(show) => setZones({ ...zones, show })} />
          <ToggleRow label="Annonce vocale" value={zones.voice} onChange={(voice) => setZones({ ...zones, voice })} />
          <Text style={styles.label}>Prévenir avant la zone</Text>
          <View style={styles.segment}>
            {[200, 500, 1000].map((m) => (
              <Pressable key={m} style={[styles.segItem, zones.warnM === m && styles.segOn]} onPress={() => setZones({ ...zones, warnM: m })}>
                <Text style={zones.warnM === m ? styles.primaryText : styles.text}>{m >= 1000 ? '1 km' : `${m} m`}</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section icon="cloud-download" title="Carte hors connexion">
          <Text style={styles.hint}>Télécharge la carte de la zone affichée (zooms 10 à 15). La carte et le GPS marchent ensuite sans réseau.</Text>
          <Pressable style={styles.btn} onPress={downloadZone}><Text style={styles.text}>Télécharger cette zone</Text></Pressable>
          {status ? <Text style={styles.hint}>{status}</Text> : null}
        </Section>

        <Section icon="auto-awesome" title="Assistant IA et trafic (optionnel)">
          <Text style={styles.hint}>
            Sans clé, l'assistant comprend les phrases simples sur le téléphone. Avec une clé Claude, il comprend les demandes libres.
            Pour une application publiée, la clé doit rester sur un serveur.
          </Text>
          <Field label="Clé API Claude" value={claudeKey} onChange={setClaudeKey} placeholder="sk-ant-…" secret />
          <Field label="Clé API TomTom (trafic en direct)" value={tomtomKey} onChange={setTomtomKey} placeholder="clé sur developer.tomtom.com" secret />
        </Section>
        <View style={{ height: 40 }} />
      </ScrollView>
    </Modal>
  );
}

function Section({ icon, title, children }: { icon: keyof typeof MaterialIcons.glyphMap; title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionIcon}><MaterialIcons name={icon} size={18} color={C.accent} /></View>
        <Text style={styles.h3}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable style={styles.toggleRow} onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: value }}>
      <Text style={[styles.text, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.accent, false: C.line }} thumbColor="#fff" />
    </Pressable>
  );
}

function Field({ label, value, onChange, placeholder, secret, numeric }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; secret?: boolean; numeric?: boolean }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.muted}
        secureTextEntry={secret} autoCapitalize={secret ? 'none' : 'sentences'} autoCorrect={!secret && !numeric}
        keyboardType={numeric ? 'decimal-pad' : 'default'} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: C.fg },
  saveBtn: { backgroundColor: C.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  body: { padding: 14, gap: 14 },
  section: { backgroundColor: C.bg, borderRadius: 18, padding: 16, gap: 12 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  h3: { fontSize: 17, fontWeight: '700', color: C.fg },
  hint: { color: C.muted, fontSize: 13, lineHeight: 18 },
  label: { color: C.fg, fontSize: 14, fontWeight: '600' },
  text: { color: C.fg, fontSize: 15 },
  input: { backgroundColor: C.surface, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: C.fg },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.surface, borderRadius: 12, paddingHorizontal: 12 },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 16, color: C.fg },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  plate: { flex: 1, fontSize: 18, fontWeight: '700', letterSpacing: 2, textAlign: 'center', borderLeftWidth: 10, borderLeftColor: '#1f4fb5' },
  carChip: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.accentSoft, borderRadius: 12, padding: 10 },
  row: { flexDirection: 'row', gap: 10 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  segment: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 12, padding: 4, gap: 4 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9 },
  segOn: { backgroundColor: C.accent },
  btn: { borderRadius: 12, padding: 13, alignItems: 'center', backgroundColor: C.surface },
  smallBtn: { borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center', minWidth: 100, alignItems: 'center' },
  primary: { backgroundColor: C.accent },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
