import Script from 'next/script';
import { urls } from '@/content/site';

/**
 * The chat button on handsfreeos.com (M13).
 *
 * It is the same widget a business puts on its own site — HandsFreeOS answering for HandsFreeOS. The key
 * comes from the environment because the widget is made in the app (Settings → Website chat) and its key is
 * not knowable at build time; with no key set the site simply has no chat, and the support page's email and
 * the in-app "Get help" still work.
 */
export function SupportChat() {
  const key = process.env.NEXT_PUBLIC_CHAT_WIDGET_KEY;
  if (!key || !/^wk_[A-Za-z0-9]{20}$/.test(key)) return null;
  return <Script async src={`${urls.app}/embed/v1/${key}.js`} strategy="afterInteractive" />;
}
