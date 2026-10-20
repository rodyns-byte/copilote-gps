// Doit rester le premier import : minuteries utilisables quand seule la voiture affiche l'application.
import '@iternio/react-native-auto-play/installTimers';
import { registerRootComponent } from 'expo';

import App from './App';
import { registerCar } from './src/car/AutoPlay';

registerCar(); // Android Auto et CarPlay
registerRootComponent(App);
