import { CalendarDays } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';

/** Calendar arrives in M10 step 16. */
export default function Calendar() {
  const { business } = useBusiness();
  return (
    <Screen title="Calendar" testID="calendar">
      <Placeholder
        icon={CalendarDays}
        title="Your day and week"
        body="Appointments with their customer, address and money, and asking for a time with no signal."
        webPath={`/app/w/${business.id}/calendar`}
        webLabel="Open Calendar on the web"
      />
    </Screen>
  );
}
