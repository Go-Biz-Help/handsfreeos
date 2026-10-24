import type { Metadata } from 'next';
import { PublicFrame } from '@/components/booking/public-shell';
import { PublicForm } from '@/components/forms/public-form';
import { formPageData, getPublicForm, personalSheet, resumeSheet } from '@/lib/api/public-forms';

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
  searchParams: Promise<{ resume?: string; embed?: string; k?: string }>;
}) {
  const { site, slug } = await params;
  const { resume, embed, k } = await searchParams;
  const page = await formPageData(getPublicForm(site, slug));
  // Their own link (funnels): who to greet and what not to ask again. A link that ran out opens the plain form.
  const personal = k
    ? await personalSheet(site, slug, k)
        .then((p) => ({ key: k, ...p }))
        .catch(() => null)
    : null;
  // Somebody coming back to finish one: their answers so far, if the link still stands.
  const resumed = resume
    ? await resumeSheet(site, slug, resume)
        .then((r) => ({ responseId: r.responseId, token: resume, answers: r.answers }))
        .catch(() => null)
    : null;
  const form = (
    <PublicForm
      site={site}
      slug={slug}
      business={page.business.name}
      definition={page.definition}
      closed={page.closed}
      closedMessage={page.closedMessage}
      botCheck={page.botCheck}
      offers={page.offersConsent ?? null}
      resumed={
        resumed ??
        (personal?.sheet
          ? {
              responseId: personal.sheet.responseId,
              token: personal.key,
              answers: personal.sheet.answers,
            }
          : null)
      }
      personal={
        personal
          ? { key: personal.key, firstName: personal.firstName, known: personal.known }
          : null
      }
    />
  );
  // Embedded on the business's own site: no frame of ours around it, and no padding fighting theirs.
  if (embed === '1') return <div className="p-1">{form}</div>;
  return (
    <PublicFrame business={{ name: page.business.name, phone: null, phoneDisplay: null }}>
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">{form}</div>
    </PublicFrame>
  );
}
