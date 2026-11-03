/**
 * GET /embed/v1/form.js: the one line a business pastes under a form's iframe, so the box grows and shrinks with the
 * form (the owner's 4a, 2026-11-02): no scroll bar inside it, and no gap under a short one. The form's page, embedded,
 * says how tall it is (components/forms/embed-height.tsx); this sets the height of the iframe that said it.
 *
 * Plain ES5, no dependencies, and safe to paste twice or beside other forms: each message is matched to its own
 * iframe by the window it came from, and only believed from the address that iframe loads. A snippet pasted before
 * this existed keeps its fixed height.
 *
 * Some site builders put pasted code in a frame of their own (GoDaddy's HTML section: an `srcdoc` frame on the site's
 * own address), sized once when the page loads, before the form has said how tall it is. Inside one of those, the
 * script grows that frame too, or the form would be cut off at the builder's first guess.
 */
export const FORM_HEIGHT_MESSAGE = 'hfos:form-height';
/** What the script asks each form when it starts, in case the form spoke before anyone was listening. */
export const FORM_HEIGHT_ASK = 'hfos:form-height-ask';

export const formEmbedScript =
  (): string => `/* HandsFreeOS forms: each form's box grows to fit it. */
(function () {
  if (window.__hfosFormHeights) return;
  window.__hfosFormHeights = true;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== '${FORM_HEIGHT_MESSAGE}' || typeof d.height !== 'number' || !isFinite(d.height)) return;
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (f.contentWindow !== e.source) continue;
      var from;
      try { from = new URL(f.src, location.href).origin; } catch (err) { return; }
      if (from !== e.origin) return;
      var h = Math.max(80, Math.min(Math.ceil(d.height), 20000));
      f.style.height = h + 'px';
      f.setAttribute('height', String(h));
      fitHolder(f);
      return;
    }
  });
  // A form that loaded before this script said its height to nobody: ask each one to say it again.
  var all = document.getElementsByTagName('iframe');
  for (var j = 0; j < all.length; j++) {
    var g = all[j];
    if (!/[?&]embed=1(&|$)/.test(g.src) || !g.contentWindow) continue;
    try { g.contentWindow.postMessage({ type: '${FORM_HEIGHT_ASK}' }, new URL(g.src, location.href).origin); } catch (err) {}
  }
  function fitHolder(f) {
    if (location.href !== 'about:srcdoc') return;
    var holder = null;
    try { holder = window.frameElement; } catch (err) { return; }
    var b = document.body;
    if (!holder || !b) return;
    var y = window.pageYOffset || 0;
    var below = parseFloat(window.getComputedStyle(b).marginBottom) || 0;
    // The body's end, or the form's own if the body stops short of it (a builder's height:100%).
    var end = Math.max(b.getBoundingClientRect().bottom, f.getBoundingClientRect().bottom) + y + below;
    if (end > 0) holder.style.height = Math.ceil(end) + 'px';
  }
})();
`;
