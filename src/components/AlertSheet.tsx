import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { AlertType } from '../lib/storage';
import { C } from './theme';

import { ALERT_LABEL } from '../lib/alerts';

export { ALERT_ICON, ALERT_LABEL, CONTRAVENTION_ZONE_M } from '../lib/alerts';

/** Icône et couleur de chaque type de signalement sur la carte. */
export const ALERT_MI: Record<AlertType, { icon: keyof typeof MaterialIcons.glyphMap; color: string }> = {
  accident: { icon: 'car-crash', color: '#d6336c' },
  bouchon: { icon: 'traffic', color: '#e8590c' },
  travaux: { icon: 'construction', color: '#f08c00' },
  police: { icon: 'speed', color: C.warn },
  danger: { icon: 'warning', color: '#e0a800' },
  ferme: { icon: 'block', color: '#c92a2a' },
};

export function AlertSheet({ visible, onPick, onClose }: { visible: boolean; onPick: (t: AlertType) => void; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Signaler à cet endroit</Text>
        <View style={styles.grid}>
          {(Object.keys(ALERT_LABEL) as AlertType[]).map((t) => (
            <Pressable key={t} style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]} onPress={() => onPick(t)}>
              <View style={[styles.icon, { backgroundColor: ALERT_MI[t].color }]}>
                <MaterialIcons name={ALERT_MI[t].icon} size={30} color="#fff" />
              </View>
              <Text style={styles.label} numberOfLines={2}>{ALERT_LABEL[t]}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.cancel} onPress={onClose}><Text style={styles.cancelText}>Annuler</Text></Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { backgroundColor: C.bg, padding: 18, paddingBottom: 34, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: 14 },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.line },
  title: { fontSize: 19, fontWeight: '700', color: C.fg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 },
  item: { width: '33.3%', alignItems: 'center', gap: 8 },
  icon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  label: { color: C.fg, fontSize: 13, textAlign: 'center', fontWeight: '600' },
  cancel: { alignItems: 'center', padding: 14, backgroundColor: C.surface, borderRadius: 14 },
  cancelText: { color: C.fg, fontSize: 16, fontWeight: '600' },
});
