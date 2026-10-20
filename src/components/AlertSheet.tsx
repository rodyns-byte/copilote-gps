import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AlertType } from '../lib/storage';
import { C } from './theme';

export const ALERT_LABEL: Record<AlertType, string> = {
  accident: 'Accident', bouchon: 'Bouchon', travaux: 'Travaux', police: 'Zone de contravention', danger: 'Danger', ferme: 'Route fermée',
};
// Les radars ne sont jamais montrés à leur emplacement exact : on signale une zone (obligatoire en France).
export const CONTRAVENTION_ZONE_M = 500;

export const ALERT_ICON: Record<AlertType, string> = { accident: '💥', bouchon: '🚗', travaux: '🚧', police: '🔶', danger: '⚠️', ferme: '⛔' };

export function AlertSheet({ visible, onPick, onClose }: { visible: boolean; onPick: (t: AlertType) => void; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.title}>Signaler à cet endroit</Text>
        <View style={styles.grid}>
          {(Object.keys(ALERT_LABEL) as AlertType[]).map((t) => (
            <Pressable key={t} style={styles.item} onPress={() => onPick(t)}>
              <Text style={styles.icon}>{ALERT_ICON[t]}</Text>
              <Text style={styles.label}>{ALERT_LABEL[t]}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.cancel} onPress={onClose}><Text style={styles.label}>Annuler</Text></Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { backgroundColor: C.bg, padding: 18, paddingBottom: 34, borderTopLeftRadius: 18, borderTopRightRadius: 18, gap: 12 },
  title: { fontSize: 18, fontWeight: '700', color: C.fg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  item: { width: '31%', borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 14, alignItems: 'center', gap: 4 },
  icon: { fontSize: 28 },
  label: { color: C.fg, fontSize: 14 },
  cancel: { alignItems: 'center', padding: 12 },
});
