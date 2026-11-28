import { requireNativeModule } from 'expo';

/**
 * What the app keeps for the parts of HandsFreeOS that run outside it: the keyboard (docs/phone-keyboard.md) and,
 * later, the home-screen widgets. Each part has a key ("keyboard", "widgets") holding one JSON string.
 *
 * iPhone: a file per key in the App Group every HandsFreeOS target shares (`group.com.gobizhelp.handsfreeos`, app.json
 * `ios.entitlements`), in a folder marked to stay out of backups. Android: the app's own preferences, which the
 * keyboard (part of the app there) reads directly, and which the app's backup rules already leave out.
 *
 * Neither is the encrypted copy of a business, so only what's fine outside the app's lock goes here: templates and
 * public links, never a customer's details or a sign-in.
 */
interface HfosSharedModule {
  /** Saves the JSON under the key, or removes it with null. False when it couldn't be saved. */
  write(key: string, json: string | null): boolean;
  /** What's saved under the key, or null. */
  read(key: string): string | null;
}

export default requireNativeModule<HfosSharedModule>('HfosShared');
