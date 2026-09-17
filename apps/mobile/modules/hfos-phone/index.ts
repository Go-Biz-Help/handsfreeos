import { requireNativeModule } from 'expo';

/**
 * What the app asks the phone itself: whether it's locked (Android; an iPhone checks before a button reaches the app),
 * opening a page on the web in the browser, never back in HandsFreeOS (the app claims app.handsfreeos.com/app/…), and
 * adding the business's number to Contacts.
 */
interface HfosPhoneModule {
  /** Android: locked with its PIN, pattern, password or fingerprint. iOS: always false (iOS checks itself). */
  isDeviceLocked(): boolean;
  /** Opens the address in the browser; false when the phone has none. */
  openInBrowser(url: string): Promise<boolean>;
  /**
   * Adds a contact through the phone's own New Contact screen, with no contacts permission. iOS: "added" or
   * "cancelled". Android: "opened" (it doesn't say whether it was saved). Either: "unavailable" with no contacts app.
   */
  addContact(
    name: string,
    phone: string,
  ): Promise<'added' | 'cancelled' | 'opened' | 'unavailable'>;
}

export default requireNativeModule<HfosPhoneModule>('HfosPhone');
