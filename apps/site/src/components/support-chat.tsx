import Script from 'next/script';
import { chatScript, urls } from '@/content/site';

/**
 * The chat button on handsfreeos.com (M13).
 *
 * It is the same widget a business puts on its own site — HandsFreeOS answering for HandsFreeOS, and the
 * texting-consent chat the A2P review is sent to. It loads `chatScript`, the snippet made in the app (Settings →
 * Website chat); a widget key in `NEXT_PUBLIC_CHAT_WIDGET_KEY` loads that widget instead, say for a preview.
 */
export function SupportChat() {
  const key = process.env.NEXT_PUBLIC_CHAT_WIDGET_KEY;
  const src =
    key && /^wk_[A-Za-z0-9]{20}$/.test(key) ? `${urls.app}/embed/v1/${key}.js` : chatScript;
  return <Script async src={src} strategy="afterInteractive" />;
}
