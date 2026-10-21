// Si l'application plante au démarrage, on affiche l'erreur à l'écran au lieu de la fermer (version de test).
type Listener = (msg: string) => void;
let lastError = '';
const listeners = new Set<Listener>();

export function reportCrash(e: unknown, where: string) {
  const err = e instanceof Error ? e : new Error(String(e));
  lastError = `${where} : ${err.message}\n\n${(err.stack ?? '').split('\n').slice(0, 8).join('\n')}`;
  listeners.forEach((fn) => fn(lastError));
}
export const crashState = {
  get: () => lastError,
  subscribe(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn); }; },
};

const g = globalThis as unknown as { ErrorUtils?: { setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void } };
g.ErrorUtils?.setGlobalHandler((e, fatal) => reportCrash(e, fatal ? 'Erreur fatale' : 'Erreur'));
