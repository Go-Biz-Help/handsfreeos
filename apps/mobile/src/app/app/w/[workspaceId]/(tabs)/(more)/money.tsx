import { CircleDollarSign } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Money arrives in M10 step 16. */
export default function Money() {
  const { business } = useBusiness();
  return (
    <Screen title="Money" leading="back" testID="money">
      <Placeholder
        icon={CircleDollarSign}
        title="Money on the phone"
        body="Invoices, estimates, payments and plans, and recording cash or a check at the door."
        webPath={`/app/w/${business.id}/money`}
        webLabel="Open Money on the web"
      />
    </Screen>
  );
}
