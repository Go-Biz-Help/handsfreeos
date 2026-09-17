// The app's entry. Android can start the app with no screen, just to show a push or run a notification's button, so
// the background task is defined before Expo Router loads the screens.
import './src/push/background';
import 'expo-router/entry';
