'use client';
import { Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Somewhere to sign with a finger, a pen or a mouse (M17).
 *
 * Always white with dark ink, whatever the theme: it stands for the paper the letter is printed on, and the
 * ink is what lands on the PDF. What comes out is a PNG with a transparent background, so the signature sits
 * on the letter's line rather than in a white box.
 */
export function SignaturePad({
  onChange,
  label,
  testId,
}: {
  /** A PNG data URL once something is drawn; null when it is cleared. */
  onChange: (png: string | null) => void;
  label: string;
  testId?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  // Drawn at the screen's real pixel density, so the signature on the letter is not blurred.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    c.width = Math.round(c.clientWidth * ratio);
    c.height = Math.round(c.clientHeight * ratio);
  }, []);

  /** Where the pointer is, in the canvas's own pixels — which differ from the page's if it was resized. */
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
    g.strokeStyle = '#111827';
    g.lineWidth = Math.max(2, c.width / 260);
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
    setEmpty(true);
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        className="block h-32 w-full cursor-crosshair touch-none rounded-control border border-border-strong bg-white"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e);
          last.current = p;
          // A dot, so a tap leaves a mark the way a pen would.
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
          setEmpty(false);
          onChange(canvas.current?.toDataURL('image/png') ?? null);
        }}
        onPointerCancel={() => {
          last.current = null;
        }}
        data-testid={testId}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-xs text-text-3">
          {empty ? 'Sign in the box with your finger, a pen or the mouse.' : 'Signed.'}
        </span>
        <Button variant="ghost" size="sm" onClick={clear} disabled={empty}>
          <Eraser className="h-3.5 w-3.5" strokeWidth={1.8} />
          Clear
        </Button>
      </div>
    </div>
  );
}
