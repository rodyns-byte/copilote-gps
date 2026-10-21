// Voitures électriques courantes en France : batterie utile, consommation moyenne réelle, recharge rapide maximale.
// Valeurs moyennes (route mixte, climat tempéré), modifiables ensuite dans les réglages.
export type EvModel = { brand: string; model: string; kwh: number; consumption: number; maxKw: number };

export const EVS: EvModel[] = [
  { brand: 'Renault', model: 'Zoe R135 (52 kWh)', kwh: 52, consumption: 16.5, maxKw: 50 },
  { brand: 'Renault', model: '5 E-Tech (40 kWh)', kwh: 40, consumption: 14.5, maxKw: 80 },
  { brand: 'Renault', model: '5 E-Tech (52 kWh)', kwh: 52, consumption: 15, maxKw: 100 },
  { brand: 'Renault', model: '4 E-Tech (52 kWh)', kwh: 52, consumption: 15.5, maxKw: 100 },
  { brand: 'Renault', model: 'Megane E-Tech (60 kWh)', kwh: 60, consumption: 16.5, maxKw: 130 },
  { brand: 'Renault', model: 'Scenic E-Tech (87 kWh)', kwh: 87, consumption: 17, maxKw: 150 },
  { brand: 'Dacia', model: 'Spring', kwh: 26.8, consumption: 13.5, maxKw: 30 },
  { brand: 'Peugeot', model: 'e-208 (51 kWh)', kwh: 48, consumption: 15, maxKw: 100 },
  { brand: 'Peugeot', model: 'e-2008 (54 kWh)', kwh: 51, consumption: 16.5, maxKw: 100 },
  { brand: 'Peugeot', model: 'e-308 (54 kWh)', kwh: 51, consumption: 15.5, maxKw: 100 },
  { brand: 'Peugeot', model: 'e-3008 (73 kWh)', kwh: 73, consumption: 17.5, maxKw: 160 },
  { brand: 'Citroën', model: 'ë-C3 (44 kWh)', kwh: 44, consumption: 16, maxKw: 100 },
  { brand: 'Citroën', model: 'ë-C4 (54 kWh)', kwh: 51, consumption: 16, maxKw: 100 },
  { brand: 'Opel', model: 'Corsa Electric (51 kWh)', kwh: 48, consumption: 15, maxKw: 100 },
  { brand: 'Fiat', model: '500e (42 kWh)', kwh: 37.3, consumption: 14.5, maxKw: 85 },
  { brand: 'Tesla', model: 'Model 3 Propulsion', kwh: 57.5, consumption: 14, maxKw: 170 },
  { brand: 'Tesla', model: 'Model 3 Grande Autonomie', kwh: 75, consumption: 15, maxKw: 250 },
  { brand: 'Tesla', model: 'Model Y Propulsion', kwh: 57.5, consumption: 15.5, maxKw: 170 },
  { brand: 'Tesla', model: 'Model Y Grande Autonomie', kwh: 75, consumption: 16.5, maxKw: 250 },
  { brand: 'Volkswagen', model: 'ID.3 Pro (58 kWh)', kwh: 58, consumption: 15.5, maxKw: 120 },
  { brand: 'Volkswagen', model: 'ID.4 Pro (77 kWh)', kwh: 77, consumption: 18, maxKw: 135 },
  { brand: 'Cupra', model: 'Born (58 kWh)', kwh: 58, consumption: 16, maxKw: 120 },
  { brand: 'Skoda', model: 'Enyaq 85', kwh: 77, consumption: 17.5, maxKw: 135 },
  { brand: 'Kia', model: 'Niro EV (64,8 kWh)', kwh: 64.8, consumption: 16, maxKw: 80 },
  { brand: 'Kia', model: 'EV3 (81,4 kWh)', kwh: 81.4, consumption: 15.5, maxKw: 128 },
  { brand: 'Kia', model: 'EV6 (77,4 kWh)', kwh: 77.4, consumption: 17.5, maxKw: 233 },
  { brand: 'Hyundai', model: 'Inster (49 kWh)', kwh: 49, consumption: 14.5, maxKw: 85 },
  { brand: 'Hyundai', model: 'Kona Electric (64,8 kWh)', kwh: 64.8, consumption: 15.5, maxKw: 102 },
  { brand: 'Hyundai', model: 'Ioniq 5 (77,4 kWh)', kwh: 77.4, consumption: 18, maxKw: 233 },
  { brand: 'MG', model: 'MG4 (64 kWh)', kwh: 61.7, consumption: 16.5, maxKw: 135 },
  { brand: 'MG', model: 'ZS EV (72 kWh)', kwh: 68.3, consumption: 18, maxKw: 92 },
  { brand: 'BYD', model: 'Dolphin (60 kWh)', kwh: 60.4, consumption: 16, maxKw: 88 },
  { brand: 'BYD', model: 'Atto 3 (60 kWh)', kwh: 60.5, consumption: 17.5, maxKw: 88 },
  { brand: 'BYD', model: 'Seal (82,5 kWh)', kwh: 82.5, consumption: 17, maxKw: 150 },
  { brand: 'Nissan', model: 'Leaf (40 kWh)', kwh: 39, consumption: 16, maxKw: 50 },
  { brand: 'Nissan', model: 'Leaf e+ (62 kWh)', kwh: 59, consumption: 17, maxKw: 100 },
  { brand: 'Toyota', model: 'bZ4X', kwh: 64, consumption: 17.5, maxKw: 150 },
  { brand: 'Volvo', model: 'EX30 (69 kWh)', kwh: 64, consumption: 16.5, maxKw: 153 },
  { brand: 'Smart', model: '#1 (66 kWh)', kwh: 62, consumption: 17.5, maxKw: 150 },
  { brand: 'Mini', model: 'Cooper E / SE (54 kWh)', kwh: 49.2, consumption: 15, maxKw: 95 },
  { brand: 'BMW', model: 'iX1 (65 kWh)', kwh: 64.7, consumption: 17, maxKw: 130 },
  { brand: 'BMW', model: 'i4 eDrive40', kwh: 80.7, consumption: 17, maxKw: 205 },
  { brand: 'Mercedes', model: 'EQA 250+', kwh: 70.5, consumption: 17.5, maxKw: 100 },
];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Recherche « zoe », « tesla model y », « 208 »… : tous les mots doivent apparaître dans la marque ou le modèle. */
export function searchEvs(q: string, list = EVS): EvModel[] {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  return list.filter((e) => { const t = norm(`${e.brand} ${e.model}`); return words.every((w) => t.includes(w)); }).slice(0, 8);
}

/** Trouve le modèle le plus proche d'une description (ex. celle renvoyée par la recherche par plaque). */
export function matchEv(description: string): EvModel | null {
  const t = norm(description);
  let best: EvModel | null = null, score = 0;
  for (const e of EVS) {
    const words = norm(`${e.brand} ${e.model.replace(/\(.*\)/, '')}`).split(' ').filter((w) => w.length > 1);
    const s = words.filter((w) => t.includes(w)).length / words.length;
    if (t.includes(norm(e.brand)) && s > score) { score = s; best = e; }
  }
  return score >= 0.5 ? best : null;
}
