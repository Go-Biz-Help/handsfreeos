/**
 * Adding a contact on the phone by typing it in or scanning a business card (crm/business-card.ts): what the AI reads
 * off a card is tidied; each side fills only the boxes still empty, so the back never undoes a fix; the form is
 * checked as `person.create` will check it, so nothing queued with no signal is refused later; and companies are
 * matched by name whatever the punctuation.
 */
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_CARD_ASK,
  BUSINESS_CARD_SOURCE,
  BUSINESS_CARD_WORDS,
  BusinessCardAnswer,
  CompanyCreateInput,
  PersonCreateInput,
  cardContactFromAnswer,
  checkCardForm,
  companyKey,
  businessCardAsk,
  cornersFromAnswer,
  EMPTY_CARD_FORM,
  fillCardForm,
  ReadCardInput,
  type CardForm,
} from '../src';

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const answer = (over: Partial<BusinessCardAnswer> = {}): BusinessCardAnswer =>
  BusinessCardAnswer.parse({
    isCard: true,
    corners: [
      { x: 100, y: 150 },
      { x: 900, y: 160 },
      { x: 880, y: 700 },
      { x: 120, y: 690 },
    ],
    firstName: 'MARIA',
    lastName: "O'NEILL-DIAZ",
    jobTitle: 'Owner',
    company: 'Lopez Roofing',
    phones: [
      { number: '(713) 555-0100', label: 'O:' },
      { number: '713.555.0142', label: 'c' },
      { number: '713-555-0100', label: 'Office' },
      { number: '(713) 555-0199', label: 'F' },
    ],
    emails: [{ email: 'mailto:Maria@LopezRoofing.com', label: '' }],
    website: 'https://www.lopezroofing.com/',
    address: {
      street: '1200 Main St, Suite 4',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      country: 'us',
    },
    extra: 'TX roofing licence 12345',
    ...over,
  });

describe('what the AI read off a card', () => {
  it('is tidied: names cased, labels plain, each number and email once', () => {
    const card = cardContactFromAnswer(answer());
    expect(card).toMatchObject({
      firstName: 'Maria',
      lastName: "O'Neill-Diaz",
      phones: [
        { number: '(713) 555-0100', label: 'Office' },
        { number: '713.555.0142', label: 'Mobile' },
        { number: '(713) 555-0199', label: 'Fax' },
      ],
      emails: [{ email: 'maria@lopezroofing.com', label: '' }],
      website: 'www.lopezroofing.com',
      address: { country: 'US', postalCode: '77002' },
    });
    // A name printed with small letters is kept as printed.
    expect(
      cardContactFromAnswer(answer({ firstName: 'DeShawn', lastName: 'McAdams' })),
    ).toMatchObject({
      firstName: 'DeShawn',
      lastName: 'McAdams',
    });
  });

  it('has corners only for a card with an outline the size of one', () => {
    // The AI gives pixels of the picture it was shown; the form takes shares of the picture.
    const picture = { width: 1000, height: 1000 };
    expect(cornersFromAnswer(answer(), picture)).toEqual([
      { x: 0.1, y: 0.15 },
      { x: 0.9, y: 0.16 },
      { x: 0.88, y: 0.7 },
      { x: 0.12, y: 0.69 },
    ]);
    expect(cornersFromAnswer(answer({ corners: [] }), picture)).toBeNull();
    expect(cornersFromAnswer(answer({ isCard: false }), picture)).toBeNull();
    const sliver = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ];
    expect(cornersFromAnswer(answer({ corners: sliver }), picture)).toBeNull();
  });

  it('reads the AI’s corners at the size of the picture it was shown', () => {
    // A phone's upright photo as the AI sees it. Read as thousandths, these landed a card's height too low.
    const picture = { width: 1176, height: 1568 };
    const corners = [
      { x: 212, y: 750 },
      { x: 934, y: 752 },
      { x: 947, y: 1170 },
      { x: 198, y: 1178 },
    ];
    const shares = cornersFromAnswer(answer({ corners }), picture)!;
    expect(shares[0]!.x).toBeCloseTo(0.18, 2);
    expect(shares[0]!.y).toBeCloseTo(0.478, 2);
    expect(shares[2]!.x).toBeCloseTo(0.805, 2);
    expect(shares[2]!.y).toBeCloseTo(0.746, 2);
    // A corner past the picture's edge is held at the edge.
    const past = [corners[0]!, { x: 1300, y: 752 }, { x: 1300, y: 1700 }, corners[3]!];
    expect(cornersFromAnswer(answer({ corners: past }), picture)![2]).toEqual({ x: 1, y: 1 });
    expect(businessCardAsk(picture)).toBe(
      `${BUSINESS_CARD_ASK} The picture is 1176 pixels wide and 1568 pixels high.`,
    );
  });
});

