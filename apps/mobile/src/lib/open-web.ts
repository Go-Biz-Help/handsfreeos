import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import HfosPhone from '../../modules/hfos-phone';

import { config } from './config';

/**
 * Opens a page of HandsFreeOS on the web, in the browser. The app claims app.handsfreeos.com/app/… links (so an email's
 * link opens the right screen), which means a plain "open this address" for one of those would come straight back to
 * the app on Android: there the browser is named. An iPhone hands an app's own links to Safari anyway.
 */
export async function openWeb(pathOrUrl: string): Promise<boolean> {
  const url = pathOrUrl.startsWith('/') ? `${config.webUrl}${pathOrUrl}` : pathOrUrl;
  try {
    if (Platform.OS === 'android') return await HfosPhone.openInBrowser(url);
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
