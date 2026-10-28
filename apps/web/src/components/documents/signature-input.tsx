'use client';
/**
 * Signing: drawn with a finger, a pen or the mouse, or typed in a handwriting style (answer 12a). Either way what's
 * kept is a PNG of just the ink, cropped close, with a see-through background so it sits on the line of the page.
 */
import {
  SIGNATURE_IMAGE_MAX,
  SIGNATURE_STYLES,
  SIGNING_WORDS,
  type SignatureStyle,
} from '@hfos/core';
import { Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { SIGNATURE_FONTS } from '@/lib/documents/signature-fonts';
import { cn } from '@/lib/utils';

export interface SignatureValue {
  readonly kind: 'signature';
  readonly how: 'drawn' | 'typed';
  readonly image: string;
  readonly name: string;
  readonly style: SignatureStyle | null;
}

const INK = '#111827';

/** The ink of a canvas, cropped to what was drawn and made small enough to keep. Null when nothing was. */
export function inkPng(source: HTMLCanvasElement, maxWidth = 600, maxHeight = 200): string | null {
  const g = source.getContext('2d', { willReadFrequently: true });
  if (!g || !source.width || !source.height) return null;
  const { data, width, height } = g.getImageData(0, 0, source.width, source.height);
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]! > 24) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  if (right < 0) return null;
  const pad = Math.round(Math.max(4, (bottom - top) * 0.06));
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const w = right - left + 1;
  const h = bottom - top + 1;
  for (let limit = 1; limit > 0.2; limit -= 0.25) {
    const scale = Math.min(1, (maxWidth * limit) / w, (maxHeight * limit) / h);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    const o = out.getContext('2d');
    if (!o) return null;
    o.imageSmoothingQuality = 'high';
    o.drawImage(source, left, top, w, h, 0, 0, out.width, out.height);
    const png = out.toDataURL('image/png');
    if (png.length <= SIGNATURE_IMAGE_MAX) return png;
  }
  return null;
}

/** A name written in a handwriting font, as a picture. */
async function typedPng(name: string, style: SignatureStyle): Promise<string | null> {
  const font = SIGNATURE_FONTS[style];
  const size = 96;
  const spec = `${font.weight} ${size}px ${font.family}`;
  try {
    await document.fonts.load(spec, name);
  } catch {
    // Drawn in whatever the browser has: still their name.
  }
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.font = spec;
  const width = Math.ceil(g.measureText(name).width + size);
  canvas.width = Math.min(4000, width);
  canvas.height = Math.round(size * 1.9);
  g.font = spec;
  g.fillStyle = INK;
  g.textBaseline = 'middle';
  g.fillText(name, size / 2, canvas.height / 2);
  return inkPng(canvas);
}

/** Initials from a name: "Maria L. Garza" is "MLG". */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) =>
      w
        .replace(/[^\p{L}]/gu, '')
        .slice(0, 1)
        .toUpperCase(),
    )
    .join('')
    .slice(0, 4);

export function SignatureInput({
  initials,
  name,
  onAdopt,
  busy,
}: {
  /** Initials rather than a whole signature. */
  initials?: boolean;
  /** Who's signing, to start the typed one with. */
  name: string;
  onAdopt: (value: SignatureValue) => void;
  busy?: boolean;
}) {
  const [how, setHow] = useState<'drawn' | 'typed'>('typed');
  const [typed, setTyped] = useState(initials ? initialsOf(name) : name);
  const [style, setStyle] = useState<SignatureStyle>('dancing');
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (how !== 'drawn') return;
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    c.width = Math.round(c.clientWidth * ratio);
    c.height = Math.round(c.clientHeight * ratio);
    setDrawn(false);
  }, [how]);

  function at(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * c.width) / r.width,
      y: ((e.clientY - r.top) * c.height) / r.height,
    };
  }

  function stroke(from: { x: number; y: number }, to: { x: number; y: number }) {
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.strokeStyle = INK;
    g.lineWidth = Math.max(2.5, c.width / 220);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke();
  }

  function clear() {
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  }

  async function adopt() {
    setError(null);
    if (how === 'typed') {
      const text = typed.trim();
      if (!text) {
        setError(initials ? 'Type your initials.' : 'Type your name.');
        return;
      }
      const image = await typedPng(text, style);
      if (!image) {
        setError('That didn’t work in this browser. Try drawing it instead.');
        return;
      }
      onAdopt({ kind: 'signature', how: 'typed', image, name: text.slice(0, 120), style });
      return;
    }
    const image = canvas.current ? inkPng(canvas.current) : null;
    if (!image) {
      setError(initials ? 'Draw your initials in the box.' : 'Sign in the box first.');
      return;
    }
    onAdopt({
      kind: 'signature',
      how: 'drawn',
      image,
      name: (name.trim() || 'Signed').slice(0, 120),
      style: null,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={how}
        onChange={setHow}
        fill
        ariaLabel="How to sign"
        options={[
          { value: 'typed', label: SIGNING_WORDS.type, testId: 'signature-typed' },
          { value: 'drawn', label: SIGNING_WORDS.draw, testId: 'signature-drawn' },
        ]}
      />
      {how === 'typed' ? (
        <>
          <div>
            <Label htmlFor="signature-name">
              {initials ? 'Your initials' : SIGNING_WORDS.typeYourName}
            </Label>
            <Input
              id="signature-name"
              inputSize="lg"
              autoComplete={initials ? 'off' : 'name'}
              value={typed}
              maxLength={initials ? 6 : 120}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="signature-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Handwriting">
            {SIGNATURE_STYLES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={style === s}
                onClick={() => setStyle(s)}
                className={cn(
                  'flex h-16 items-center justify-center overflow-hidden rounded-control border bg-white px-2 text-[26px] leading-none text-[#111827]',
                  style === s ? 'border-accent ring-[3px] ring-ring' : 'border-border-strong',
                  SIGNATURE_FONTS[s].className,
                )}
                data-testid={`signature-style-${s}`}
              >
                <span className="truncate">{typed.trim() || (initials ? 'AB' : 'Your name')}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div>
          <canvas
            ref={canvas}
            role="img"
            aria-label={initials ? 'Draw your initials' : 'Draw your signature'}
            className={cn(
              'block w-full cursor-crosshair touch-none rounded-control border border-border-strong bg-white',
              initials ? 'h-28' : 'h-40',
            )}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = at(e);
              last.current = p;
              stroke(p, { x: p.x + 0.1, y: p.y + 0.1 });
            }}
            onPointerMove={(e) => {
              if (!last.current) return;
              const p = at(e);
              stroke(last.current, p);
              last.current = p;
            }}
            onPointerUp={() => {
              if (!last.current) return;
              last.current = null;
              setDrawn(true);
            }}
            onPointerCancel={() => {
              last.current = null;
            }}
            data-testid="signature-pad"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-xs text-text-3">
              {drawn ? ' ' : 'Sign in the box with your finger, a pen or the mouse.'}
            </span>
            <Button variant="ghost" size="sm" onClick={clear} disabled={!drawn}>
              <Eraser className="h-3.5 w-3.5" strokeWidth={1.8} />
              {SIGNING_WORDS.clear}
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {error}
        </p>
      ) : null}
      <Button
        size="lg"
        className="w-full"
        loading={busy}
        onClick={() => void adopt()}
        data-testid="signature-adopt"
      >
        {SIGNING_WORDS.adopt}
      </Button>
    </div>
  );
}
