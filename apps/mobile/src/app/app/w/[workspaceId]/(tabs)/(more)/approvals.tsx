import { Sparkles } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Approvals arrives in M10 step 13. */
export default function Approvals() {
  const { business } = useBusiness();
  return (
    <Screen title="Approvals" leading="back" testID="approvals">
      <Placeholder
        icon={Sparkles}
        title="Approvals on the phone"
        body="Ava’s drafts and workflow steps waiting for your OK, and the ones decided lately."
        webPath={`/app/w/${business.id}`}
        webLabel="Open Home on the web"
      />
    </Screen>
  );
}
