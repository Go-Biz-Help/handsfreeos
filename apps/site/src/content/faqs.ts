/**
 * The questions and answers that appear on the pages, in one place.
 *
 * The pages render these, and the pages' FAQPage structured data is built from the same array, so
 * what a search engine or an assistant is told can never drift from what a reader sees.
 */

export type Faq = { readonly q: string; readonly a: string };

/** The "Fair questions" block on the home page. */
export const homeFaqs: readonly Faq[] = [
  {
    q: 'Will my customers know they are talking to an AI?',
    a: 'You decide, and you write the wording. Most businesses have it say something like "this is Ava, Lone Star’s assistant" on the first message. It never claims to be you, and it hands over to a person the moment somebody asks for one or sounds unhappy.',
  },
  {
    q: 'What happens if it says something wrong?',
    a: 'For the first weeks it cannot say anything without you pressing send. After that it only sends on its own for the kinds of messages you have approved over and over. Prices stay locked until you turn them on, and then it can only quote a number exactly as you wrote it.',
  },
  {
    q: 'Do I have to give up my phone number?',
    a: 'No. You can bring the number your customers already have, or start with a new one and forward the old one. Calls still ring your actual cell phone — this is not a system that makes you answer calls in an app.',
  },
  {
    q: 'I am not technical. How long does setup take?',
    a: 'An afternoon, and you do not do it on your own. Most of it is answering questions in plain English — the Assistant sets up your hours, services, reminders and the rest from what you tell it. Carrier registration for texting takes a few business days in the background.',
  },
  {
    q: 'What about the customers and history I already have?',
    a: 'They come across. A spreadsheet imports in a few minutes. From another CRM, everything is counted before anything moves, the same customer arriving twice is joined without guessing, old conversations keep the dates they really happened on, and the whole thing can be undone. The migration is proven on GoHighLevel first, with more systems following — tell us what you are on and we will tell you where it stands.',
  },
  {
    q: 'Can my crew use it out in the field?',
    a: 'That is what the phone app is for. Everything works with no signal and catches up later, photos and notes attach to the job, and payment links go out from the driveway.',
  },
];

/** The "What people ask about the price" block on the pricing page. */
export const pricingFaqs: readonly Faq[] = [
  {
    q: 'What does "start free" mean?',
    a: 'You can make an account, bring your customers in and look around without paying. You start a plan when you want a business number and the AI answering for you — that is the point where it costs us real money on your behalf.',
  },
  {
    q: 'Is there a contract?',
    a: 'No. Month to month, cancel whenever. Your customers, conversations and files export on your way out.',
  },
  {
    q: 'Do you take a cut of what I get paid?',
    a: 'No. Your customers pay into your own Stripe or Square account and you pay those companies their normal card fee. HandsFreeOS never touches the money.',
  },
  {
    q: 'Why is there usage on top?',
    a: 'Because the phone companies charge per text and per minute, and the AI charges per reply. We pass those through rather than pad the plan for the businesses that barely use them.',
  },
  {
    q: 'Does Growth hold anything back for Pro?',
    a: 'No. Growth is every feature HandsFreeOS has, for one business. The only thing Pro adds is running more than one business or location, and the help that comes with that.',
  },
  {
    q: 'What happens when there are more than 8 of us?',
    a: 'Growth covers eight people, then it is $15 a month for each person after that. Pro has no per-person charge at all, which is usually the cheaper answer once a team gets big.',
  },
  {
    q: 'What if I have two locations?',
    a: 'That is Pro: several businesses under one login, each with its own number, calendar and books, one place you can see them all from, and your templates and knowledge shared across them.',
  },
  {
    q: 'Can you move me off the CRM I use now?',
    a: 'Yes, and it is included in every plan, not a paid extra. On Starter and Growth you run it yourself — it counts everything before it moves anything, and it can be undone. On Pro we do it with you.',
  },
  {
    q: 'Is support better on the expensive plan?',
    a: 'Everyone gets the same email support from the people who build it. Pro jumps the queue and gets someone who sets the whole thing up with you, because several locations is more to set up.',
  },
  {
    q: 'Can I change plans later?',
    a: 'Any time, in both directions. Going down never deletes anything — features just stop being available.',
  },
];
