import { requireOptionalNativeModule } from 'expo';

/** Where Android has the HandsFreeOS keyboard. */
export interface KeyboardState {
  /** Switched on in the phone's keyboard settings. */
  readonly enabled: boolean;
  /** The keyboard the phone uses now. */
  readonly current: boolean;
}

/**
 * The Android half of the HandsFreeOS keyboard (docs/phone-keyboard.md): the keyboard itself is a service in this
 * module, and the app asks it whether it's switched on, opens the phone's keyboard settings and shows the phone's
 * keyboard picker. The iPhone keyboard is its own target (targets/keyboard), which iOS turns on in Settings; there is
 * no module there, so this is null.
 */
interface HfosKeyboardModule {
  state(): KeyboardState;
  /** Opens the phone's list of keyboards, where HandsFreeOS is switched on. False when it couldn't. */
  openSettings(): boolean;
  /** Shows the phone's keyboard picker. False when it couldn't. */
  showPicker(): boolean;
}

export default requireOptionalNativeModule<HfosKeyboardModule>('HfosKeyboard');
