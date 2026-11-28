/**
 * A website chat's greeting bubble (design tools, part 4): a few words ("Need a quote? I can help.") that pop up beside
 * the chat's button after some seconds on the page, with the face from the chat's top bar when it has one. It's a
 * second script the loader route adds after the loader (lib/chat/loader.ts), only for a chat that has a bubble, so the
 * usual loader stays under 3 KB.
 *
 * - It waits for the loader's button (<hfos-chat>), and stays away while the chat is open.
 * - Pressing its words opens the chat the way a link to #hfos-chat does: the address shows #hfos-chat for a moment,
 *   the loader hears of it, and the address goes back as it was, with nothing added to the browser's history.
 * - Closing it, or opening the chat any way, keeps it away for the rest of the visit (sessionStorage), so it never
 *   nags on every page.
 * - Drawn in a closed shadow root like the button, so the site's styles can't reach it; its words go in as text.
 * - Sits above the button, placed as the button is on computers and on phones (hidden on phones when the button is).
 */
import { chatFontOf, chatRadiiOf, type ChatCorners, type ChatPlacement } from '@hfos/core';
import { launcherFont } from './loader';

export interface BubbleOptions {
  /** The widget's public key: the bubble is kept away per chat. */
  readonly key: string;
  readonly text: string;
  /** Seconds on the page before it shows. */
  readonly after: number;
  /** The face in the chat's top bar, at its web address; null: words only. */
  readonly face: string | null;
  readonly placement: ChatPlacement;
  readonly corners: ChatCorners | null;
  readonly font: string | null;
  /** The chat's colour, for the ring a keyboard's focus draws. */
  readonly accent: string;
}

/** The button is 54 pixels high; the bubble sits 14 above it. */
const ABOVE = 68;

function styles(o: BubbleOptions): string {
  const side = o.placement.desktop.position;
  const other = side === 'left' ? 'right' : 'left';
  const m = o.placement.mobile;
  const radius = chatRadiiOf(o.corners).bubble;
  const font = launcherFont(chatFontOf(o.font));
  const phone =
    m.button === 'hidden'
      ? 'display:none'
      : [
          m.position !== side ? `${other}:16px;${side}:auto` : `${side}:16px`,
          `bottom:calc(var(--b) + ${ABOVE + m.lift}px)`,
          'max-width:calc(100vw - 32px)',
        ].join(';');
  return [
    ':host{all:initial;--b:max(20px,env(safe-area-inset-bottom))}',
    `div{position:fixed;z-index:2147483000;${side}:24px;bottom:calc(var(--b) + ${ABOVE + o.placement.desktop.lift}px);display:flex;align-items:flex-start;gap:10px;box-sizing:border-box;max-width:min(300px,calc(100vw - 48px));padding:12px 10px 12px 14px;background:#fff;color:#191d25;border-radius:${radius};box-shadow:0 10px 30px #0003,0 0 0 1px #0000000f;font:500 14px/1.4 ${font};animation:u .25s ease-out}`,
    'img{width:32px;height:32px;border-radius:50%;object-fit:cover;flex:none}',
    'button{all:unset;cursor:pointer;box-sizing:border-box}',
    '.t{flex:1;min-width:0;overflow-wrap:anywhere;padding-top:1px}',
    '.x{flex:none;width:26px;height:26px;margin:-4px 0 0;display:flex;align-items:center;justify-content:center;border-radius:50%;color:#5b6270;font:400 20px/1 system-ui}',
    '.x:hover{background:#0000000d}',
    `button:focus-visible{outline:2px solid ${o.accent};outline-offset:2px}`,
    '@keyframes u{from{opacity:0;transform:translateY(8px)}}',
    '@media(prefers-reduced-motion:reduce){div{animation:none}}',
    `@media(max-width:480px){:host{--b:max(16px,env(safe-area-inset-bottom))}div{${phone}}}`,
  ].join('');
}

// k: kept away for this visit; h: the loader's button; b: the bubble; r: its shadow root; t: its words; x: Close;
// o: watches the chat open; n: tries waiting for the button.
const BODY =
  '((w,d)=>{if(w.hfosBubble)return;w.hfosBubble=1;const k="hfos-bubble:"+K,' +
  'keep=()=>{try{sessionStorage.setItem(k,"1")}catch(e){}};' +
  'try{if(sessionStorage.getItem(k))return}catch(e){}let n=0;' +
  'const go=()=>{const h=d.querySelector("hfos-chat");if(!h){if(n++<20)setTimeout(go,1e3);return}' +
  'if(h.hasAttribute("open"))return;' +
  'const b=d.createElement("hfos-bubble"),r=b.attachShadow({mode:"closed"});' +
  'r.innerHTML="<style>"+C+"</style><div aria-live=polite>"+(F?"<img alt=\\"\\">":"")+' +
  '"<button type=button class=t></button><button type=button class=x aria-label=Close>\\u00d7</button></div>";' +
  'const[t,x]=r.querySelectorAll("button"),i=r.querySelector("img");if(i)i.src=F;t.textContent=T;' +
  'const o=new MutationObserver(()=>h.hasAttribute("open")&&end()),' +
  'end=()=>{keep();o.disconnect();b.remove()};o.observe(h,{attributes:true});x.onclick=end;' +
  't.onclick=()=>{end();const u=location.href,s=history.state;history.replaceState(s,"","#hfos-chat");' +
  'dispatchEvent(new HashChangeEvent("hashchange"));history.replaceState(s,"",u)};d.body.append(b)};' +
  'setTimeout(go,S*1e3)})(window,document)';

const json = (v: unknown) => JSON.stringify(v);

/** The bubble's script for one chat, its words and look written in. */
export function bubbleScript(o: BubbleOptions): string {
  const consts = [
    `K=${json(o.key)}`,
    `T=${json(o.text)}`,
    `S=${json(o.after)}`,
    `F=${json(o.face ?? '')}`,
    `C=${json(styles(o))}`,
  ].join(',');
  return `/*HandsFreeOS chat bubble*/{const ${consts};${BODY}}\n`;
}
