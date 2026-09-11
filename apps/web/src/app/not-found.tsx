import { Brand } from '@/components/ui/brand';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <Brand size={32} className="text-base" />
      <Card className="w-[440px] max-w-full rounded-dialog p-9 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">We could not find that</h1>
        <p className="mt-2 text-text-2">
          The page does not exist, or you do not have access to it.
        </p>
        <ButtonLink href="/app" variant="primary" size="lg" className="mt-6 w-full">
          Go to your workspaces
        </ButtonLink>
      </Card>
    </div>
  );
}
