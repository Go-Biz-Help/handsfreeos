import { ClipboardList } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Tasks arrives in M10 step 15. */
export default function Tasks() {
  const { business } = useBusiness();
  return (
    <Screen title="Tasks" leading="back" testID="tasks">
      <Placeholder
        icon={ClipboardList}
        title="Tasks on the phone"
        body="Your tasks and the team’s, due today, overdue and done."
        webPath={`/app/w/${business.id}/tasks`}
        webLabel="Open Tasks on the web"
      />
    </Screen>
  );
}
