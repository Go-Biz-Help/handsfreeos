import { balanceCents } from '@hfos/core';

import {
  companySearchText,
  invoiceBalanceCents,
  leadSearchText,
  matchesSearch,
  personSearchText,
} from '../compute';

describe('what the phone works out', () => {
  it('gives a customer the search text the database would', () => {
    const maria = {
      first_name: 'Maria',
      last_name: 'López',
      email: 'Maria.Lopez@Example.com',
      phone_e164: '+17135550142',
      city: 'Houston',
      address_line1: '1204 Oak Hollow Dr',
    };
    // lower(first || ' ' || last || ' ' || email || ' ' || phone_e164 || ' ' || city || ' ' || address_line1
    //   || ' ' || private.other_contacts_text(…)), and she has no other ways to reach her yet.
    expect(personSearchText(maria)).toBe(
      'maria lópez maria.lopez@example.com +17135550142 houston 1204 oak hollow dr ',
    );
    // Missing details are empty, so the spaces stay where the database puts them.
    expect(
      personSearchText({
        ...maria,
        email: null,
        phone_e164: null,
        city: null,
        address_line1: null,
      }),
    ).toBe('maria lópez     ');
    expect(matchesSearch(personSearchText(maria), 'OAK HOLLOW')).toBe(true);
    expect(matchesSearch(personSearchText(maria), '713555')).toBe(true);
    expect(matchesSearch(personSearchText(maria), '(713)')).toBe(false);
  });

  it('finds a customer by their other emails, numbers and addresses, spaced as the database spaces them', () => {
    const row = {
      first_name: 'Maria',
      last_name: null,
      email: null,
      phone_e164: null,
      city: null,
      address_line1: null,
      other_emails: '[{"email":"a@b.co"}]',
      other_phones: '[{"phone":"+1555"},{"phone":"+1666","label":"Work"}]',
      other_addresses: '[{"label":"x"},{"city":"Austin","line1":"1 Main"}]',
    };
    // select private.other_contacts_text(<the same three lists>) → 'a@b.co +1555 +1666  Austin 1 Main'
    expect(personSearchText(row)).toBe('maria      a@b.co +1555 +1666  austin 1 main');
    expect(matchesSearch(personSearchText(row), '+1666')).toBe(true);
    // An address with neither a city nor a first line still takes its place, as an empty one.
    expect(
      personSearchText({
        ...row,
        other_emails: '[]',
        other_phones: null,
        other_addresses: '[{"state":"TX"}]',
      }),
    ).toBe('maria      ');
    // Something that isn't a list reads as none.
    expect(
      personSearchText({ ...row, other_emails: 'oops', other_phones: '{}', other_addresses: '[]' }),
    ).toBe('maria      ');
  });

  it('gives companies and leads theirs', () => {
    expect(
      companySearchText({
        name: 'Oak Hollow HOA',
        email: null,
        phone_e164: '+17135550100',
        city: 'Houston',
        address_line1: null,
      }),
    ).toBe('oak hollow hoa  +17135550100 houston  ');
    expect(leadSearchText({ title: 'AC Replacement' })).toBe('ac replacement');
    expect(leadSearchText({ title: null })).toBe('');
  });

  it('works out an invoice’s balance with core’s own sum', () => {
    const invoice = (total: number, paid: number, refunded: number) => ({
      total_cents: total,
      amount_paid_cents: paid,
      amount_refunded_cents: refunded,
    });
    const cases: [number, number, number][] = [
      [18900, 0, 0],
      [18900, 5000, 0],
      [18900, 18900, 0],
      // A refund gives money back and never puts it back on the bill…
      [18900, 18900, 18900],
      // …except that it uses up an overpayment: paid $120 on $100 is a $20 credit, and giving $20 back clears it.
      [10000, 12000, 0],
      [10000, 12000, 2000],
      [10000, 12000, 5000],
    ];
    for (const [total, paid, refunded] of cases)
      expect(invoiceBalanceCents(invoice(total, paid, refunded))).toBe(
        balanceCents(total, paid, refunded),
      );
    expect(invoiceBalanceCents(invoice(18900, 5000, 0))).toBe(13900);
    expect(invoiceBalanceCents(invoice(10000, 12000, 0))).toBe(-2000);
    expect(invoiceBalanceCents(invoice(10000, 12000, 5000))).toBe(0);
    expect(
      invoiceBalanceCents({
        total_cents: null,
        amount_paid_cents: null,
        amount_refunded_cents: null,
      }),
    ).toBe(0);
  });
});
