import { SquareKanban } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Pipeline arrives in M10 step 15. */
export default function Pipeline() {
  const { business } = useBusiness();
  return (
    <Screen title="Pipeline" testID="pipeline">
      <Placeholder
        icon={SquareKanban}
        title="Your leads, stage by stage"
        body="Each stage with its leads and their value, and Move to… to change a lead’s stage."
        webPath={`/app/w/${business.id}/pipeline`}
        webLabel="Open Pipeline on the web"
      />
    </Screen>
  );
}
