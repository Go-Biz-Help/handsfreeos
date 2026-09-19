import type { Metadata } from 'next';
import { PublicFrame } from '@/components/booking/public-shell';
import { PublicForm } from '@/components/forms/public-form';
import { formPageData, getPublicForm, resumeSheet } from '@/lib/api/public-forms';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ site: string; slug: string }>;
}): Promise<Metadata> {
  const { site, slug } = await params;
  try {
    const page = await getPublicForm(site, slug);
    return { title: page.definition.title, description: page.definition.intro || undefined };
  } catch {
    return { title: 'Form' };
  }
}

/**
 * A form as a customer fills it in: /f/<business>/<form>. Signed out, served by the worker, and never the
 * draft — only what was published.
 */
export default async function PublicFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ site: string; slug: string }>;
  searchParams: Promise<{ resume?: string }>;
}) {
  const { site, slug } = await params;
  const { resume } = await searchParams;
  const page = await formPageData(getPublicForm(site, slug));
  // Somebody coming back to finish one: their answers so far, if the link still stands.
  const resumed = resume
    ? await resumeSheet(site, slug, resume)
        .then((r) => ({ responseId: r.responseId, token: resume, answers: r.answers }))
        .catch(() => null)
    : null;
  return (
    <PublicFrame business={{ name: page.business.name, phone: null, phoneDisplay: null }}>
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
        <PublicForm
          site={site}
          slug={slug}
          definition={page.definition}
          closed={page.closed}
          closedMessage={page.closedMessage}
          resumed={resumed}
        />
      </div>
    </PublicFrame>
  );
}
