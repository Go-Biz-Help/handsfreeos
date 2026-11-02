/**
 * GET /embed/v1/form.js: the one line a business pastes under a form's iframe, so the box grows and shrinks with the
 * form (the owner's 4a, 2026-11-02): no scroll bar inside it, and no gap under a short one. The form's page, embedded,
 * says how tall it is (components/forms/embed-height.tsx); this sets the height of the iframe that said it.
 *
 * Plain ES5, no dependencies, and safe to paste twice or beside other forms: each message is matched to its own
 * iframe by the window it came from, and only believed from the address that iframe loads. A snippet pasted before
 * this existed keeps its fixed height.
 */
export const FORM_HEIGHT_MESSAGE = 'hfos:form-height';

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
      return;
    }
  });
})();
`;
