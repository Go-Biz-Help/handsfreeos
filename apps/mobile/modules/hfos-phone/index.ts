import type { PickedContact } from '@hfos/core';
import { requireNativeModule } from 'expo';

/**
 * What the app asks the phone itself: whether it's locked (Android; an iPhone checks before a button reaches the app),
 * opening a page on the web in the browser, never back in HandsFreeOS (the app claims app.handsfreeos.com/app/…),
 * adding the business's number to Contacts, picking a customer from the phone's contacts, and showing a document the
 * phone keeps.
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
  /**
   * Lets the person pick one contact in the phone's own picker, which hands over only the contact picked, so the app
   * asks for no contacts permission. iOS: the card's names, company, numbers, emails and addresses. Android: the name
   * and the one number picked. "cancelled", or "unavailable" when the phone has no picker to show.
   */
  pickContact(): Promise<PickedContact | 'cancelled' | 'unavailable'>;
  /**
   * Shows a file the app decrypted into its cache (a document kept on the phone). iOS: Quick Look inside the app,
   * "closed" once it's closed. Android: the phone's viewer for its type, "opened" (it doesn't say when it's closed).
   * Either: "unavailable" when nothing can show it.
   */
  viewFile(path: string, mimeType: string): Promise<'closed' | 'opened' | 'unavailable'>;
}

export default requireNativeModule<HfosPhoneModule>('HfosPhone');
