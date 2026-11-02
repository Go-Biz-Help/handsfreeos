'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { FORM_HEIGHT_MESSAGE } from '@/lib/forms/embed-script';

/**
 * A form on someone's website tells the page around it how tall it is, whenever that changes (a question shows, the
 * "are you a person" check opens, it's sent), so /embed/v1/form.js can fit its box to it. The height isn't private,
 * so it goes to whatever page holds it; the script there only believes it from the form's own address.
 */
export function EmbedHeight({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.parent === window) return;
    let last = 0;
    const send = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: FORM_HEIGHT_MESSAGE, height }, '*');
    };
    const observer = new ResizeObserver(send);
    observer.observe(el);
    send();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="p-1" data-testid="form-embed">
      {children}
    </div>
  );
}
