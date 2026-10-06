// The app's entry. Android can start the app with no screen, just to show a push or run a notification's button, and
// iPhone can start it in the background to hand it where the phone is during a check-in, so the background tasks are
// defined before Expo Router loads the screens.
import './src/push/background';
import './src/safety/follow-task';
import 'expo-router/entry';
