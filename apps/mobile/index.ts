// The app's entry. Android can start the app with no screen, just to show a push or run a notification's button, and
// iPhone can start it in the background to hand it where the phone is during a check-in, so the background tasks are
// defined before Expo Router loads the screens. Android also starts it with no screen to draw a home-screen widget.
import './src/push/background';
import './src/safety/follow-task';
import './src/widgets/android-task';
import 'expo-router/entry';
