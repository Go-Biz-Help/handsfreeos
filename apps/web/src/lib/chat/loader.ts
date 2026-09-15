/**
 * The loader businesses paste once on their site:
 *
 *   <script async src="https://app.handsfreeos.com/embed/v1/wk_….js"></script>
 *
 * "v1" is a contract that won't break. It stays under 3 KB (chat-settings.spec.ts checks) and:
 * - starts once the page is idle, and draws its button inside a closed shadow root, so the site's styles can't
 *   reach it and the site's scripts can't reach in;
 * - preconnects to HandsFreeOS on hover or focus, and creates the chat window (an iframe of /chat/<key>) on the
 *   first click, or at once when the address ends in #hfos-chat (the link in an unread reply's follow-up);
 * - swaps only three messages with the window, each checked against the other side's origin: "open" (to the
 *   window, with the page's path), "close" and "unread" (from it). No token ever passes: the window keeps its
 *   own, in its own storage;
 * - on phones turns the window into a full-screen sheet, clear of the notch and home bar, and locks the page's
 *   scroll while it's open;
 * - removes itself when the window never answers: the browser refused to show it (frame-ancestors), so this
 *   isn't one of the widget's sites. The console says so, for whoever is installing it.
 * The host element, <hfos-chat>, has an `open` attribute while the chat is open.
 */
import { readableTextOn } from '@hfos/core';

export interface LoaderOptions {
  /** This app's origin, like https://app.handsfreeos.com. */
  readonly app: string;
  readonly key: string;
  readonly business: string;
  readonly label: string;
  readonly accent: string;
  readonly position: 'left' | 'right';
  /** The preview page's workspace: its chat window answers through the test console instead. */
  readonly preview: string | null;
}

/** The chat icon, as on the launcher in the design (round caps turn the three zero-length strokes into dots). */
const ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12zM8.5 12h0m4 0h0m4 0h0"/></svg>';

/** The launcher and window's styles. The window animates itself (and respects reduced motion). */
function styles(accent: string, text: string, side: 'left' | 'right'): string {
  return [
    ':host{all:initial;--b:max(20px,env(safe-area-inset-bottom))}',
    `button,iframe{position:fixed;z-index:2147483000;${side}:24px}`,
    `button{bottom:var(--b);display:flex;align-items:center;gap:9px;height:54px;padding:0 20px 0 17px;border:0;border-radius:99px;background:${accent};color:${text};font:600 15px system-ui;box-shadow:0 8px 24px #0004;cursor:pointer}`,
    'svg{width:22px;height:22px}',
    `i{position:absolute;top:-5px;${side}:-5px;min-width:11px;padding:0 5px;border-radius:99px;background:#191d25;color:#fff;font:700 11px/21px system-ui;text-align:center;box-shadow:0 0 0 2px #fff}`,
    'iframe{bottom:20px;width:380px;height:min(704px,100% - 40px);border:0;border-radius:16px;box-shadow:0 24px 60px #0004}',
    // A replaced element doesn't stretch between top and bottom, so the sheet's height is written out.
    `@media(max-width:480px){:host{--b:max(16px,env(safe-area-inset-bottom))}button{${side}:16px}iframe{inset:env(safe-area-inset-top) 0 auto;width:100%;height:calc(100% - env(safe-area-inset-top) - env(safe-area-inset-bottom));border-radius:0;box-shadow:0 0 0 99vmax ${accent}}}`,
    '[hidden]{display:none!important}',
  ].join('');
}

// The script itself, hand-kept short. h: the host element; r: its shadow root; b: the button; g: the unread
// badge; f: the chat window; t: the "never answered" timer; v: the page's overflow while locked (the root
// element's, which scrolls the page); k: the preconnect link; o: open; y: the window has answered. "unread"
// carries a count only: no message text ever reaches the page.
const BODY =
  '((w,d)=>{if(w.hfosChat)return;w.hfosChat=1;let h,r,b,g,f,t,v,k,o=0,y=0;' +
  'const z=location,e=d.documentElement.style,a=addEventListener,c=x=>d.createElement(x),u=encodeURIComponent,' +
  'm=x=>f.contentWindow.postMessage({hfos:x,path:z.pathname},A),' +
  'lk=x=>{if(!x)v&&(e.overflow=v[0]),v=0;else if(matchMedia("(max-width:480px)").matches)v=[e.overflow],e.overflow="hidden"},' +
  'st=x=>{o=x;h.toggleAttribute("open",x);b.hidden=x;g.hidden=1;lk(x)},' +
  'op=()=>{if(o||!h)return;st(1);if(f)f.hidden=0,m("open");else{f=c("iframe");f.title=L;' +
  'f.src=A+"/chat/"+K+"?o="+u(z.origin)+"&p="+u(z.pathname)+V;f.onload=()=>y||(t=setTimeout(gone,6e3));r.append(f)}f.focus()},' +
  'cl=()=>{if(o){st(0);f.hidden=1;b.focus()}},' +
  'gone=()=>{cl();h.remove();console.warn("HandsFreeOS chat is not set up for "+z.origin)},' +
  'hs=()=>z.hash=="#hfos-chat"&&op(),' +
  'mk=()=>{h=c("hfos-chat");r=h.attachShadow({mode:"closed"});' +
  'r.innerHTML="<style>"+C+"</style><button type=button>"+I+"<span></span><i hidden></i></button>";' +
  '[b,g]=r.querySelectorAll("button,i");b.children[1].textContent=L;b.onclick=op;' +
  'b.onpointerenter=b.onfocus=()=>{if(!k)k=c("link"),k.rel="preconnect",k.href=A,d.head.append(k)};d.body.append(h);hs()},' +
  'go=()=>(w.requestIdleCallback||setTimeout)(mk,{timeout:3e3});' +
  'a("message",x=>{let q=x.data,n;if(x.source!=f?.contentWindow||x.origin!=A||!q?.hfos)return;y=1;clearTimeout(t);' +
  'if(q.hfos=="close")cl();if(q.hfos=="unread")n=+q.n||0,g.textContent=n,g.hidden=!n||o});' +
  'a("keydown",x=>x.key=="Escape"&&cl());a("hashchange",hs);' +
  'd.readyState=="complete"?go():a("load",go)})(window,document)';

const json = (v: string) => JSON.stringify(v);

/** The loader for one widget, its look written in (the route keeps it for 5 minutes). */
export function loaderScript(o: LoaderOptions): string {
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent.toLowerCase() : '#2d69d8';
  const side = o.position === 'left' ? 'left' : 'right';
  const consts = [
    `A=${json(o.app)}`,
    `K=${json(o.key)}`,
    `V=${json(o.preview ? `&preview=${o.preview}` : '')}`,
    `L=${json(o.label)}`,
    `C=${json(styles(accent, readableTextOn(accent), side))}`,
    `I=${json(ICON)}`,
  ].join(',');
  return `/*HandsFreeOS chat v1*/{const ${consts};${BODY}}\n`;
}
