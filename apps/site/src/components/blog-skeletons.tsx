/**
 * What a blog page looks like while it loads: the same layout, in outline. Announced once to screen readers;
 * the shapes themselves are decoration.
 *
 * Each `loading.tsx` under app/blog sits *below* a layout that has already checked the post, category, tag or
 * author exists. A skeleton above that check would start the response before the answer was known, and a
 * missing page would go out as a 200 with `noindex` instead of a real 404.
 */
import { Container } from '@/components/ui';

export function ListSkeleton() {
  return (
    <Container className="py-12 sm:py-16">
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading posts…</span>
      </div>
      <div aria-hidden="true" className="animate-pulse">
        <div className="bg-card-3 h-4 w-40 rounded" />
        <div className="bg-card-3 mt-8 h-10 w-full max-w-xl rounded-lg" />
        <div className="bg-card-3 mt-5 h-5 w-full max-w-2xl rounded" />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="border-border bg-card overflow-hidden rounded-[var(--radius-card)] border"
            >
              <div className="bg-card-2 aspect-[16/9]" />
              <div className="space-y-3 p-6">
                <div className="bg-card-3 h-3 w-20 rounded" />
                <div className="bg-card-3 h-5 w-full rounded" />
                <div className="bg-card-3 h-5 w-4/5 rounded" />
                <div className="bg-card-3 h-4 w-1/2 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Container>
  );
}

/** A post in outline — the title, the picture and a few lines of body. */
export function PostSkeleton() {
  return (
    <Container className="py-12 sm:py-16">
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading the article…</span>
      </div>
      <div aria-hidden="true" className="mx-auto max-w-3xl animate-pulse">
        <div className="bg-card-3 h-4 w-48 rounded" />
        <div className="bg-card-3 mt-8 h-3 w-24 rounded" />
        <div className="bg-card-3 mt-4 h-10 w-full rounded-lg" />
        <div className="bg-card-3 mt-3 h-10 w-3/4 rounded-lg" />
        <div className="bg-card-3 mt-6 h-4 w-60 rounded" />
        <div className="bg-card-2 mt-10 aspect-[16/9] rounded-[var(--radius-card)]" />
        <div className="mt-10 space-y-3">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className={`bg-card-3 h-4 rounded ${i % 4 === 3 ? 'w-2/3' : 'w-full'}`} />
          ))}
        </div>
      </div>
    </Container>
  );
}
