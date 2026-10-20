import type { AlertType } from './storage';

export const ALERT_LABEL: Record<AlertType, string> = {
  accident: 'Accident', bouchon: 'Bouchon', travaux: 'Travaux', police: 'Zone de contravention', danger: 'Danger', ferme: 'Route fermée',
};
// Les radars ne sont jamais montrés à leur emplacement exact : on signale une zone (obligatoire en France).
export const CONTRAVENTION_ZONE_M = 500;

export const ALERT_ICON: Record<AlertType, string> = { accident: '💥', bouchon: '🚗', travaux: '🚧', police: '🔶', danger: '⚠️', ferme: '⛔' };
