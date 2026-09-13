import type { CalendarCatalogs, PresetContext, WeeklyHours } from '../../src/calendar/index';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const DALE = uid(1);
export const PRIYA = uid(2);
export const MARCO = uid(3);
export const JESS = uid(4); // left the workspace
export const NEWBIE = uid(5); // on the team, on no calendar

export const TUNE_UP = uid(101);
export const DUCT = uid(102);
export const RETIRED_SERVICE = uid(103);

export const TRUCK = uid(201);
export const OLD_VAN = uid(202);

export const NORTH = uid(301);
export const SOUTH = uid(302);

export const SALES = uid(401);
export const STAGE_NEW = uid(402);
export const STAGE_OLD = uid(403);
export const OLD_PIPELINE = uid(404);
export const OLD_PIPELINE_STAGE = uid(405);

export const WORKFLOW = uid(501);

export const WEEKDAYS_8_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '08:00',
  end: '17:00',
}));

export const catalogs: CalendarCatalogs = {
  timeZone: 'America/Chicago',
  team: [
    { userId: DALE, name: 'Dale', active: true, hours: WEEKDAYS_8_TO_5 },
    { userId: PRIYA, name: 'Priya', active: true, hours: WEEKDAYS_8_TO_5 },
    { userId: MARCO, name: 'Marco', active: true, hours: WEEKDAYS_8_TO_5 },
    { userId: JESS, name: 'Jess', active: false },
    { userId: NEWBIE, name: 'Nia', active: true, hours: WEEKDAYS_8_TO_5 },
  ],
  services: [
    {
      id: TUNE_UP,
      name: 'AC tune-up',
      durations: [60, 90],
      bufferBefore: 0,
      bufferAfter: 15,
      eligibleUserIds: [],
      requiredResources: [],
      archived: false,
    },
    {
      id: DUCT,
      name: 'Duct cleaning',
      durations: [240],
      bufferBefore: 0,
      bufferAfter: 0,
      eligibleUserIds: [MARCO],
      requiredResources: [],
      archived: false,
    },
    {
      id: RETIRED_SERVICE,
      name: 'Old service',
      durations: [30],
      bufferBefore: 0,
      bufferAfter: 0,
      eligibleUserIds: [],
      requiredResources: [],
      archived: true,
    },
  ],
  resources: [
    { id: TRUCK, name: 'Truck 2', quantity: 2, archived: false },
    { id: OLD_VAN, name: 'Old van', quantity: 1, archived: true },
  ],
  territories: [
    {
      id: NORTH,
      name: 'North Dallas',
      postalCodes: ['75201', '75202'],
      userIds: [DALE, PRIYA, MARCO],
    },
    { id: SOUTH, name: 'South Dallas', postalCodes: ['75215'], userIds: [MARCO] },
  ],
  pipelines: [
    {
      id: SALES,
      name: 'Sales',
      archived: false,
      stages: [
        { id: STAGE_NEW, name: 'New', archived: false },
        { id: STAGE_OLD, name: 'Old', archived: true },
      ],
    },
    {
      id: OLD_PIPELINE,
      name: 'Old pipeline',
      archived: true,
      stages: [{ id: OLD_PIPELINE_STAGE, name: 'Intake', archived: false }],
    },
  ],
  textingReady: true,
  paymentsAvailable: false,
};

export const presetContext: PresetContext = {
  me: DALE,
  teammates: [PRIYA, MARCO],
  services: [TUNE_UP],
  resources: [TRUCK],
};

/** 2026-09-13 12:00 in Chicago. */
export const NOW = Date.parse('2026-09-13T17:00:00Z');
