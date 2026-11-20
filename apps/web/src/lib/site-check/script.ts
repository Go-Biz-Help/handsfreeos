/**
 * GET /embed/v1/site-check.js: the texting registration's browser check (owner, 2026-11-20; core's
 * `websites/site-pages.ts` says why). It runs on the business's own website, in the browser of the person who pressed
 * "Finish the check on my site" in HandsFreeOS, and only then: our chat loader (lib/chat/loader.ts) and form script
 * (lib/forms/embed-script.ts) load it when the address ends in `#hfos-check=<code>`, and do nothing more otherwise.
 *
 * What it does, in that one browser:
 * - takes the code out of the address bar at once, so it isn't passed on with a copied address;
 * - shows a small note at the bottom of the page, in a closed shadow root, saying what's happening;
 * - asks the worker which pages to read first (`/public/site-check/<code>`), then reads them, the site's sitemaps and
 *   the pages they link to, on this site only (its own address: the person's visit is the one the host already let
 *   in), a few at a time, up to the plan's `most`;
 * - sends each page to the worker, trimmed to what the checks read (core's `trimPageHtml`, whose source this carries),
 *   a few at a time, and says when it's done.
 * It reads nothing the person couldn't open themselves, keeps nothing in the browser, and never reads another site.
 */
import { SITE_CHECK_HASH, SITE_CHECK_LIMITS, trimPageHtml } from '@hfos/core';

const json = (v: unknown) => JSON.stringify(v);

