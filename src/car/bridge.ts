// Lien entre l'écran du téléphone et l'écran de la voiture (Android Auto / CarPlay).
// Le guidage tourne une seule fois : dans l'écran du téléphone s'il est ouvert, sinon dans le moteur de la voiture (headless.ts).
import type { ChargePlan } from '../lib/charging';
import type { LngLat } from '../lib/geo';
import type { Route, Step } from '../lib/routing';
import type { AlertType, Place } from '../lib/storage';

export type CarNav = {
  dest: Place;
  route: Route;
  steps: Step[];
  stepIdx: number;
  stepDist: number; // m jusqu'à la prochaine manœuvre
  remainingS: number; // s jusqu'à l'arrivée, recharges comprises
  remainingM: number;
  charge: ChargePlan | null;
  stopsDone: number;
  batteryPct: number | null; // batterie estimée à l'arrivée
};
export type CarState = { nav: CarNav | null; position: LngLat | null; planning: string | null };

/** Ce que la voiture peut demander. */
export type CarController = {
  go: (place: Place) => Promise<void>; // calcule le trajet (et les recharges si besoin) puis démarre
  stop: () => void;
  report: (type: AlertType) => void;
  active?: () => boolean; // un guidage est en cours ici
};

type Notice = { title: string; subtitle?: string };

let state: CarState = { nav: null, position: null, planning: null };
const listeners = new Set<() => void>();
const noticeListeners = new Set<(n: Notice) => void>();
let phone: CarController | null = null;
let fallback: CarController | null = null;

export const carBridge = {
  get: () => state,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  publish(patch: Partial<CarState>) {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  },
  /** Message court affiché sur l'écran de la voiture (zone de contravention, borne atteinte…). */
  notice(n: Notice) { noticeListeners.forEach((fn) => fn(n)); },
  onNotice(fn: (n: Notice) => void) { noticeListeners.add(fn); return () => { noticeListeners.delete(fn); }; },
  /** L'écran du téléphone s'inscrit quand il est monté. */
  setPhoneController(c: CarController | null) { phone = c; },
  setFallbackController(c: CarController) { fallback = c; },
  // Le guidage déjà lancé garde la main ; sinon le téléphone s'il est ouvert.
  controller: (): CarController | null => (fallback?.active?.() ? fallback : phone ?? fallback),
};
