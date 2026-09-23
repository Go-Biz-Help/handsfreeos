/**
 * Milestone 2 seed: a believable customer list, pipelines, leads, tasks, notes and two photos for the demo
 * workspaces, written through the same commands the app uses (so every row has its events and audit trail).
 * Only timestamps are aged afterwards with plain SQL so the board and timeline look lived-in.
 */
import { deflateSync } from 'node:zlib';
import {
  activityLog,
  companyCreate,
  executeCommand,
  fileBeginUpload,
  fileConfirm,
  leadCreate,
  leadMoveStage,
  leadSetNextAction,
  personCreate,
  pipelineCreate,
  pipelineList,
  executeQuery,
  recordAssign,
  tagCreate,
  taskComplete,
  taskCreate,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { ObjectStore } from '../src/storage';

export interface SeedCrmDeps {
  readonly api: Db;
  readonly admin: Db;
  readonly store: ObjectStore;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
}

const HOUSTON = [
  'Houston',
  'Katy',
  'Sugar Land',
  'Pearland',
  'Spring',
  'Cypress',
  'The Woodlands',
  'Pasadena',
];
const STREETS = [
  'Main St',
  'Oak Hollow Dr',
  'Pecan Grove Ln',
  'Bayou Bend Ct',
  'Westheimer Rd',
  'Cypress Creek Pkwy',
  'Kirby Dr',
  'Heights Blvd',
  'Shepherd Dr',
  'Memorial Dr',
];
const ZIPS = ['77002', '77494', '77479', '77584', '77373', '77429', '77380', '77502'];

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const at = (n: number, hour: number) => {
  const d = days(n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

type Person = {
  first: string;
  last: string;
  phone: string;
  email?: string;
  company?: string;
  tags?: string[];
  source?: string;
  notes?: string;
  /** More ways to reach them than the main ones (0102). */
  otherPhones?: { phone: string; label: string }[];
  otherEmails?: { email: string; label: string }[];
  otherAddresses?: {
    label: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
  }[];
  /** Everyone else working with them besides whoever added them (0103). */
  team?: ('dale' | 'priya' | 'marco')[];
};

const LONESTAR_COMPANIES: {
  name: string;
  phone: string;
  email: string;
  tags: string[];
  street: string;
}[] = [
  {
    name: 'ABC Dental',
    phone: '713-555-0110',
    email: 'office@abcdental.example',
    tags: ['Commercial'],
    street: '4100 Kirby Dr',
  },
  {
    name: 'Riverside Apartments',
    phone: '281-555-0121',
    email: 'manager@riversideapts.example',
    tags: ['Commercial', 'Maintenance plan'],
    street: '800 Riverside Dr',
  },
  {
    name: 'Greenway Property Management',
    phone: '713-555-0155',
    email: 'hello@greenwaypm.example',
    tags: ['Commercial'],
    street: '2211 Norfolk St',
  },
  {
    name: 'Bayou Bistro',
    phone: '713-555-0107',
    email: 'elena@bayoubistro.example',
    tags: ['Commercial', 'Referral'],
    street: '318 Gray St',
  },
  {
    name: 'Cypress Creek Church',
    phone: '832-555-0140',
    email: 'office@cypresscreek.example',
    tags: ['Commercial'],
    street: '12800 Cypress Creek Pkwy',
  },
  {
    name: 'Heights Auto Care',
    phone: '713-555-0166',
    email: 'service@heightsauto.example',
    tags: ['Commercial', 'Maintenance plan'],
    street: '1520 Heights Blvd',
  },
  {
    name: 'Memorial Pediatrics',
    phone: '713-555-0172',
    email: 'front@memorialpeds.example',
    tags: ['Commercial'],
    street: '9055 Memorial Dr',
  },
  {
    name: 'Pearland Storage',
    phone: '281-555-0183',
    email: 'units@pearlandstorage.example',
    tags: ['Commercial'],
    street: '2400 Broadway St',
  },
];

const LONESTAR_PEOPLE: Person[] = [
  {
    first: 'Mike',
    last: 'Johnson',
    phone: '713-555-0142',
    email: 'mike.johnson@example.com',
    tags: ['Residential', 'Referral'],
    source: 'Referral · Linda Okafor',
    notes: 'Prefers texts over calls. Gate code 4471.',
    otherPhones: [{ phone: '713-555-0197', label: 'Work' }],
    otherEmails: [{ email: 'mjohnson@johnsonroofing.example', label: 'Work' }],
    otherAddresses: [
      {
        label: 'Rental',
        line1: '2210 Taft St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77006',
      },
    ],
    // Dale added him; Priya looks after the maintenance plan on his rental.
    team: ['priya'],
  },
  {
    first: 'Sarah',
    last: 'Alvarez',
    phone: '281-555-0199',
    email: 'salvarez@example.com',
    tags: ['Residential', 'Maintenance plan'],
    source: 'Website',
  },
  {
    first: 'Robert',
    last: 'Chen',
    phone: '713-555-0110',
    email: 'rchen@abcdental.example',
    company: 'ABC Dental',
    tags: ['Commercial'],
    notes: 'Office manager. Decisions go through Dr. Patel.',
  },
  {
    first: 'Linda',
    last: 'Okafor',
    phone: '832-555-0177',
    email: 'linda.okafor@example.com',
    tags: ['Residential', 'VIP'],
    source: 'Google',
  },
  {
    first: 'James',
    last: 'Whitfield',
    phone: '713-555-0163',
    email: 'jwhit@example.com',
    tags: ['Residential'],
    source: 'Yard sign',
  },
  {
    first: 'Maria',
    last: 'Santos',
    phone: '281-555-0121',
    email: 'msantos@riversideapts.example',
    company: 'Riverside Apartments',
    tags: ['Commercial', 'Maintenance plan'],
    notes: 'Property manager for buildings A–C.',
  },
  {
    first: 'David',
    last: 'Kim',
    phone: '713-555-0188',
    email: 'dkim88@example.com',
    tags: ['Residential'],
    source: 'Google',
  },
  {
    first: 'Angela',
    last: 'Brooks',
    phone: '832-555-0134',
    email: 'abrooks@example.com',
    tags: ['Residential', 'Referral'],
    source: 'Referral · Sarah Alvarez',
  },
  {
    first: 'Tom',
    last: 'Reyes',
    phone: '713-555-0155',
    email: 'treyes@greenwaypm.example',
    company: 'Greenway Property Management',
    tags: ['Commercial'],
  },
  {
    first: 'Elena',
    last: 'Duarte',
    phone: '713-555-0107',
    email: 'elena@bayoubistro.example',
    company: 'Bayou Bistro',
    tags: ['Commercial', 'Referral'],
  },
  {
    first: 'Kendra',
    last: 'Lee',
    phone: '832-555-0190',
    tags: ['Residential'],
    source: 'Phone call',
  },
  {
    first: 'Sam',
    last: 'Patel',
    phone: '713-555-0102',
    email: 'sam.patel@example.com',
    tags: ['Residential'],
  },
  {
    first: 'Carlos',
    last: 'Mendoza',
    phone: '281-555-0113',
    email: 'cmendoza@example.com',
    tags: ['Residential', 'Maintenance plan'],
  },
  {
    first: 'Denise',
    last: 'Walker',
    phone: '713-555-0118',
    email: 'dwalker@example.com',
    tags: ['Residential'],
    source: 'Nextdoor',
  },
  {
    first: 'Greg',
    last: 'Thompson',
    phone: '832-555-0125',
    email: 'gthompson@example.com',
    tags: ['Residential'],
  },
  {
    first: 'Hannah',
    last: 'Nguyen',
    phone: '713-555-0131',
    email: 'hannah.nguyen@example.com',
    tags: ['Residential', 'VIP'],
    source: 'Referral · Mike Johnson',
  },
  {
    first: 'Isaac',
    last: 'Boone',
    phone: '281-555-0137',
    email: 'iboone@example.com',
    tags: ['Residential'],
  },
  {
    first: 'Jasmine',
    last: 'Carter',
    phone: '713-555-0144',
    email: 'jcarter@example.com',
    tags: ['Residential'],
    source: 'Google',
  },
  {
    first: 'Kevin',
    last: "O'Brien",
    phone: '832-555-0149',
    email: 'kobrien@example.com',
    tags: ['Residential'],
  },
  {
    first: 'Laura',
    last: 'Fischer',
    phone: '713-555-0152',
    email: 'lfischer@example.com',
    tags: ['Residential', 'Maintenance plan'],
  },
  {
    first: 'Nathan',
    last: 'Price',
    phone: '281-555-0158',
    email: 'nprice@example.com',
    tags: ['Residential'],
    source: 'Yard sign',
  },
  {
    first: 'Olivia',
    last: 'Grant',
    phone: '713-555-0161',
    email: 'ogrant@example.com',
    tags: ['Residential'],
  },
  {
    first: 'Bill',
    last: 'Hayes',
    phone: '832-555-0140',
    email: 'pastor@cypresscreek.example',
    company: 'Cypress Creek Church',
    tags: ['Commercial'],
    notes: 'Pastor. Best reached Tuesday to Thursday.',
  },
  {
    first: 'Quincy',
    last: 'Adams',
    phone: '713-555-0166',
    email: 'quincy@heightsauto.example',
    company: 'Heights Auto Care',
    tags: ['Commercial', 'Maintenance plan'],
  },
  {
    first: 'Rachel',
    last: 'Stein',
    phone: '713-555-0172',
    email: 'rstein@memorialpeds.example',
    company: 'Memorial Pediatrics',
    tags: ['Commercial'],
  },
  {
    first: 'Steven',
    last: 'Park',
    phone: '281-555-0183',
    email: 'spark@pearlandstorage.example',
    company: 'Pearland Storage',
    tags: ['Commercial'],
  },
  {
    first: 'Tina',
    last: 'Morales',
    phone: '713-555-0176',
    email: 'tmorales@example.com',
    tags: ['Residential'],
    source: 'Facebook',
  },
  {
    first: 'Victor',
    last: 'Hale',
    phone: '832-555-0180',
    email: 'vhale@example.com',
    tags: ['Residential'],
  },
  {
    first: 'Wendy',
    last: 'Liu',
    phone: '713-555-0185',
    email: 'wendy.liu@example.com',
    tags: ['Residential', 'Referral'],
    source: 'Referral · Hannah Nguyen',
  },
  {
    first: 'Yusuf',
    last: 'Ali',
    phone: '281-555-0191',
    email: 'yali@example.com',
    tags: ['Residential'],
  },
];

type LeadSeed = {
  title: string;
  person: string;
  value: number;
  stage: string;
  assignee: 'dale' | 'priya' | 'marco';
  next?: string;
  nextIn?: number;
  age: number;
  lost?: string;
  source?: string;
  pipeline?: 'maint';
};
const LONESTAR_LEADS: LeadSeed[] = [
  {
    title: 'Roof replacement',
    person: 'Mike Johnson',
    value: 1250000,
    stage: 'Estimate sent',
    assignee: 'dale',
    age: 3,
    source: 'Referral',
  },
  {
    title: 'AC install · 4 ton',
    person: 'Sarah Alvarez',
    value: 890000,
    stage: 'Contacted',
    assignee: 'priya',
    next: 'Call Sarah to confirm the install date',
    nextIn: 1,
    age: 1,
  },
  {
    title: 'Ductwork repair',
    person: 'Robert Chen',
    value: 320000,
    stage: 'New',
    assignee: 'dale',
    age: 0,
  },
  {
    title: 'Attic insulation',
    person: 'Angela Brooks',
    value: 240000,
    stage: 'New',
    assignee: 'marco',
    age: 0,
  },
  {
    title: 'Building C rooftop units',
    person: 'Maria Santos',
    value: 2180000,
    stage: 'Estimate sent',
    assignee: 'dale',
    next: 'Site walk with Maria, building C',
    nextIn: 2,
    age: 6,
  },
  {
    title: 'Water heater swap',
    person: 'James Whitfield',
    value: 165000,
    stage: 'Contacted',
    assignee: 'marco',
    next: 'Text photos of the closet',
    nextIn: 0,
    age: 2,
  },
  {
    title: 'Gutter guards',
    person: 'Mike Johnson',
    value: 185000,
    stage: 'Won',
    assignee: 'priya',
    age: 55,
  },
  {
    title: 'Roof repair · hail',
    person: 'Linda Okafor',
    value: 410000,
    stage: 'Won',
    assignee: 'dale',
    age: 14,
  },
  {
    title: 'Mini split · garage',
    person: 'David Kim',
    value: 390000,
    stage: 'Lost',
    assignee: 'priya',
    age: 30,
    lost: 'Went with another bidder · Price',
  },
  {
    title: 'Furnace tune-up',
    person: 'Carlos Mendoza',
    value: 18900,
    stage: 'Contacted',
    assignee: 'marco',
    next: 'Schedule the tune-up',
    nextIn: 3,
    age: 4,
  },
  {
    title: 'Sanctuary AC replacement',
    person: 'Bill Hayes',
    value: 4850000,
    stage: 'Estimate sent',
    assignee: 'dale',
    next: 'Present at the building committee',
    nextIn: 5,
    age: 9,
  },
  {
    title: 'Bay 2 exhaust fan',
    person: 'Quincy Adams',
    value: 260000,
    stage: 'New',
    assignee: 'priya',
    next: 'Call Quincy back',
    nextIn: 1,
    age: 1,
  },
  {
    title: 'Waiting room split system',
    person: 'Rachel Stein',
    value: 720000,
    stage: 'Contacted',
    assignee: 'dale',
    age: 5,
  },
  {
    title: 'Skylight leak',
    person: 'Hannah Nguyen',
    value: 95000,
    stage: 'New',
    assignee: 'marco',
    next: 'Confirm Saturday visit',
    nextIn: 2,
    age: 0,
  },
  {
    title: 'Whole-home surge protection',
    person: 'Wendy Liu',
    value: 68000,
    stage: 'Lost',
    assignee: 'marco',
    age: 20,
    lost: 'Decided not to do the work · Postponed to spring',
  },
  {
    title: 'Storage office heat pump',
    person: 'Steven Park',
    value: 540000,
    stage: 'Won',
    assignee: 'priya',
    age: 8,
  },
  {
    title: 'Spring maintenance plan',
    person: 'Sarah Alvarez',
    value: 24900,
    stage: 'Due',
    assignee: 'priya',
    next: 'Send the renewal',
    nextIn: 0,
    age: 2,
    pipeline: 'maint',
  },
  {
    title: 'Annual plan · 6 units',
    person: 'Maria Santos',
    value: 149400,
    stage: 'Reminded',
    assignee: 'dale',
    age: 7,
    pipeline: 'maint',
  },
  {
    title: 'Fall maintenance plan',
    person: 'Laura Fischer',
    value: 24900,
    stage: 'Renewed',
    assignee: 'marco',
    age: 12,
    pipeline: 'maint',
  },
  {
    title: 'Plan renewal',
    person: 'Carlos Mendoza',
    value: 24900,
    stage: 'Due',
    assignee: 'priya',
    age: 1,
    pipeline: 'maint',
  },
];

/** A tiny solid-colour PNG (so the seeded photos really are images). */
export function pngOf(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const shade = 1 - (y / height) * 0.25;
      raw[o] = Math.round(rgb[0] * shade);
      raw[o + 1] = Math.round(rgb[1] * shade);
      raw[o + 2] = Math.round(rgb[2] * shade);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function seedCrm(
  deps: SeedCrmDeps,
  workspaces: {
    lonestar: { id: string; dale: TestUser; priya: TestUser; marco: TestUser };
    bayou: { id: string; owner: TestUser };
    summit: { id: string; owner: TestUser };
  },
): Promise<void> {
  const { api, admin, store, actor, meta, step } = deps;
  const ls = workspaces.lonestar;
  const run = <T>(p: Promise<{ output: T }>) => p.then((r) => r.output);

  step('Lone Star: tags, companies and about thirty customers');
  const tagIds = new Map<string, string>();
  for (const [name, color] of [
    ['Residential', '#2d69d8'],
    ['Commercial', '#7c3aed'],
    ['Maintenance plan', '#008743'],
    ['Referral', '#996300'],
    ['VIP', '#c43335'],
  ] as const) {
    const out = await run(
      executeCommand(api, tagCreate, { workspaceId: ls.id, name, color }, actor(ls.priya), meta()),
    );
    tagIds.set(name, out.tagId);
  }
  const tags = (names?: string[]) => (names ?? []).map((n) => tagIds.get(n)!).filter(Boolean);
  const companyIds = new Map<string, string>();
  for (const c of LONESTAR_COMPANIES) {
    const out = await run(
      executeCommand(
        api,
        companyCreate,
        {
          workspaceId: ls.id,
          name: c.name,
          phone: c.phone,
          email: c.email,
          address: { line1: c.street, city: 'Houston', state: 'TX', postalCode: '77002' },
          tagIds: tags(c.tags),
          ignoreDuplicates: true,
        },
        actor(ls.priya),
        meta(),
      ),
    );
    companyIds.set(c.name, out.companyId);
  }
  const personIds = new Map<string, string>();
  for (const [i, p] of LONESTAR_PEOPLE.entries()) {
    const by = i % 3 === 0 ? ls.dale : i % 3 === 1 ? ls.priya : ls.marco;
    const out = await run(
      executeCommand(
        api,
        personCreate,
        {
          workspaceId: ls.id,
          firstName: p.first,
          lastName: p.last,
          phone: p.phone,
          email: p.email ?? null,
          companyId: p.company ? companyIds.get(p.company) : null,
          address: p.company
            ? undefined
            : {
                line1: `${100 + i * 37} ${STREETS[i % STREETS.length]}`,
                city: HOUSTON[i % HOUSTON.length],
                state: 'TX',
                postalCode: ZIPS[i % ZIPS.length],
              },
          tagIds: tags(p.tags),
          source: p.source ?? null,
          notes: p.notes ?? null,
          ownerUserId: by.id,
          otherPhones: p.otherPhones,
          otherEmails: p.otherEmails,
          otherAddresses: p.otherAddresses,
          ignoreDuplicates: true,
        },
        actor(by),
        meta(),
      ),
    );
    personIds.set(`${p.first} ${p.last}`, out.personId);
    for (const name of p.team ?? [])
      await executeCommand(
        api,
        recordAssign,
        {
          workspaceId: ls.id,
          recordType: 'person',
          recordId: out.personId,
          userId: ls[name].id,
        },
        actor(by),
        meta(),
      );
  }

  step('Lone Star: a second pipeline for maintenance plans');
  const maint = await run(
    executeCommand(
      api,
      pipelineCreate,
      {
        workspaceId: ls.id,
        name: 'Maintenance plans',
        stages: [
          { name: 'Due', kind: 'open' },
          { name: 'Reminded', kind: 'open' },
          { name: 'Renewed', kind: 'won' },
          { name: 'Lapsed', kind: 'lost' },
        ],
      },
      actor(ls.dale),
      meta(),
    ),
  );
  const { pipelines } = await executeQuery(
    api,
    pipelineList,
    { workspaceId: ls.id },
    actor(ls.dale),
    meta(),
  );
  const stageId = (pipelineId: string, name: string) =>
    pipelines.find((p) => p.id === pipelineId)!.stages.find((s) => s.name === name)!.id;
  const sales = pipelines.find((p) => p.name === 'Sales')!.id;

  step('Lone Star: leads across the stages, some without a next action');
  const leadIds = new Map<string, string>();
  const ages: { leadId: string; days: number }[] = [];
  for (const l of LONESTAR_LEADS) {
    const who = { dale: ls.dale, priya: ls.priya, marco: ls.marco }[l.assignee];
    const pipelineId = l.pipeline === 'maint' ? maint.pipelineId : sales;
    const created = await run(
      executeCommand(
        api,
        leadCreate,
        {
          workspaceId: ls.id,
          title: l.title,
          personId: personIds.get(l.person)!,
          pipelineId,
          valueCents: l.value,
          assigneeUserId: who.id,
          source: l.source ?? null,
          nextAction: l.next ?? null,
          nextActionAt: l.nextIn === undefined ? null : at(l.nextIn, 9),
        },
        actor(who),
        meta(),
      ),
    );
    leadIds.set(l.title, created.leadId);
    const target = stageId(pipelineId, l.stage);
    if (target !== created.stageId) {
      // Walk through the open stages so the timeline tells the story, then land on the target.
      const order = pipelines.find((p) => p.id === pipelineId)!.stages;
      const targetIndex = order.findIndex((s) => s.id === target);
      for (const s of order.slice(1, targetIndex + 1)) {
        if (s.kind === 'lost' && s.id !== target) continue;
        if (s.kind === 'won' && s.id !== target) continue;
        await executeCommand(
          api,
          leadMoveStage,
          {
            workspaceId: ls.id,
            leadId: created.leadId,
            stageId: s.id,
            ...(s.kind === 'lost' ? { lostReason: l.lost ?? 'No response' } : {}),
          },
          actor(who),
          meta(),
        );
      }
    }
    ages.push({ leadId: created.leadId, days: l.age });
  }

  step('Lone Star: tasks, notes and calls');
  const taskSeeds: {
    title: string;
    person: string;
    lead?: string;
    assignee: TestUser;
    due: number | null;
    hour?: number;
    done?: boolean;
  }[] = [
    {
      title: 'Call Mike Johnson about the estimate',
      person: 'Mike Johnson',
      lead: 'Roof replacement',
      assignee: ls.dale,
      due: -1,
      hour: 10,
    },
    {
      title: 'Send maintenance plan renewal to Sarah Alvarez',
      person: 'Sarah Alvarez',
      lead: 'Spring maintenance plan',
      assignee: ls.priya,
      due: 0,
      hour: 14,
    },
    {
      title: 'Site visit at Riverside Apartments, building C',
      person: 'Maria Santos',
      lead: 'Building C rooftop units',
      assignee: ls.dale,
      due: 0,
      hour: 16,
    },
    {
      title: 'Follow up on ABC Dental ductwork quote',
      person: 'Robert Chen',
      lead: 'Ductwork repair',
      assignee: ls.dale,
      due: 1,
    },
    {
      title: 'Order the attic insulation',
      person: 'Angela Brooks',
      lead: 'Attic insulation',
      assignee: ls.marco,
      due: 3,
    },
    {
      title: 'Send financing options',
      person: 'Mike Johnson',
      lead: 'Roof replacement',
      assignee: ls.priya,
      due: 4,
    },
    {
      title: 'Schedule roof measurement',
      person: 'Mike Johnson',
      lead: 'Roof replacement',
      assignee: ls.marco,
      due: -9,
      done: true,
    },
    {
      title: 'Drop off the signed proposal',
      person: 'Linda Okafor',
      assignee: ls.dale,
      due: -12,
      done: true,
    },
    {
      title: 'Check permit status for the church',
      person: 'Bill Hayes',
      lead: 'Sanctuary AC replacement',
      assignee: ls.dale,
      due: null,
    },
  ];
  for (const t of taskSeeds) {
    const out = await run(
      executeCommand(
        api,
        taskCreate,
        {
          workspaceId: ls.id,
          title: t.title,
          personId: personIds.get(t.person)!,
          leadId: t.lead ? leadIds.get(t.lead)! : null,
          assigneeUserId: t.assignee.id,
          dueAt: t.due === null ? null : t.hour ? at(t.due, t.hour) : at(t.due, 12),
          allDay: !t.hour,
        },
        actor(t.assignee),
        meta(),
      ),
    );
    if (t.done)
      await executeCommand(
        api,
        taskComplete,
        { workspaceId: ls.id, taskId: out.taskId },
        actor(t.assignee),
        meta(),
      );
  }
  const notes: {
    kind: 'note' | 'call' | 'visit';
    by: TestUser;
    person: string;
    lead?: string;
    body: string;
    daysAgo: number;
  }[] = [
    {
      kind: 'note',
      by: ls.priya,
      person: 'Mike Johnson',
      lead: 'Roof replacement',
      body: 'Mike asked whether the estimate includes hauling away the old shingles. Told him yes; he will talk to his wife tonight.',
      daysAgo: 0,
    },
    {
      kind: 'call',
      by: ls.dale,
      person: 'Mike Johnson',
      lead: 'Roof replacement',
      body: 'Walked the roof together. Two soft spots near the chimney; recommended full replacement over patching.',
      daysAgo: 6,
    },
    {
      kind: 'call',
      by: ls.priya,
      person: 'Sarah Alvarez',
      lead: 'AC install · 4 ton',
      body: 'Reached Sarah. She wants the install before the heat; leaning toward the 16 SEER unit.',
      daysAgo: 1,
    },
    {
      kind: 'visit',
      by: ls.dale,
      person: 'Maria Santos',
      lead: 'Building C rooftop units',
      body: 'Looked at the three units on C. Compressor on unit 2 is gone; the other two have a season left at most.',
      daysAgo: 4,
    },
    {
      kind: 'note',
      by: ls.marco,
      person: 'James Whitfield',
      lead: 'Water heater swap',
      body: 'Closet is tight; a 40-gallon short model should fit. Waiting on photos.',
      daysAgo: 2,
    },
    {
      kind: 'call',
      by: ls.dale,
      person: 'Bill Hayes',
      lead: 'Sanctuary AC replacement',
      body: 'Building committee meets next Tuesday. Bill wants the two-unit option presented first.',
      daysAgo: 3,
    },
    {
      kind: 'note',
      by: ls.priya,
      person: 'Linda Okafor',
      body: 'Referred Mike Johnson and Hannah Nguyen. Send a thank-you gift card.',
      daysAgo: 10,
    },
    {
      kind: 'call',
      by: ls.marco,
      person: 'David Kim',
      lead: 'Mini split · garage',
      body: 'Went with a cheaper install from a neighbor recommendation. Keep him on the maintenance list.',
      daysAgo: 30,
    },
    {
      kind: 'visit',
      by: ls.marco,
      person: 'Hannah Nguyen',
      lead: 'Skylight leak',
      body: 'Flashing pulled away on the north side. Quick fix; measured for the quote.',
      daysAgo: 0,
    },
    {
      kind: 'note',
      by: ls.dale,
      person: 'Robert Chen',
      lead: 'Ductwork repair',
      body: 'Dr. Patel signs off on anything over $2,500. Bring the two options.',
      daysAgo: 0,
    },
  ];
  const activityAges: { id: string; daysAgo: number }[] = [];
  for (const n of notes) {
    const out = await run(
      executeCommand(
        api,
        activityLog,
        {
          workspaceId: ls.id,
          kind: n.kind,
          body: n.body,
          personId: personIds.get(n.person)!,
          leadId: n.lead ? leadIds.get(n.lead)! : null,
          occurredAt: at(-n.daysAgo, 9 + (n.daysAgo % 6)),
        },
        actor(n.by),
        meta(),
      ),
    );
    activityAges.push({ id: out.activityId, daysAgo: n.daysAgo });
  }

  step('Lone Star: Dale uploads two roof photos for Mike Johnson');
  const mike = personIds.get('Mike Johnson')!;
  for (const [name, colour] of [
    ['roof-north-side.png', [91, 110, 130]],
    ['roof-chimney.png', [140, 96, 72]],
  ] as const) {
    const png = pngOf(640, 420, [colour[0], colour[1], colour[2]]);
    const begun = await run(
      executeCommand(
        api,
        fileBeginUpload,
        {
          workspaceId: ls.id,
          recordType: 'person',
          recordId: mike,
          name,
          mimeType: 'image/png',
          sizeBytes: png.length,
        },
        actor(ls.dale),
        meta(),
      ),
    );
    await store.upload(begun.bucket, begun.objectPath, png, 'image/png');
    await executeCommand(
      api,
      fileConfirm,
      { workspaceId: ls.id, fileId: begun.fileId },
      actor(ls.dale),
      meta(),
    );
  }

  step('Bayou Plumbing and Summit Roofing: a few customers and leads each');
  for (const ws of [
    {
      id: workspaces.bayou.id,
      owner: workspaces.bayou.owner,
      people: [
        ['Renata', 'Voss', '713-555-0201'],
        ['Omar', 'Haddad', '281-555-0202'],
        ['Beth', 'Calloway', '832-555-0203'],
        ['Luis', 'Ortega', '713-555-0204'],
        ['Grace', 'Pham', '281-555-0205'],
        ['Ken', 'Adebayo', '832-555-0206'],
      ],
      leads: [
        ['Repipe · 1960s house', 'Renata Voss', 1480000, 'Estimate sent'],
        ['Tankless water heater', 'Omar Haddad', 420000, 'Contacted'],
        ['Slab leak repair', 'Beth Calloway', 260000, 'New'],
      ],
    },
    {
      id: workspaces.summit.id,
      owner: workspaces.summit.owner,
      people: [
        ['Dana', 'Whitlock', '303-555-0301'],
        ['Marcus', 'Bell', '720-555-0302'],
        ['Ingrid', 'Solberg', '303-555-0303'],
        ['Pete', 'Ramirez', '720-555-0304'],
        ['Chloe', 'Bennett', '303-555-0305'],
      ],
      leads: [
        ['Full tear-off and replacement', 'Dana Whitlock', 2260000, 'Estimate sent'],
        ['Hail inspection', 'Marcus Bell', 0, 'New'],
      ],
    },
  ] as const) {
    const ids = new Map<string, string>();
    for (const [first, last, phone] of ws.people) {
      const out = await run(
        executeCommand(
          api,
          personCreate,
          { workspaceId: ws.id, firstName: first, lastName: last, phone, ignoreDuplicates: true },
          actor(ws.owner),
          meta(),
        ),
      );
      ids.set(`${first} ${last}`, out.personId);
    }
    const { pipelines: ps } = await executeQuery(
      api,
      pipelineList,
      { workspaceId: ws.id },
      actor(ws.owner),
      meta(),
    );
    const p = ps[0]!;
    for (const [title, person, value, stage] of ws.leads) {
      const created = await run(
        executeCommand(
          api,
          leadCreate,
          {
            workspaceId: ws.id,
            title,
            personId: ids.get(person)!,
            valueCents: value,
            assigneeUserId: ws.owner.id,
          },
          actor(ws.owner),
          meta(),
        ),
      );
      const target = p.stages.find((s) => s.name === stage)!;
      if (target.id !== created.stageId) {
        for (const s of p.stages.slice(1, p.stages.findIndex((x) => x.id === target.id) + 1)) {
          if (s.kind !== 'open' && s.id !== target.id) continue;
          await executeCommand(
            api,
            leadMoveStage,
            { workspaceId: ws.id, leadId: created.leadId, stageId: s.id },
            actor(ws.owner),
            meta(),
          );
        }
      }
      ages.push({ leadId: created.leadId, days: 2 });
    }
  }

  step('Ageing timestamps so the board and timeline look lived-in');
  // System timeline entries are immutable by trigger (for everyone, postgres included); the seed is the one
  // place that may backdate them, so the trigger is paused for this pass only.
  await rows(admin, sql`alter table app.activities disable trigger activities_system_immutable`);
  for (const a of ages) {
    await rows(
      admin,
      sql`update app.leads set stage_entered_at = now() - (${a.days} || ' days')::interval, created_at = created_at - (${a.days + 2} || ' days')::interval where id = ${a.leadId}`,
    );
    await rows(
      admin,
      sql`update app.activities set occurred_at = occurred_at - (${a.days} || ' days')::interval where lead_id = ${a.leadId} and kind = 'system'`,
    );
  }
  await rows(admin, sql`alter table app.activities enable trigger activities_system_immutable`);
  await rows(
    admin,
    sql`update app.people set created_at = created_at - ((abs(hashtext(id::text)) % 120) || ' days')::interval where workspace_id = ${ls.id}`,
  );
  await executeCommand(
    api,
    leadSetNextAction,
    { workspaceId: ls.id, leadId: leadIds.get('Roof replacement')!, text: null },
    actor(ls.dale),
    meta(),
  );
  void activityAges;
}
