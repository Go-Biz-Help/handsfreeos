'use client';
import { Button } from '@/components/ui/button';

/**
 * A form that didn't open. The worker allows each address so many reads a minute and answers the rest with a
 * refusal, or it couldn't be reached at all; either way the person is a customer on a business's link, so this says
 * what to try and nothing about workspaces, which the app's last-resort page (global-error.tsx) would. Small and
 * plain, because it also shows inside a business's own website when the form is embedded there.
 */
export default function FormError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main
      className="mx-auto flex w-full max-w-[440px] flex-col items-center gap-3 px-6 py-12 text-center"
      data-testid="form-error"
    >
      <h1 className="text-xl font-semibold tracking-tight">This form didn’t open</h1>
      <p className="text-text-2">It may be busy right now. Try again in a minute.</p>
      <Button onClick={retry} className="mt-3" data-testid="form-error-retry">
        Try again
      </Button>
    </main>
  );
}