/** The script, with the worker's address written in. */
export const siteCheckScript = (o: {
  readonly worker: string;
}): string => `/* HandsFreeOS: checking this site for its texting registration. */
(function () {
  if (window.__hfosSiteCheck) return;
  var m = /^#${SITE_CHECK_HASH}=([A-Za-z0-9_-]{32})$/.exec(location.hash);
  if (!m || !window.fetch || !window.DOMParser) return;
  window.__hfosSiteCheck = true;
  var code = m[1];
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  var W = ${json(o.worker)};
  var BATCH = ${SITE_CHECK_LIMITS.batch};
  var AT_ONCE = ${SITE_CHECK_LIMITS.concurrency};
  var CHARS = ${SITE_CHECK_LIMITS.pageChars};
  var base = W + '/public/site-check/' + code;
  var origin = location.origin;
  var stopAt = Date.now() + 3 * 60 * 1000;

  var host = document.createElement('hfos-site-check');
  var root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>:host{all:initial}div{position:fixed;z-index:2147483001;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100% - 32px);box-sizing:border-box;padding:12px 16px;border-radius:12px;background:#191d25;color:#fff;font:500 14px/1.45 system-ui,sans-serif;box-shadow:0 12px 32px #0005}b{font-weight:700;margin-right:6px}</style><div role="status" aria-live="polite"><b>HandsFreeOS</b><span></span></div>';
  var line = root.querySelector('span');
  function say(t) { line.textContent = t; }
  (document.body || document.documentElement).appendChild(host);
  say('Checking your site for your texting registration. Keep this tab open.');

  // Core's own trimPageHtml, carried here as its source: one way to trim a page, here and in the worker.
  var trimPage = ${trimPageHtml.toString()};
  function trim(html) { return trimPage(html, CHARS); }

  function failed(answer) {
    return (answer && answer.error && answer.error.message) || 'The check stopped. Go back to HandsFreeOS and try again.';
  }

  function get(url, ms) {
    var c = window.AbortController ? new AbortController() : null;
    var t = c ? setTimeout(function () { c.abort(); }, ms || 10000) : 0;
    return fetch(url, { credentials: 'same-origin', redirect: 'follow', signal: c ? c.signal : undefined })
      .finally(function () { clearTimeout(t); });
  }

  var seen = {};
  var queue = [];
  var most = 60;
  function add(raw, from) {
    var u;
    try { u = new URL(raw, from || location.href); } catch (e) { return; }
    if (u.origin !== origin) return;
    u.hash = '';
    if (/\\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|docx?|xlsx?|mp4|mov|mp3|wav|css|js|json|xml|txt|woff2?|ttf)$/i.test(u.pathname)) return;
    if (seen[u.href]) return;
    seen[u.href] = 1;
    queue.push(u.href);
  }

  var batch = [];
  var stopped = false;
  function post(pages, done) {
    return fetch(base + '/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages: pages, done: done })
    }).then(function (r) {
      if (r.ok) return;
      stopped = true;
      return r.json().catch(function () { return null; }).then(function (j) { say(failed(j)); });
    });
  }
  function flush(done) {
    var pages = batch;
    batch = [];
    return post(pages, done);
  }

  var read = 0;
  var busy = 0;
  function readOne(url) {
    read++;
    busy++;
    say('Checking your site: ' + read + (read === 1 ? ' page' : ' pages') + ' read. Keep this tab open.');
    return get(url)
      .then(function (res) {
        var type = res.headers.get('content-type') || '';
        if (!/html/i.test(type)) return;
        return res.text().then(function (html) {
          var at = res.url || url;
          if (at.indexOf(origin) === 0) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var links = doc.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) add(links[i].getAttribute('href'), at);
          }
          batch.push({ url: url, finalUrl: res.url || null, status: res.status, html: trim(html) });
          if (batch.length >= BATCH) return flush(false);
        });
      })
      .catch(function () {})
      .then(function () { busy--; });
  }

  function worker() {
    if (stopped) return Promise.resolve();
    if (!queue.length) {
      if (!busy || Date.now() > stopAt) return Promise.resolve();
      return new Promise(function (ok) { setTimeout(ok, 150); }).then(worker);
    }
    if (read >= most || Date.now() > stopAt) return Promise.resolve();
    return readOne(queue.shift()).then(worker);
  }

  function sitemaps() {
    var maps = [origin + '/sitemap.xml'];
    var opened = 0;
    function next() {
      if (!maps.length || opened >= 4) return Promise.resolve();
      var u;
      try { u = new URL(maps.shift(), origin); } catch (e) { return next(); }
      if (u.origin !== origin) return next();
      opened++;
      return get(u.href, 8000)
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (xml) {
          if (!/<(urlset|sitemapindex)\\b/i.test(xml)) return;
          var doc = new DOMParser().parseFromString(xml, 'application/xml');
          var index = doc.getElementsByTagName('sitemapindex').length > 0;
          var locs = doc.getElementsByTagName('loc');
          for (var i = 0; i < locs.length; i++) {
            var at = (locs[i].textContent || '').trim();
            if (index) maps.push(at); else add(at);
          }
        })
        .catch(function () {})
        .then(next);
    }
    return get(origin + '/robots.txt', 5000)
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        if (/<html[\\s>]/i.test(txt)) return;
        txt.split(/\\r?\\n/).forEach(function (l) {
          var s = /^\\s*sitemap:\\s*(\\S+)/i.exec(l);
          if (s) maps.unshift(s[1]);
        });
      })
      .catch(function () {})
      .then(next);
  }

  fetch(base, { credentials: 'omit' })
    .then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j) throw j;
        return j;
      });
    })
    .then(function (plan) {
      most = plan.most || most;
      add(location.href);
      (plan.urls || []).forEach(function (u) { add(u); });
      // The first pages alone, so their links are queued before the others start.
      var first = queue.splice(0, AT_ONCE);
      return Promise.all(first.map(readOne))
        .then(sitemaps)
        .then(function () {
          var all = [];
          for (var i = 0; i < AT_ONCE; i++) all.push(worker());
          return Promise.all(all);
        })
        .then(function () { if (!stopped) return flush(true); })
        .then(function () {
          if (stopped) return;
          say('Done: ' + read + (read === 1 ? ' page' : ' pages') + ' read. Go back to HandsFreeOS, where the check carries on. You can close this tab.');
          setTimeout(function () { host.remove(); }, 20000);
        });
    })
    .catch(function (err) { say(failed(err)); });
})();
`;
