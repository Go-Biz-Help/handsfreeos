'use client';

/**
 * When the blog cannot be read — Opinly down, slow, or the key missing — this takes the page's place, inside
 * the site's own header and footer. A post that was already built keeps serving its last good copy and never
 * gets here; this is for the page nobody had asked for yet.
 */
import { useEffect } from 'react';
import { Button, Container } from '@/components/ui';

export default function BlogError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // The digest matches the server log line, which carries Opinly's request id.
    console.error('[blog]', error.digest ?? error.message);
  }, [error]);

  return (
    <Container className="py-28 text-center">
      <div role="alert">
        <p className="text-accent-text text-sm font-semibold tracking-[0.14em] uppercase">
          Blog unavailable
        </p>
        <h1 className="mt-4 text-4xl font-bold">The articles did not load.</h1>
        <p className="text-text-2 mx-auto mt-4 max-w-md text-lg">
          That is on our side, not yours. Try again in a moment — the rest of the site is working.
        </p>
      </div>
      <div className="mt-8 flex justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="bg-accent hover:bg-accent-hover inline-flex items-center justify-center gap-2 rounded-[10px] px-5 py-2.5 text-base font-semibold text-white shadow-[var(--shadow-2)] transition-colors"
        >
          Try again
        </button>
        <Button href="/" variant="secondary">
          Go to the front page
        </Button>
      </div>
    </Container>
  );
}
