import type { TeammateCatalogs, TeammatePresetContext } from '../src/ai-team/index';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const DALE = uid(1); // owner
export const PRIYA = uid(2); // admin
export const MARCO = uid(3); // member
export const JESS = uid(4); // left the workspace

export const SALES = uid(401);
export const STAGE_NEW = uid(402);
export const STAGE_QUALIFIED = uid(403);

export const SPEED_WF = uid(501);
export const SPEED_WF_2 = uid(502);

export const SERVICE_CAL = uid(701); // public
export const OFFICE_CAL = uid(702); // not open for online booking
export const OLD_CAL = uid(703); // archived

export const HELLO = uid(801);
export const OFFICE = uid(802);
export const WIDGET = uid(901);

export const NOW = Date.parse('2026-09-16T15:00:00Z');

export const WEEKDAYS_8_TO_5 = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '08:00',
  end: '17:00',
}));

export const catalogs: TeammateCatalogs = {
  timeZone: 'America/Chicago',
  textingReady: true,
  emailAddresses: [
    { id: HELLO, address: 'hello@lonestarhvac.com' },
    { id: OFFICE, address: 'office@lonestarhvac.com' },
  ],
  chatWidgets: [{ id: WIDGET, name: 'lonestarhvac.com' }],
  calendars: [
    { id: SERVICE_CAL, name: 'Service calls', archived: false, bookableOnline: true },
    { id: OFFICE_CAL, name: 'Office visits', archived: false, bookableOnline: false },
    { id: OLD_CAL, name: 'Old calendar', archived: true, bookableOnline: true },
  ],
  knowledge: { published: 12 },
  profile: { filled: 6, total: 7 },
  businessHours: WEEKDAYS_8_TO_5,
  members: [
    { userId: DALE, name: 'Dale', role: 'owner', active: true },
    { userId: PRIYA, name: 'Priya', role: 'admin', active: true },
    { userId: MARCO, name: 'Marco', role: 'member', active: true },
    { userId: JESS, name: 'Jess', role: 'member', active: false },
  ],
  newLeadTextWorkflows: [],
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
  industry: 'home_services',
  pipelines: [
    {
      id: SALES,
      name: 'Sales',
      archived: false,
      stages: [
        { id: STAGE_NEW, name: 'New', archived: false },
        { id: STAGE_QUALIFIED, name: 'Qualified', archived: false },
      ],
    },
  ],
};

export const presetContext: TeammatePresetContext = {
  name: 'Ava',
  industry: 'home_services',
  emailAddressId: HELLO,
  widgetId: WIDGET,
  calendarIds: [SERVICE_CAL],
};
