import { redirect } from 'next/navigation';

/**
 * The quick questions' old address: they're the guided setup's screens now
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7), so a link or bookmark to them opens it.
 */
export default async function QuestionsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/onboarding/${workspaceId}`);
}
