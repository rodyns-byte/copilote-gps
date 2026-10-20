import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { OfflineManager } from '@maplibre/maplibre-react-native';
import { CONFIG } from '../lib/config';
import type { LngLat } from '../lib/geo';
import { geocode } from '../lib/services';
import type { Place, Settings } from '../lib/storage';
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

  useEffect(() => {
    if (!visible) return;
    setHome(settings.home?.label ?? ''); setWork(settings.work?.label ?? '');
    setClaudeKey(settings.claudeKey); setTomtomKey(settings.tomtomKey); setStatus('');
    const v = settings.vehicle ?? DEFAULT_VEHICLE;
    setEv(!!settings.vehicle); setCapacity(String(v.capacityKwh)); setConsumption(String(v.consumption));
    setBattery(String(v.batteryPct)); setScToken(v.smartcarToken ?? ''); setScVehicle(v.smartcarVehicleId ?? ''); setCarStatus('');
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
      updatedAt: prev && prev.batteryPct === pct ? prev.updatedAt : Date.now(),
      source: prev && prev.batteryPct === pct ? prev.source : 'manuel',
      smartcarToken: scToken.trim() || undefined, smartcarVehicleId: scVehicle.trim() || undefined,
    };
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
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Réglages</Text>
        <Field label="Domicile" value={home} onChange={setHome} placeholder="ex. 12 rue de la Paix, Paris" />
        <Field label="Travail" value={work} onChange={setWork} placeholder="ex. La Défense" />

        <Text style={styles.h3}>Assistant IA (optionnel)</Text>
        <Text style={styles.hint}>
          Sans clé, l'assistant comprend les phrases simples sur le téléphone. Avec une clé Claude, il comprend les demandes libres.
          Pour une application publiée, la clé doit rester sur un serveur.
        </Text>
        <Field label="Clé API Claude" value={claudeKey} onChange={setClaudeKey} placeholder="sk-ant-…" secret />

        <Text style={styles.h3}>Trafic en direct (optionnel)</Text>
        <Field label="Clé API TomTom" value={tomtomKey} onChange={setTomtomKey} placeholder="clé sur developer.tomtom.com" secret />

        <Text style={styles.h3}>Voiture électrique</Text>
        <Pressable style={[styles.btn, ev && styles.primary]} onPress={() => setEv(!ev)} accessibilityRole="switch" accessibilityState={{ checked: ev }}>
          <Text style={ev ? styles.primaryText : styles.text}>{ev ? '✓ Ma voiture est électrique' : 'Ma voiture est électrique'}</Text>
        </Pressable>
        {ev ? (
          <>
            <Text style={styles.hint}>Sert à estimer la batterie à l'arrivée. La consommation est ajustée selon la vitesse (ville, route, autoroute).</Text>
            <View style={styles.row}>
              <View style={{ flex: 1 }}><Field label="Batterie (kWh)" value={capacity} onChange={setCapacity} placeholder="52" numeric /></View>
              <View style={{ flex: 1 }}><Field label="Conso. (kWh/100 km)" value={consumption} onChange={setConsumption} placeholder="16" numeric /></View>
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

        <Text style={styles.h3}>Hors connexion</Text>
        <Text style={styles.hint}>Télécharge la carte de la zone affichée (zooms 10 à 15). La carte et le GPS marchent ensuite sans réseau.</Text>
        <Pressable style={styles.btn} onPress={downloadZone}><Text style={styles.text}>Télécharger cette zone</Text></Pressable>
        {status ? <Text style={styles.hint}>{status}</Text> : null}

        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={() => onClose(null)}><Text style={styles.text}>Annuler</Text></Pressable>
          <Pressable style={[styles.btn, styles.primary]} onPress={save} disabled={saving}>
            <Text style={styles.primaryText}>{saving ? 'Enregistrement…' : 'Enregistrer'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Modal>
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
  body: { padding: 20, gap: 12, backgroundColor: C.bg },
  title: { fontSize: 24, fontWeight: '700', color: C.fg },
  h3: { fontSize: 17, fontWeight: '700', color: C.fg, marginTop: 8 },
  hint: { color: C.muted, fontSize: 13 },
  label: { color: C.fg, fontSize: 14 },
  text: { color: C.fg, fontSize: 15 },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10, fontSize: 16, color: C.fg },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 14, alignItems: 'center' },
  primary: { backgroundColor: C.accent, borderColor: C.accent },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
