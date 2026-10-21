// Recherche d'une voiture par sa plaque (France) avec le service RegCheck « CheckFrance ».
// Service payant au crédit (10 crédits offerts à l'inscription sur regcheck.org.uk) : il faut un nom d'utilisateur.
import { type EvModel, matchEv } from './evs';

export type PlateResult = { description: string; electric: boolean; year?: string; ev: EvModel | null };

const decode = (s: string) => s
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

/** Plaque au format AA-123-AA, sans espaces ni tirets pour le service. */
export const cleanPlate = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function lookupPlate(plate: string, username: string): Promise<PlateResult> {
  const p = cleanPlate(plate);
  if (p.length < 5) throw new Error('Plaque invalide (ex. AB-123-CD)');
  if (!username.trim()) throw new Error("Indiquez d'abord votre nom d'utilisateur RegCheck.");
  const url = `https://www.regcheck.org.uk/api/reg.asmx/CheckFrance?RegistrationNumber=${encodeURIComponent(p)}&username=${encodeURIComponent(username.trim())}`;
  const res = await fetch(url);
  const xml = await res.text();
  if (!res.ok) {
    if (/credit/i.test(xml)) throw new Error('Plus de crédits RegCheck : rechargez votre compte sur regcheck.org.uk.');
    if (/not found|no data|invalid/i.test(xml)) throw new Error('Plaque introuvable.');
    throw new Error(`Recherche par plaque impossible (${res.status}).`);
  }
  const m = xml.match(/<vehicleJson>([\s\S]*?)<\/vehicleJson>/);
  if (!m || !m[1].trim()) throw new Error('Plaque introuvable.');
  const data = JSON.parse(decode(m[1]));
  const ext = data.ExtendedData ?? {};
  const make = data.CarMake?.CurrentTextValue ?? '';
  const model = data.CarModel?.CurrentTextValue ?? '';
  const version = ext.libVersion ?? '';
  const description = [data.Description || `${make} ${model}`, version].filter(Boolean).join(' ').trim();
  const fuel = `${data.FuelType?.CurrentTextValue ?? ''} ${ext.carburantVersion ?? ''}`.toUpperCase();
  const flag = String(ext.electrique ?? '').toUpperCase();
  const electric = /ELEC|\bEL\b/.test(fuel) || ['OUI', 'O', '1', 'TRUE', 'Y'].includes(flag);
  return { description, electric, year: data.RegistrationYear, ev: matchEv(`${make} ${model} ${version}`) };
}