describe('filling the form from a card', () => {
  it('puts a mobile number first, so texts reach a cell, and keeps the rest with their labels', () => {
    const { form, filled } = fillCardForm(EMPTY_CARD_FORM, cardContactFromAnswer(answer()));
    expect(form).toMatchObject({
      name: "Maria O'Neill-Diaz",
      jobTitle: 'Owner',
      company: 'Lopez Roofing',
      phone: '713.555.0142',
      otherPhones: [
        { number: '(713) 555-0100', label: 'Office' },
        { number: '(713) 555-0199', label: 'Fax' },
      ],
      email: 'maria@lopezroofing.com',
      street: '1200 Main St, Suite 4',
      country: 'US',
      note: BUSINESS_CARD_WORDS.extraLine('TX roofing licence 12345'),
    });
    expect(filled).toBe(13);
  });

  it('lets the back fill only what is still empty, and add numbers not there yet', () => {
    const front = fillCardForm(
      EMPTY_CARD_FORM,
      cardContactFromAnswer(
        answer({ phones: [{ number: '713 555 0142', label: 'Cell' }], extra: '' }),
      ),
    ).form;
    // The person fixed the name after the front was read.
    const fixed: CardForm = { ...front, name: 'Maria Lopez' };
    const back = cardContactFromAnswer(
      answer({
        firstName: 'Someone',
        lastName: 'Else',
        phones: [
          { number: '(713) 555-0142', label: 'Mobile' },
          { number: '(281) 555-0177', label: 'Direct' },
        ],
        emails: [{ email: 'office@lopezroofing.com', label: 'Office' }],
        extra: 'Free estimates',
      }),
    );
    const { form, filled } = fillCardForm(fixed, back);
    expect(form.name).toBe('Maria Lopez');
    expect(form.phone).toBe('713 555 0142');
    expect(form.otherPhones).toEqual([{ number: '(281) 555-0177', label: 'Direct' }]);
    expect(form.otherEmails).toEqual([{ email: 'office@lopezroofing.com', label: 'Office' }]);
    expect(form.note).toBe(BUSINESS_CARD_WORDS.extraLine('Free estimates'));
    expect(filled).toBe(3);
    // The same side again adds nothing.
    expect(fillCardForm(form, back).filled).toBe(0);
  });
});

