import { MissingPage } from '@/components/shell/missing-page';

/**
 * A page in this business that isn't there, or that this person may not open, drawn inside the shell (FE-4), so
 * the menu stays and the way on is one press away. A business that isn't theirs never gets this far: the layout
 * sends that to the app's own 404, which never says whether the business exists.
 */
export default function WorkspaceNotFound() {
  return <MissingPage />;
}
