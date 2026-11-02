import { linkRefOf } from '@hfos/core';
import type { Metadata } from 'next';
import { PublicFrame } from '@/components/booking/public-shell';
import { FormLookFrame } from '@/components/forms/form-look';
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
 * draft — only what was published. `?ref=` is kept on the sheet, and on a time booked on it, for whoever's link it
 * was (a Social Outreach demo link, docs/outreach.md decision 24).
 */
export default async function PublicFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ site: string; slug: string }>;
  searchParams: Promise<{ resume?: string; embed?: string; k?: string; ref?: string }>;
}) {
  const { site, slug } = await params;
  const { resume, embed, k, ref } = await searchParams;
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
      calls={page.callConsent ?? null}
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
      linkRef={linkRefOf(ref)}
    />
  );
  const look = page.business.look ?? null;
  const embedded = embed === '1';
  const designed = (
    <FormLookFrame
      design={page.definition.design}
      businessColor={look?.color ?? null}
      logo={look?.logo ?? null}
      embedded={embedded}
      className="mx-auto w-full max-w-[var(--form-max-width,672px)]"
    >
      {form}
    </FormLookFrame>
  );
  // Embedded on the business's own site: no frame of ours around it, no padding fighting theirs, and no background
  // of the page's own, so a form without one sits on the site's. A page in another colour scheme than the site it's
  // on gets a solid backdrop from the browser, so it's always light here; the form's own colours come from its design.
  if (embedded)
    return (
      <>
        <style>{'html,body{background:transparent!important;color-scheme:light!important}'}</style>
        <div className="p-1">{designed}</div>
      </>
    );
  return (
    <PublicFrame
      business={{ name: page.business.name, phone: null, phoneDisplay: null, look: look ?? undefined }}
    >
      <div className="w-full px-4 py-8 sm:py-12">{designed}</div>
    </PublicFrame>
  );
}
