/**
 * GET /embed/v1/popup.js: a form or booking page in a pop-up on the business's own website (core's look/popup.ts,
 * which writes the code that loads it). Any element with `data-hfos-popup` opens its page in a centred window when
 * pressed: the button in the code, or the business's own button or link. The script tag itself can carry the same
 * part with `data-hfos-open="after"` (and `data-hfos-seconds`) or `"leave"`, and then the window opens by itself,
 * once a page. Closing one that opened by itself keeps it away for 7 days in that browser.
 *
 * The window shows the page's `?embed=1` address, so the page's own frame rule (its Sites allowed to show it) decides
 * whether it shows. Its box fits the page's height, as /embed/v1/form.js does, up to the screen's, and scrolls inside
 * past that. Plain ES5, no dependencies, and safe to load twice or beside form.js: each message is matched to the
 * window's own frame and believed only from the address that frame loads.
 */
import { POPUP_ATTR, POPUP_QUIET_DAYS } from '@hfos/core';
import { FORM_HEIGHT_MESSAGE } from './embed-script';

export const popupScript =
  (): string => `/* HandsFreeOS: forms and booking pages in a pop-up on your website. */
(function () {
  var URL_ATTR = '${POPUP_ATTR.url}', TITLE_ATTR = '${POPUP_ATTR.title}', OPEN_ATTR = '${POPUP_ATTR.opens}', SECONDS_ATTR = '${POPUP_ATTR.seconds}';
  var QUIET = ${POPUP_QUIET_DAYS} * 24 * 60 * 60 * 1000;
  var w = window;
  var me = document.currentScript;

  function pageOf(raw) {
    if (!raw) return null;
    try {
      var u = new URL(raw, location.href);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\\.0\\.0\\.1)$/.test(u.hostname))) return null;
      if (!/[?&]embed=1(&|$)/.test(u.search)) u.searchParams.set('embed', '1');
      return u;
    } catch (e) { return null; }
  }
  function quietKey(u) { return 'hfos-popup:' + u.origin + u.pathname; }
  function isQuiet(u) {
    try {
      var at = Number(w.localStorage.getItem(quietKey(u)));
      return at > 0 && Date.now() - at < QUIET;
    } catch (e) { return false; }
  }
  function keepQuiet(u) {
    try { w.localStorage.setItem(quietKey(u), String(Date.now())); } catch (e) {}
  }

  if (!w.__hfosPopup) {
    var state = { open: null };
    w.__hfosPopup = state;

    state.show = function (raw, title, from, byItself) {
      var u = pageOf(raw);
      if (!u || state.open) return;
      if (byItself && isQuiet(u)) return;
      var doc = document;
      var back = doc.createElement('div');
      back.setAttribute('data-hfos-popup-window', '');
      back.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;background:rgba(15,18,25,.55);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box';
      var box = doc.createElement('div');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', title || 'Form');
      box.style.cssText = 'position:relative;width:100%;max-width:640px;max-height:calc(100vh - 24px);background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:hidden;display:flex;flex-direction:column';
      var bar = doc.createElement('div');
      bar.style.cssText = 'display:flex;justify-content:flex-end;padding:6px 6px 0';
      var close = doc.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.innerHTML = '&times;';
      close.style.cssText = 'width:36px;height:36px;border:0;border-radius:18px;background:transparent;color:#4b5263;font:28px/1 system-ui,sans-serif;cursor:pointer';
      var frame = doc.createElement('iframe');
      frame.src = u.href;
      frame.title = title || 'Form';
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.style.cssText = 'display:block;width:100%;height:640px;max-height:calc(100vh - 72px);border:0;flex:1 1 auto';
      bar.appendChild(close);
      box.appendChild(bar);
      box.appendChild(frame);
      back.appendChild(box);
      var scroll = doc.documentElement.style.overflow;
      doc.documentElement.style.overflow = 'hidden';
      function shut() {
        if (state.open !== back) return;
        state.open = null;
        if (byItself) keepQuiet(u);
        doc.removeEventListener('keydown', onKey, true);
        w.removeEventListener('message', onMessage);
        if (back.parentNode) back.parentNode.removeChild(back);
        doc.documentElement.style.overflow = scroll;
        if (from && from.focus) try { from.focus(); } catch (e) {}
      }
      function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); shut(); }
        // Tab stays in the window: the close button and the page in it.
        if (e.key !== 'Tab') return;
        if (doc.activeElement === close && e.shiftKey) { e.preventDefault(); frame.focus(); }
        else if (doc.activeElement !== frame && doc.activeElement !== close) { e.preventDefault(); close.focus(); }
      }
      function onMessage(e) {
        if (e.source !== frame.contentWindow || e.origin !== u.origin) return;
        var d = e.data;
        if (!d || d.type !== '${FORM_HEIGHT_MESSAGE}' || typeof d.height !== 'number' || !isFinite(d.height)) return;
        frame.style.height = Math.max(120, Math.min(Math.ceil(d.height), 20000)) + 'px';
      }
      close.addEventListener('click', shut);
      back.addEventListener('click', function (e) { if (e.target === back) shut(); });
      doc.addEventListener('keydown', onKey, true);
      w.addEventListener('message', onMessage);
      state.open = back;
      (doc.body || doc.documentElement).appendChild(back);
      close.focus();
    };

    // Pressing anything with the part opens its page, the code's button or the business's own.
    document.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el.nodeType === 1) {
        if (el.hasAttribute(URL_ATTR) && el.tagName !== 'SCRIPT') {
          e.preventDefault();
          state.show(el.getAttribute(URL_ATTR), el.getAttribute(TITLE_ATTR), el, false);
          return;
        }
        el = el.parentNode;
      }
    }, true);

    state.byItself = function (tag) {
      if (!tag || tag.getAttribute('data-hfos-popup-armed')) return;
      var how = tag.getAttribute(OPEN_ATTR);
      var raw = tag.getAttribute(URL_ATTR);
      if (!raw || (how !== 'after' && how !== 'leave')) return;
      tag.setAttribute('data-hfos-popup-armed', '1');
      var u = pageOf(raw);
      if (!u || isQuiet(u)) return;
      var title = tag.getAttribute(TITLE_ATTR);
      if (how === 'after') {
        var s = Number(tag.getAttribute(SECONDS_ATTR));
        if (!isFinite(s) || s < 1) s = 10;
        w.setTimeout(function () { state.show(raw, title, null, true); }, Math.min(s, 300) * 1000);
        return;
      }
      // Going to leave: the pointer goes off the top of the window, on a computer only, after a few seconds there.
      if (!w.matchMedia || !w.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      var since = Date.now();
      function onOut(e) {
        if (e.relatedTarget || e.clientY > 0 || Date.now() - since < 3000) return;
        document.removeEventListener('mouseout', onOut);
        state.show(raw, title, null, true);
      }
      document.addEventListener('mouseout', onOut);
    };
  }

  // This copy's own tag, then any that loaded without saying which they were.
  w.__hfosPopup.byItself(me);
  var tags = document.querySelectorAll('script[' + URL_ATTR + '][' + OPEN_ATTR + ']');
  for (var i = 0; i < tags.length; i++) w.__hfosPopup.byItself(tags[i]);
})();
`;
