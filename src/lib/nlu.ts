// Compréhension des commandes vocales en français.
// parseLocal : règles simples, fonctionne hors ligne.
// parseWithClaude : compréhension libre via l'API Claude (en ligne, clé requise).
import type { AlertType } from './storage';

export type Command = {
  intent: 'route' | 'stop' | 'report' | 'unknown';
  destination: string | null;
  place: 'home' | 'work' | null;
  avoid: { toll: boolean; motorway: boolean };
  report?: AlertType;
  reply?: string;
  raw: string;
};

export const strip = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").trim();

const REPORTS: [RegExp, AlertType][] = [
  [/accident/, 'accident'], [/bouchon|embouteillage|ralenti/, 'bouchon'], [/travaux|chantier/, 'travaux'],
  [/police|controle|radar/, 'police'], [/route (est )?fermee|barree/, 'ferme'], [/danger|obstacle|objet sur la route/, 'danger'],
];

export function parseLocal(text: string): Command {
  const t = strip(text);
  const out: Command = { intent: 'route', destination: null, place: null, avoid: { toll: false, motorway: false }, raw: text };

  if (/^(arrete|stop|annule|termine)/.test(t) || /arrete(r)? la navigation/.test(t)) return { ...out, intent: 'stop' };
  if (/^(signale|il y a)/.test(t)) {
    const r = REPORTS.find(([re]) => re.test(t));
    if (r) return { ...out, intent: 'report', report: r[1] };
  }
  // Tout ce qui suit « sans / en évitant / pas par » décrit ce qu'il faut éviter.
  const av = t.match(/\b(sans|evit\w*|pas de|pas d'|pas par)\b(.*)$/);
  if (av) {
    if (/peages?|payant/.test(av[2])) out.avoid.toll = true;
    if (/autoroutes?\b(?! payante)/.test(av[2])) out.avoid.motorway = true;
  }

  if (/chez moi|a la maison|maison|domicile|rentrer/.test(t)) out.place = 'home';
  else if (/travail|boulot|bureau/.test(t)) out.place = 'work';

  if (!out.place) {
    const m =
      t.match(/(?:aller|va|vers|direction|jusqu'a|emmene[- ]moi|conduis[- ]moi|itineraire|trajet)\s+(?:a|au|aux|a la|a l'|en|vers|pour|jusqu'a)?\s*(.+)/) ||
      t.match(/(?:trouve|cherche)[- ](?:moi\s+)?(?:une?|la|le|les|des)?\s*(.+)/);
    const dest = (m ? m[1] : t)
      .replace(/\b(en |sans |et )?(evit\w*|sans|pas de|pas par).*$/, '')
      .replace(/\b(le plus (rapide|court)|rapidement|s'il te plait|stp|svp)\b/g, '')
      .replace(/^(le |la |les |l')?(trajet|itineraire|chemin)( le plus rapide)?( pour)?( aller)?( a| au| vers)?\s*/, '')
      .replace(/^(a|au|aux|a la|a l'|vers)\s+/, '')
      .replace(/[.,!?]+$/, '')
      .trim();
    // On garde l'orthographe d'origine (accents) pour la recherche quand c'est possible.
    const idx = strip(text).lastIndexOf(dest);
    out.destination = dest ? (idx >= 0 ? text.trim().slice(idx, idx + dest.length) : dest) : null;
    if (!out.destination) out.intent = 'unknown';
  }
  return out;
}

// En production, cet appel passe par votre serveur : la clé ne doit pas être dans l'application.
export async function parseWithClaude(text: string, apiKey: string): Promise<Command> {
  const system =
    "Tu es le moteur de compréhension d'un GPS. Réponds UNIQUEMENT par un objet JSON : " +
    '{"intent":"route|stop|report|unknown","destination":string|null,"place":"home"|"work"|null,' +
    '"avoid":{"toll":bool,"motorway":bool},"report":"accident|bouchon|travaux|police|danger|ferme"|null,"reply":string}. ' +
    '"destination" est un texte géocodable (adresse, ville, type de lieu). "reply" est une phrase courte à lire au conducteur.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 300, system, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error('API Claude : ' + res.status);
  const data = await res.json();
  const txt: string = data.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return { destination: null, place: null, ...json, avoid: { toll: !!json.avoid?.toll, motorway: !!json.avoid?.motorway }, raw: text };
}
