import { Button, Container } from '@/components/ui';
import { blogPaths } from '@/lib/opinly/paths';

/** A post, category, tag or author that is not there — usually an old link to something since unpublished. */
export default function BlogNotFound() {
  return (
    <Container className="py-28 text-center">
      <p className="text-text-2 inline-flex items-center gap-2 text-sm font-medium">
        <span aria-hidden="true" className="bg-accent h-1.5 w-1.5 rounded-full" />
        Not found
      </p>
      <h1 className="mt-4 text-4xl font-bold">That article is not here.</h1>
      <p className="text-text-2 mx-auto mt-4 max-w-md text-lg">
        It may have been moved or taken down, or the link may be wrong. The newest posts are a good
        place to pick up from.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Button href={blogPaths.index()}>See the newest posts</Button>
        <Button href="/" variant="secondary">
          Go to the front page
        </Button>
      </div>
    </Container>
  );
}
