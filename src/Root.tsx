import { Component, type ReactNode, useSyncExternalStore } from 'react';
import { ScrollView, Text } from 'react-native';
import { crashState, reportCrash } from './crash';

let App: (() => ReactNode) | null = null;
try { App = require('../App').default; } catch (e) { reportCrash(e, 'Chargement'); }

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { reportCrash(e, 'Écran'); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Écran principal, ou le message d'erreur si quelque chose a planté. */
export function Root() {
  const error = useSyncExternalStore(crashState.subscribe, crashState.get);
  if (error || !App) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: '#fff' }} contentContainerStyle={{ padding: 24, paddingTop: 60 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 12 }}>Copilote GPS a rencontré une erreur</Text>
        <Text style={{ fontSize: 14, marginBottom: 16 }}>Faites une capture d'écran de cette page et envoyez-la.</Text>
        <Text selectable style={{ fontSize: 12, fontFamily: 'monospace' }}>{error || "L'application n'a pas pu se charger."}</Text>
      </ScrollView>
    );
  }
  return <Boundary><App /></Boundary>;
}
