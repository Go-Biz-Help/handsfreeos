/**
 * The demo player's on-screen pointer: an arrow that glides to what a scene clicks and shows the click, so a
 * recording reads as someone using the app. It never takes clicks itself.
 */
const POINTER_ID = 'hfos-demo-pointer';
const MOVE_MS = 650;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let at: { x: number; y: number } | null = null;
let fade: ReturnType<typeof setTimeout> | null = null;

function pointer(): HTMLDivElement {
  const found = document.getElementById(POINTER_ID);
  if (found instanceof HTMLDivElement) return found;
  const el = document.createElement('div');
  el.id = POINTER_ID;
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '0',
    transition: `transform ${MOVE_MS}ms cubic-bezier(0.45, 0, 0.2, 1), opacity 250ms ease`,
    willChange: 'transform',
  });
  el.innerHTML = `
    <span data-ripple style="position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:9999px;background:rgba(45,105,216,0.35);opacity:0"></span>
    <svg width="26" height="30" viewBox="0 0 26 30" style="position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.35))">
      <path d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.8 L13.2 17 L21.5 17 Z" fill="#ffffff" stroke="#11151c" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;
  document.body.appendChild(el);
  return el;
}

/** The first match that's on screen: a CSS selector, or `@id` for a data-testid. */
export function find(target: string): HTMLElement | null {
  const selector = target.startsWith('@') ? `[data-testid="${target.slice(1)}"]` : target;
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
  }
  return null;
}

export async function waitFor(target: string, ms = 8000): Promise<HTMLElement> {
  const until = Date.now() + ms;
  for (;;) {
    const el = find(target);
    if (el) return el;
    if (Date.now() > until) throw new Error(`Couldn’t find ${target} on the screen.`);
    await sleep(100);
  }
}

/** Glides the pointer to the middle of `el`, scrolling it into view first when it's off screen. */
export async function pointAt(el: HTMLElement): Promise<void> {
  const box = el.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(450);
  }
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, 48);
  const y = r.top + r.height / 2;
  const p = pointer();
  if (fade) clearTimeout(fade);
  if (!at) {
    // The first move starts from the lower right, as a hand coming onto the screen would.
    at = { x: window.innerWidth * 0.72, y: window.innerHeight * 0.86 };
    p.style.transition = 'none';
    p.style.transform = `translate(${at.x}px, ${at.y}px)`;
    void p.offsetWidth;
    p.style.transition = `transform ${MOVE_MS}ms cubic-bezier(0.45, 0, 0.2, 1), opacity 250ms ease`;
  }
  p.style.opacity = '1';
  const far = Math.hypot(x - at.x, y - at.y) > 4;
  p.style.transform = `translate(${x}px, ${y}px)`;
  at = { x, y };
  if (far) await sleep(MOVE_MS + 60);
  fade = setTimeout(() => {
    p.style.opacity = '0';
  }, 5000);
}

/**
 * Points at `el`, shows the press, and clicks it. A browser "Are you sure?" the click opens says yes: the presenter
 * already chose this step, and the box would stop the scene halfway.
 */
export async function clickOn(el: HTMLElement): Promise<void> {
  await pointAt(el);
  const ripple = pointer().querySelector<HTMLElement>('[data-ripple]');
  ripple?.animate(
    [
      { opacity: 0.9, transform: 'scale(0.3)' },
      { opacity: 0, transform: 'scale(1.4)' },
    ],
    { duration: 450, easing: 'ease-out' },
  );
  await sleep(140);
  const ask = window.confirm;
  window.confirm = () => true;
  try {
    el.click();
  } finally {
    window.confirm = ask;
  }
}

export function removePointer(): void {
  document.getElementById(POINTER_ID)?.remove();
  at = null;
}
