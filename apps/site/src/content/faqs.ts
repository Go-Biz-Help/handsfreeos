/**
 * The questions and answers that appear on the pages, in one place.
 *
 * The pages render these, and the pages' FAQPage structured data is built from the same array, so
 * what a search engine or an assistant is told can never drift from what a reader sees.
 */

import { moneyBack, typicalUsage } from './site';

export type Faq = { readonly q: string; readonly a: string };

/**
 * The "Fair questions" block on the home page: the owner's objections in their own words, each answered with how
 * the product handles it and then the safety net.
 */
export const homeFaqs: readonly Faq[] = [
  {
    q: 'I tried a CRM before. It just became another job.',
    a: `That is the exact problem this one was built to fix. Most CRMs wait for you to type things in. HandsFreeOS fills itself in from every call, text and payment, and does the follow-ups for you. If it still feels like a job after ${moneyBack.days} days, ask and you get your money back.`,
  },
  {
    q: 'I don’t have time to switch.',
    a: 'You answer questions in plain English for an afternoon, and the Assistant sets up your hours, services, reminders and the rest from what you tell it. Your customers move over from a spreadsheet in a few minutes, or from your old CRM, counted before anything moves and undoable. The only real wait is the carriers approving your texting, which takes a few business days in the background.',
  },
  {
    q: 'What happens if the AI says something wrong?',
    a: 'For the first weeks it cannot send anything without you pressing send. After that it only sends on its own the kinds of messages you have approved again and again. Prices stay locked until you turn them on, and then it can only quote a number exactly as you wrote it. Money questions and upset customers always come to you.',
  },
  {
    q: 'Will my customers know they are talking to an AI?',
    a: 'You decide, and you write the wording. Most businesses have it say something like "this is Ava, Lone Star’s assistant" on the first message. It never claims to be you, and it hands over to a person the moment somebody asks for one or sounds unhappy.',
  },
  {
    q: 'How can it replace ten apps for $97?',
    a: `It is one system built as one, not ten companies each charging for their slice. The texts, calls and AI you use are billed at what they cost us plus a small margin, usually $${typicalUsage.low} to $${typicalUsage.high} a month, so the plan is not padded for the busiest businesses. And there is no charge per person.`,
  },
  {
    q: 'I already pay for Jobber or GoHighLevel.',
    a: 'Then you would stop paying for the tools around it, and for each extra person. Moving is included rather than a paid extra: everything is counted before anything moves, the same customer arriving twice is joined without guessing, old conversations keep the dates they really happened on, and the whole move can be undone. It is proven on GoHighLevel first, with more systems following. Tell us what you are on and we will tell you where it stands.',
  },
  {
    q: 'Do I have to give up my phone number?',
    /**
     * Deliberately promises nothing about the number itself. Porting is not built, and forwarding depends
     * entirely on the old carrier — so both halves of what this used to say were promises we could not keep
     * for everybody. Every setup genuinely is different; the honest answer is a conversation. What stays is
     * the part that is true whichever way it goes.
     */
    a: 'Every business is set up differently, so this one is worth talking through before you start — tell us how your number works today and we will tell you what your options are. Whichever way it goes, calls still ring your actual cell phone: this is not a system that makes you answer calls in an app.',
  },
  {
    q: 'Can my crew use it out in the field?',
    a: 'If they can text, they can use it. That is what the phone app is for: everything works with no signal and catches up later, photos and notes attach to the job, and payment links go out from the driveway. There is no charge per person, so everyone can have it.',
  },
  {
    q: 'What if it isn’t for me?',
    a: `${moneyBack.line} There is no contract either: stop it renewing any time in Settings, and export your customers, conversations and files on your way out.`,
  },
];

/** The "What people ask about the price" block on the pricing page. */
export const pricingFaqs: readonly Faq[] = [
  {
    q: 'How do I get a founding spot?',
    a: 'Sign up, make your business, and pick a spot: $497 a year or $97 a month. You pay on Stripe’s secure page, and your spot is held for an hour while you do. It is first come, first served, and the counts on this page are read live from our database, so when it says none are left, none are.',
  },
  {
    q: 'Is there a contract?',
    a: 'No. A monthly spot renews each month and a yearly one each year, until you stop it, which you can do any time in Settings. Your customers, conversations and files export on your way out.',
  },
  {
    q: 'What if it isn’t for me?',
    a: `${moneyBack.line} Email us within ${moneyBack.days} days of your first payment and it is done; there is nothing to fill in.`,
  },
  {
    q: 'Why only one plan?',
    a: 'Because three plans meant three conversations before anybody could buy: which one am I, what am I missing, will I have to move later. A business with four people and one with twenty need the same software. So there is one plan, everything is in it, and there is no per-person charge — you are paying for the work it does, not for how many people log in to it.',
  },
  {
    q: 'Do you take a cut of what I get paid?',
    a: 'No. Your customers pay into your own Stripe or Square account and you pay those companies their normal card fee. HandsFreeOS never touches the money.',
  },
  {
    q: 'Why is there usage on top?',
    a: 'Because the phone companies charge per text and per minute, and the AI charges per reply. Billing it as you use it keeps the plan from being padded for businesses that barely use them. The per-use rates are shown in your account, and they are the same on both founding spots.',
  },
  {
    q: 'What does a founding spot cover?',
    a: `The software, including the features we add to it later: $497 a year on a yearly spot, or $97 a month on a monthly one, renewed until you stop it. It does not cover texts, calls, phone numbers or AI replies, because those are billed to us by other companies and passed through at what they cost plus a small margin. Most businesses spend $${typicalUsage.low}–$${typicalUsage.high} a month on that.`,
  },
  {
    q: 'What happens when the founding spots run out?',
    a: 'Each kind has its own count, so when the yearly spots are gone the monthly ones may still have room. When neither has any left, email us and we will tell you when more open.',
  },
  {
    q: 'Could you take a founding spot back?',
    a: 'Only for a real reason — an account that was never used, or somebody abusing it — and never without telling you first. If it happens you get two weeks\u2019 notice, nothing changes during those two weeks, and everything you have is yours to export.',
  },
  {
    q: 'Can you move me off the CRM I use now?',
    a: 'Yes, and it is included rather than a paid extra. It counts everything before it moves anything, and it can be undone.',
  },
  {
    q: 'What if I have two businesses?',
    a: 'Each one gets its own workspace with its own number, calendar and books, and each needs a founding spot of its own.',
  },
];
