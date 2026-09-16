import { Users } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Customers arrives in M10 step 15. */
export default function Customers() {
  const { business } = useBusiness();
  return (
    <Screen title="Customers" leading="back" testID="customers">
      <Placeholder
        icon={Users}
        title="Customers on the phone"
        body="People and companies, with their timeline, notes, tags, files and photos."
        webPath={`/app/w/${business.id}/customers`}
        webLabel="Open Customers on the web"
      />
    </Screen>
  );
}
