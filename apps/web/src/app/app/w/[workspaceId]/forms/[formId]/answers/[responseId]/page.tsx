import { redirect } from 'next/navigation';

/**
 * One response to a form, as a search result links to it (`searchHref`'s `forms/<form>/answers/<response>`, the path
 * the phone already opens): the form's own page, on its Results with that response open.
 */
export default async function FormAnswersPage({
  params,
}: {
  params: Promise<{ workspaceId: string; formId: string; responseId: string }>;
}) {
  const { workspaceId, formId, responseId } = await params;
  redirect(`/app/w/${workspaceId}/forms/${formId}?response=${encodeURIComponent(responseId)}`);
}
