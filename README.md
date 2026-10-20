# Copilote GPS — application mobile (Android et iOS)

Application React Native (Expo SDK 58) qui reprend les 5 fonctions du prototype web.

| Fonction | Où dans le code |
| --- | --- |
| Assistant vocal (micro en français, analyse locale ou Claude) | `src/hooks/useVoice.ts`, `src/lib/nlu.ts` |
| Navigation : carte 2D/3D, guidage vocal, recalcul, 3 alternatives, éviter péages ou autoroutes | `App.tsx`, `src/lib/routing.ts`, `src/hooks/useLocation.ts` |
| IA prédictive : destinations habituelles, durée ajustée à vos trajets | `src/lib/services.ts` (`predictDestinations`), `src/lib/routing.ts` (`personalFactor`, `rankRoutes`) |
| Trafic et dangers : signalements, trafic et incidents TomTom | `src/components/AlertSheet.tsx`, `src/lib/services.ts` (`fetchIncidents`) |
| Hors connexion : téléchargement de la carte d'une zone | `src/components/SettingsSheet.tsx` (`OfflineManager.createPack`) |
| Voiture électrique : batterie à l'arrivée, alerte sous 10 %, lecture de la batterie via Smartcar | `src/lib/vehicle.ts`, réglages « Voiture électrique » |
| Radars affichés en zones de contravention (cercle de 500 m, jamais l'emplacement exact) | `src/components/AlertSheet.tsx`, `App.tsx` |

## Lancer sur votre téléphone

La carte MapLibre contient du code natif : l'application **ne marche pas dans Expo Go**. Il faut une
« development build », que le service EAS d'Expo compile en ligne (pas besoin d'Android Studio ni de Xcode).

```bash
npm install
npx eas-cli@latest login                                  # compte Expo gratuit
npx eas-cli@latest build --profile development --platform android
# installez l'APK reçu sur le téléphone, puis :
npx expo start --dev-client
```

Pour l'iPhone, même chose avec `--platform ios` (compte Apple Developer payant nécessaire).
Avec Android Studio installé, `npx expo run:android` marche aussi.

Une fois l'application ouverte :
1. Autorisez la localisation et le micro.
2. Dans ☰, saisissez votre domicile et votre travail. Les clés Claude et TomTom sont optionnelles.
3. Touchez 🎤 et dites « trouve-moi le trajet le plus rapide pour rentrer chez moi, en évitant les péages ».

## Ce qui est vérifié, ce qui ne l'est pas

- Vérifié : le code TypeScript compile sans erreur, et l'application se construit pour Android (`npx expo export`).
  L'analyse des phrases, les instructions de guidage, le classement des itinéraires et la prédiction ont été testés sur des exemples.
- Pas encore vérifié : l'application n'a pas tourné sur un vrai téléphone, et aucun appel réel aux services de carte n'a été fait.

## Batterie de la voiture

Android Auto et CarPlay ne donnent pas la batterie de la voiture aux applications de navigation. L'app propose donc :
- **Saisie manuelle** du pourcentage, de la capacité et de la consommation : l'estimation marche tout de suite.
- **Lecture depuis la voiture via [Smartcar](https://smartcar.com)**, qui se connecte au compte constructeur de la voiture (liste des marques compatibles sur smartcar.com, à vérifier pour votre modèle).
  La batterie est relue au démarrage du guidage puis toutes les 5 minutes. Dans cette version, le jeton se colle à la main.
  Pour une app publiée, la connexion Smartcar (OAuth) passe par votre serveur.
- Plus tard, au choix : un boîtier OBD Bluetooth, ou une app Android Automotive pour les voitures qui ont Android intégré.

L'estimation à l'arrivée tient compte de la vitesse sur chaque portion (ville, route, autoroute). Elle ne tient pas encore compte du relief, du froid ni de la climatisation.

## Limites connues (prochaines étapes)

- Le guidage s'arrête quand l'écran est verrouillé : le GPS en arrière-plan est à ajouter (`expo-task-manager`).
- Les serveurs publics OSRM et Nominatim servent aux essais seulement (`src/lib/config.ts`). Pour publier l'app, il faut vos propres serveurs ou un fournisseur payant.
- Sans réseau, seules la carte téléchargée et la position marchent. L'itinéraire hors ligne demandera Valhalla embarqué.
- Les signalements restent sur le téléphone tant qu'il n'y a pas de serveur pour les partager.
- La clé Claude saisie dans l'app est pour les essais. En production, elle reste sur votre serveur.
