import type { DemoPerson } from '../world';
import { idsFor } from './ask-kit';
import { DAY } from './calendar-kit';
import { newPerson } from './teammate-kit';
import type { DemoScene } from './types';

/**
 * Ready on day one: moving in from another CRM with a spreadsheet (40). The import's commands are the scene's own
 * answers, so the file never reaches storage and nobody is added to the business.
 */

// ------------------------------------------------------------------------------- 40. move in from another CRM

const s40 = idsFor(40);
const IMPORT = s40(0x21);
const FILE = 'clients-export.csv';

/** The old CRM's export: a row per customer, tagged as they were there. */
const ROWS: readonly (readonly [string, string, string, string, string, string, string])[] = [
  [
    'Marcy',
    'Delacroix',
    '(832) 555-4001',
    'marcy.delacroix@example.com',
    '2210 Kirby Dr',
    'Houston',
    'AC customer',
  ],
  [
    'Arturo',
    'Benitez',
    '(832) 555-4002',
    'arturo.benitez@example.com',
    '614 Heights Blvd',
    'Houston',
    'Maintenance plan',
  ],
  [
    'Shirley',
    'Nguyen',
    '(832) 555-4003',
    'shirley.nguyen@example.com',
    '9031 Bissonnet St',
    'Bellaire',
    'AC customer',
  ],
  [
    'Douglas',
    'Kent',
    '(832) 555-4004',
    'douglas.kent@example.com',
    '17 Wyndham Ct',
    'Sugar Land',
    'Water heater',
  ],
  [
    'Patrice',
    'Wolfe',
    '(832) 555-4005',
    'patrice.wolfe@example.com',
    '3302 Rice Blvd',
    'West University',
    'Maintenance plan',
  ],
  [
    'Ronnie',
    'Gaither',
    '(832) 555-4006',
    'ronnie.gaither@example.com',
    '880 Mason Rd',
    'Katy',
    'AC customer',
  ],
];

const csv = (): string =>
  [
    'First name,Last name,Phone,Email,Street,City,State,ZIP,Tags',
    ...ROWS.map(([first, last, phone, email, street, city, tag]) =>
      [first, last, phone, email, street, city, 'TX', '77002', `"${tag}, Moved from old CRM"`].join(
        ',',
      ),
    ),
  ].join('\n');

/** The people the import made, as the contacts list shows them once it's done. */
const imported = (at: number): DemoPerson[] =>
  ROWS.map(([first, last, , email, , city, tag], i) => ({
    ...newPerson(s40(1 + i), first, last, 4001 + i, city, email),
    tags: [tag, 'Moved from old CRM'],
    customerSince: at - (2 + i) * 365 * DAY,
  }));

const crmImport: DemoScene = {
  id: 'crm-import',
  number: 40,
  title: 'Move in from another CRM',
  kind: 'app',
  startsOn: 'imports/new',
  answers: {
    // Run: the file goes nowhere, and the import is the scene's own.
    'import.create': () => ({
      importId: IMPORT,
      bucket: 'hfos-demo',
      objectPath: `imports/${IMPORT}.csv`,
    }),
    'import.start': () => ({ importId: IMPORT }),
  },
  steps: [
    {
      label: 'Open Import',
      voiceover:
        'Coming from another CRM? Export your customers as a spreadsheet. Every CRM can do that. Then bring it here.',
      run: (p) => p.go('imports/new'),
    },
    {
      label: 'Drop in the spreadsheet',
      voiceover:
        'Drop in the file. It reads it straight away: six customers, with their tags from the old system.',
      run: async (p) => {
        await p.point('@import-drop');
        await p.attach('@import-file', { name: FILE, type: 'text/csv', text: csv() });
        await p.waitFor('@import-file-summary');
        await p.point('@import-file-summary');
      },
    },
    {
      label: 'It matches the columns',
      voiceover:
        'It matches each column to the right place: names, phones, emails, addresses and tags. Nothing to set up.',
      run: async (p) => {
        await p.click('@import-next');
        await p.waitFor('@import-step-map');
        await p.point('@import-step-map');
      },
    },
    {
      label: 'Check it, and bring them in',
      voiceover: 'A quick look at how each row will come in, then bring them in.',
      // Only Run asks after the import, so it can be here before the press.
      change: (w, at) => {
        w.imports.push({ id: IMPORT, fileName: FILE, at, people: imported(at) });
      },
      run: async (p) => {
        await p.click('@import-next');
        await p.waitFor('@import-step-preview');
        await p.point('@import-run');
        await p.click('@import-run');
        await p.waitFor('[data-testid="import-progress"][data-status="done"]', 20_000);
      },
    },
    {
      label: 'They’re in, and tagged',
      voiceover:
        'A minute later they’re all in, tagged the way they were, searchable, and ready for your first campaign.',
      run: async (p) => {
        await p.point('@import-result');
        await p.go('customers');
        await p.point(`@person-row-${s40(1)}`);
      },
    },
  ],
};

export const DAY_ONE_SCENES: readonly DemoScene[] = [crmImport];
