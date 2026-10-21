// Doit rester le premier import : minuteries utilisables quand seule la voiture affiche l'application.
import '@iternio/react-native-auto-play/installTimers';
import { reportCrash } from './src/crash';
import { registerRootComponent } from 'expo';
import { Root } from './src/Root';

// Chargés ici (et pas en import) pour qu'une erreur au démarrage s'affiche au lieu de fermer l'application.
try {
  require('./src/car/AutoPlay').registerCar(); // Android Auto et CarPlay
} catch (e) { reportCrash(e, 'Android Auto'); }

registerRootComponent(Root);
