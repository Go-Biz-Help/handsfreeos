import { Button, Container } from '@/components/ui';

export default function NotFound() {
  return (
    <Container className="py-28 text-center">
      <p className="text-accent-text text-sm font-semibold tracking-[0.14em] uppercase">
        Page not found
      </p>
      <h1 className="mt-4 text-4xl font-bold">That page is not here.</h1>
      <p className="text-text-2 mx-auto mt-4 max-w-md text-lg">
        It may have moved, or the link may be wrong. The front page is a good place to pick up from.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Button href="/">Go to the front page</Button>
        <Button href="/support" variant="secondary">
          Ask us
        </Button>
      </div>
    </Container>
  );
}