describe('checking the form', () => {
  const scanned = fillCardForm(EMPTY_CARD_FORM, cardContactFromAnswer(answer())).form;

  it('makes what person.create and company.create take, with the job title and website leading the note', () => {
    const check = checkCardForm(scanned, { scanned: true });
    if (!check.ok) throw new Error(check.message);
    expect(check.name).toBe("Maria O'Neill-Diaz");
    expect(check.person).toMatchObject({
      phone: '+17135550142',
      email: 'maria@lopezroofing.com',
      otherPhones: [
        { phone: '+17135550100', label: 'Office' },
        { phone: '+17135550199', label: 'Fax' },
      ],
      address: {
        line1: '1200 Main St, Suite 4',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        country: 'US',
      },
      notes: [
        'Job title: Owner',
        'Website: www.lopezroofing.com',
        'Also on the card: TX roofing licence 12345',
      ].join('\n'),
      source: BUSINESS_CARD_SOURCE,
    });
    expect(check.company).toEqual({ name: 'Lopez Roofing', website: 'www.lopezroofing.com' });
    expect(
      PersonCreateInput.safeParse({
        workspaceId: WORKSPACE,
        id: WORKSPACE,
        ...check.person,
        companyId: WORKSPACE,
      }).success,
    ).toBe(true);
    expect(CompanyCreateInput.safeParse({ workspaceId: WORKSPACE, ...check.company }).success).toBe(
      true,
    );
  });

  it('takes a contact typed in with only a name, and gives it no source', () => {
    const check = checkCardForm({ ...EMPTY_CARD_FORM, name: '  Mike  ' }, { scanned: false });
    expect(check).toMatchObject({
      ok: true,
      name: 'Mike',
      person: {
        firstName: 'Mike',
        lastName: '',
        phone: null,
        email: null,
        notes: null,
        source: null,
      },
      company: null,
    });
    if (check.ok) expect('address' in check.person).toBe(false);
  });

  it('adds a card with only a business name under that name, with no company to link as well', () => {
    const check = checkCardForm(
      { ...EMPTY_CARD_FORM, company: 'Acme Plumbing' },
      { scanned: true },
    );
    expect(check).toMatchObject({ ok: true, name: 'Acme Plumbing', company: null });
  });

  it('says which box is wrong and how to fix it', () => {
    expect(checkCardForm(EMPTY_CARD_FORM, { scanned: false })).toMatchObject({
      ok: false,
      rule: 'no_name',
      field: 'name',
    });
    expect(checkCardForm({ ...scanned, phone: '12' }, { scanned: true })).toMatchObject({
      ok: false,
      rule: 'bad_phone',
      field: 'phone',
    });
    const badOther = checkCardForm(
      { ...scanned, otherPhones: [...scanned.otherPhones, { number: '555', label: 'Fax' }] },
      { scanned: true },
    );
    expect(badOther).toMatchObject({ ok: false, rule: 'bad_phone', field: 'otherPhones:2' });
    if (!badOther.ok) expect(badOther.message).toContain('“555”');
    expect(checkCardForm({ ...scanned, email: 'maria@' }, { scanned: true })).toMatchObject({
      ok: false,
      rule: 'bad_email',
      field: 'email',
    });
    // An empty extra box is just left out.
    expect(
      checkCardForm({ ...scanned, otherPhones: [{ number: ' ', label: '' }] }, { scanned: true })
        .ok,
    ).toBe(true);
  });
});

describe('the business’s companies', () => {
  it('match by name whatever the case, spacing, punctuation or Inc.', () => {
    expect(companyKey('Lopez Roofing, LLC')).toBe(companyKey('lopez  roofing'));
    expect(companyKey('Smith & Sons Inc.')).toBe(companyKey('Smith and Sons'));
    expect(companyKey('Café Olé')).toBe(companyKey('cafe ole'));
    expect(companyKey('Lopez Roofing')).not.toBe(companyKey('Lopez Plumbing'));
  });
});

describe('what the phone sends', () => {
  it('is a side, a picture and, when placed by hand, four corners', () => {
    const image = 'A'.repeat(100);
    expect(ReadCardInput.safeParse({ workspaceId: WORKSPACE, side: 'front', image }).success).toBe(
      true,
    );
    expect(ReadCardInput.safeParse({ workspaceId: WORKSPACE, side: 'middle', image }).success).toBe(
      false,
    );
    expect(
      ReadCardInput.safeParse({
        workspaceId: WORKSPACE,
        side: 'back',
        image,
        corners: [{ x: 0, y: 0 }],
      }).success,
    ).toBe(false);
  });
});
