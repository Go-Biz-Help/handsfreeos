import { requireNativeModule } from 'expo';

/**
 * What the app asks the phone itself: whether it's locked (Android; an iPhone checks before a button reaches the app),
 * and opening a page on the web in the browser, never back in HandsFreeOS (the app claims app.handsfreeos.com/app/…).
 */
interface HfosPhoneModule {
  /** Android: locked with its PIN, pattern, password or fingerprint. iOS: always false (iOS checks itself). */
  isDeviceLocked(): boolean;
  /** Opens the address in the browser; false when the phone has none. */
  openInBrowser(url: string): Promise<boolean>;
}

export default requireNativeModule<HfosPhoneModule>('HfosPhone');
