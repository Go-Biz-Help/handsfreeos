import HfosKeyboard, { type KeyboardState } from '../../modules/hfos-keyboard';

export type { KeyboardState };

/**
 * What the Phone keyboard screen asks Android (modules/hfos-keyboard). An iPhone turns the keyboard on in its own
 * Settings and says nothing back, so these are null and false there; the keyboard itself tells the app it opened
 * (`readKeyboardSeenStamp`).
 */
export function keyboardState(): KeyboardState | null {
  try {
    return HfosKeyboard?.state() ?? null;
  } catch {
    return null;
  }
}

export function openKeyboardSettings(): boolean {
  try {
    return HfosKeyboard?.openSettings() ?? false;
  } catch {
    return false;
  }
}

export function showKeyboardPicker(): boolean {
  try {
    return HfosKeyboard?.showPicker() ?? false;
  } catch {
    return false;
  }
}
