import { Inbox as InboxIcon } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Inbox arrives in M10 step 14. */
export default function Inbox() {
  const { business } = useBusiness();
  return (
    <Screen title="Inbox" testID="inbox">
      <Placeholder
        icon={InboxIcon}
        title="Conversations show here"
        body="Texts, emails and website chats, with replies and photos, and the calls inside each conversation."
        webPath={`/app/w/${business.id}/inbox`}
        webLabel="Open Inbox on the web"
      />
    </Screen>
  );
}
