import Script from 'next/script';
import { urls } from '@/content/site';

/**
 * Matomo Tag Manager for handsfreeos.com. What it counts is set up in the container at gobizhelp.matomo.cloud, not
 * here: this only loads it, and only on the live site, so `next dev` and Vercel previews count nothing. The site
 * changes pages without reloading, so the container needs a History Change trigger on its page view tag as well as
 * the usual Pageview one. `/privacy` says what is counted; keep the two in step.
 */
const CONTAINER = 'https://cdn.matomo.cloud/gobizhelp.matomo.cloud/container_E8zmrEO3.js';
const HOST = new URL(urls.site).host;

export function Matomo() {
  return (
    <Script id="matomo-tag-manager" strategy="afterInteractive">
      {`(function() {
  if (location.host !== '${HOST}') return;
  var _mtm = window._mtm = window._mtm || [];
  _mtm.push({'mtm.startTime': (new Date().getTime()), 'event': 'mtm.Start'});
  var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
  g.async=true; g.src='${CONTAINER}'; s.parentNode.insertBefore(g,s);
})();`}
    </Script>
  );
}
