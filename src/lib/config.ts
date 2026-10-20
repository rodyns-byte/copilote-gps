// Services utilisés. Les serveurs publics Valhalla (FOSSGIS) et Nominatim servent aux essais :
// pour une application publiée, remplacez-les par vos propres serveurs (voir README).
export const CONFIG = {
  mapStyle: 'https://tiles.openfreemap.org/styles/liberty',
  valhallaUrl: 'https://valhalla1.openstreetmap.de/route',
  nominatimUrl: 'https://nominatim.openstreetmap.org/',
  userAgent: 'CopiloteGPS/0.1 (prototype)',
  offRouteMeters: 50, // au-delà, on recalcule
  offRouteFixes: 3, // positions consécutives hors trajet avant recalcul
  alertAheadMeters: 800, // distance d'annonce des dangers
  alertLifetimeMs: 2 * 3600e3, // durée de vie d'un signalement
};
