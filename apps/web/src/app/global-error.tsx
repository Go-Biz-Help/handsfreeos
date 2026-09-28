'use client';
import './globals.css';

/**
 * The last resort (FE-1): what shows when even the app's own frame fails to draw — the root layout, or a business's
 * layout before its shell is up. It stands in for the root layout, so it brings its own <html> and <body> and the
 * app's styles, and keeps to plain markup so as little as possible can fail with it. The colours follow the
 * device's light or dark setting. Every other failure is caught closer to where it happened, inside the shell
 * (app/app/w/[workspaceId]/error.tsx).
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-bg font-sans text-sm text-text">
        <title>Something went wrong · HandsFreeOS</title>
        <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
          <span className="text-[15px] font-semibold tracking-tight">
            HandsFree<span className="text-accent-text">OS</span>
          </span>
          <div
            className="w-[440px] max-w-full rounded-dialog border border-border bg-card p-9 text-center shadow-1"
            data-testid="global-error"
          >
            <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
            <p className="mt-2 text-text-2">
              HandsFreeOS couldn’t open this page. Nothing you saved is lost. Try again, or start
              from your workspaces.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={retry}
                className="h-11 rounded-menu bg-accent px-[18px] text-[15px] font-medium text-white hover:bg-accent-hover"
              >
                Try again
              </button>
              {/* A full load rather than a client navigation: the app's frame is what failed. */}
              <a
                href="/app"
                className="flex h-11 items-center justify-center rounded-menu border border-border-strong bg-card px-[18px] text-[15px] font-medium hover:bg-card-2"
              >
                Go to your workspaces
              </a>
            </div>
            {error.digest ? (
              <p className="mt-5 font-mono text-xs text-text-3">Reference {error.digest}</p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
