// Voiture électrique : batterie actuelle et estimation de la batterie à l'arrivée.
import type { Step } from './routing';

export type Vehicle = {
  capacityKwh: number; // capacité utile de la batterie
  consumption: number; // consommation moyenne en kWh/100 km (vitesse mixte)
  maxChargeKw?: number; // puissance de recharge maximale acceptée par la voiture
  batteryPct: number; // dernier niveau connu
  updatedAt: number;
  source: 'manuel' | 'voiture';
  // Connexion à la voiture via Smartcar (marques compatibles : smartcar.com/product/compatible-vehicles)
  smartcarToken?: string;
  smartcarVehicleId?: string;
};

export const DEFAULT_VEHICLE: Vehicle = { capacityKwh: 52, consumption: 16, batteryPct: 80, updatedAt: 0, source: 'manuel' };

/** Coefficient de consommation selon la vitesse moyenne (km/h) : la ville coûte moins que l'autoroute. */
export function speedFactor(kmh: number): number {
  if (kmh < 50) return 0.85;
  if (kmh < 90) return 1.0;
  if (kmh < 115) return 1.25;
  return 1.45;
}

/** Énergie (kWh) consommée sur une suite d'étapes OSRM. */
export function energyKwh(steps: Step[], consumption: number): number {
  return steps.reduce((sum, s) => {
    if (!s.distance) return sum;
    const kmh = s.duration > 0 ? (s.distance / s.duration) * 3.6 : 50;
    return sum + (s.distance / 1000) * (consumption / 100) * speedFactor(kmh);
  }, 0);
}

/** Batterie estimée à l'arrivée, en %. Peut être négative : la voiture n'arrivera pas sans recharge. */
export function arrivalPct(steps: Step[], v: Vehicle): number {
  return v.batteryPct - (energyKwh(steps, v.consumption) / v.capacityKwh) * 100;
}

/** Niveau sous lequel on prévient le conducteur. */
export const LOW_BATTERY_PCT = 10;

/**
 * Lit la batterie de la voiture via l'API Smartcar.
 * En production, le jeton s'obtient par la connexion Smartcar (OAuth) gérée par votre serveur.
 */
export async function readCarBattery(v: Vehicle): Promise<number> {
  if (!v.smartcarToken || !v.smartcarVehicleId) throw new Error('Voiture non connectée');
  const res = await fetch(`https://api.smartcar.com/v2.0/vehicles/${v.smartcarVehicleId}/battery`, {
    headers: { Authorization: `Bearer ${v.smartcarToken}` },
  });
  if (res.status === 401) throw new Error('Connexion à la voiture expirée : reconnectez-la.');
  if (!res.ok) throw new Error('La voiture ne répond pas (' + res.status + ')');
  const data: { percentRemaining: number } = await res.json();
  return Math.round(data.percentRemaining * 100);
}
