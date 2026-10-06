import { describe, expect, it } from 'vitest';
import {
  asksForPerson,
  asksIfHuman,
  checkTeammateReply,
  claimsHuman,
  disclosesAi,
  EMERGENCY_KINDS,
  EMERGENCY_SAFETY_TEXT,
  emergencyKind,
  HAND_OFF_TOPIC_WORDS,
  isEmergency,
  looksFrustrated,
  optOutPhrase,
  plainSmsText,
  REPLY_RULES,
  sensitiveTopic,
  type ReplyCheckContext,
} from '../src/ai-team/index';
import { SETUP_KIND_INFO, SETUP_KINDS } from '../src/ai-setup/kinds';

/** Each detector against phrasings it must catch, and near misses it must let through. */
function table(fn: (s: string) => unknown, yes: readonly string[], no: readonly string[]): void {
  it.each(yes)('catches “%s”', (s) => expect(fn(s)).toBeTruthy());
  it.each(no)('lets “%s” through', (s) => expect(fn(s)).toBeFalsy());
}

describe('claimsHuman', () => {
  table(
    claimsHuman,
    [
      "I'm a real person!",
      'I am a human.',
      "Yes, I'm human.",
      'Im a real person, not a bot',
      'I’m not a bot, promise.',
      "No, I'm not an AI.",
      'I am not a robot',
      "I'm not automated, this is the office",
      'This is a real person.',
      "You're talking to a real human being.",
      'you are chatting with a live person',
      "I'm an actual person on the team.",
      "I'm definitely a real person.",
      "I'm real!",
      'Nope, not a bot.',
      "This isn't a bot.",
      "It's a real person answering, don't worry.",
      'I’m a person, just like you.',
      "I'm only human 😊",
      'You’re not talking to a machine.',
      "I'm 100% human",
    ],
    [
      "I'm Ava, the AI assistant for Lone Star HVAC.",
      "I'm not a real person — I'm an AI assistant.",
      'A real person from our team will call you shortly.',
      'I can connect you with a real person.',
      'Would you like to talk to a person?',
      "I'm not able to book that, but Dale can.",
      "I'm not sure, let me check.",
      "I'm a virtual assistant for Lone Star.",
      "I'm an automated assistant; someone will follow up.",
      "Dale is a real person and he'll call you.",
      'Our techs are real people who care.',
      "I'm not human, I'm an AI assistant.",
      'This is Ava, an AI assistant.',
      "It's a real pleasure to help.",
      'The person who installed it is out today.',
      "I'm personally making sure this gets done.",
      "I'm happy to help!",
    ],
  );
});

describe('disclosesAi', () => {
  table(
    disclosesAi,
    [
      "Hi Maria, I'm Ava, Lone Star's AI assistant.",
      'This is Ava (AI) from Lone Star HVAC.',
      "I'm a virtual assistant, happy to help.",
      "I'm not a real person, but I can book you in.",
      "I'm an automated assistant for Lone Star.",
    ],
    [
      'Hi Maria, thanks for reaching out to Lone Star HVAC!',
      "I'm not a bot, I'm an AI.",
      'Said and done, see you Thursday.',
    ],
  );
});

describe('asksIfHuman', () => {
  table(
    asksIfHuman,
    [
      'Are you a bot?',
      'are u a robot',
      'r u real?',
      'Is this a real person?',
      'Am I talking to a human?',
      'am i chatting with AI',
      'Is this automated?',
      'Is this an automated message?',
      'Are you a person or a bot?',
      'bot?',
      'Human?',
      'Are you even human?',
      'Wait, are you a real person',
      'Is this ChatGPT?',
      'is this AI',
      'Human or bot?',
      'Are you an actual person',
      'You sound like a robot, are you one?',
      'Am I texting with a machine?',
      'Is this AI generated?',
      'are you real or a bot',
      'Is this a recording?',
    ],
    [
      'Are you open on Saturday?',
      'Is this the right number for AC repair?',
      'Is this price real?',
      'Are you guys hiring?',
      'Is this a real deal or a scam?',
      'I want to talk to a real person',
      'Is that a robot vacuum you sell?',
      'Are you a licensed plumber?',
      'Are you human resources?',
      'lol are you a bot? jk',
      'You sound like a robot lol',
      'My robot vacuum stopped working',
      'Is AI going to replace plumbers?',
      'Can a person come out today?',
      'Is there someone who can help?',
    ],
  );
});

describe('asksForPerson', () => {
  table(
    asksForPerson,
    [
      'I want to talk to a real person',
      'Can I speak to someone?',
      'let me talk to a human',
      'Get me a manager.',
      'Transfer me to an agent',
      'Can someone call me?',
      "I'd like to speak with a representative",
      'operator',
      'Real person please',
      'human pls',
      'Talk to a human',
      'Speak to the owner please',
      'Have someone call me back',
      'I need to talk to somebody about this',
      'Give me a live agent',
      'connect me with a person',
      'I want a human',
      'Is there a person I can talk to?',
      'Put me through to someone',
      'Can you have someone call me?',
      'I need a real person, not a bot',
    ],
    [
      'The person who came yesterday was great',
      'Is this a real person?',
      "I'll talk to my wife and get back to you",
      'Dale spoke to me yesterday',
      'Can you text me the times?',
      'The technician talked to me about the filter',
      'Someone left the gate open',
      'I spoke with someone last week about a quote',
      'My husband wants to talk about pricing',
      'I need a person to come look at the unit',
    ],
  );
});

describe('looksFrustrated', () => {
  table(
    looksFrustrated,
    [
      'This is ridiculous',
      "I'm so frustrated",
      'Worst service ever',
      "You're useless",
      'This is taking forever',
      "I've asked three times already",
      'Nobody is listening',
      'Are you even reading my messages?',
      "I'm fed up",
      'Unacceptable.',
      'What the hell is going on',
      'wtf',
      'This is a joke',
      'Stop wasting my time',
      "I'm done with you guys",
      'Terrible customer service',
      "I'm really upset",
      "I'm pissed off",
      'WHY IS NOBODY ANSWERING',
      'For the third time, my AC is still broken',
      'How many times do I have to ask?',
      "I've been waiting 3 days",
      'Still no reply???',
      'CALL ME BACK NOW',
    ],
    [
      'No rush at all, whenever works',
      'Thanks!!! You guys are great',
      'Is 3pm ok?',
      'The unit makes a horrible noise',
      "My daughter is upset about the heat but we're fine",
      'So excited to get this fixed!',
      "I'm not upset, just curious",
      'It was a joke, never mind',
      'HVAC ASAP please',
      'What the heck is a SEER rating?',
      'Terribly sorry for the late reply',
      'Still waiting on the part, no rush',
    ],
  );
});

describe('optOutPhrase', () => {
  table(
    optOutPhrase,
    [
      'Stop texting me',
      'please stop texting',
      'stop messaging me',
      "Don't text me anymore",
      'do not contact me',
      'Remove me from your list',
      'take me off your list',
      'unsubscribe',
      'Opt me out',
      "I don't want these texts",
      'no more texts please',
      'leave me alone',
      'stop contacting me!',
      'Quit texting me',
      "don't message me again",
      'stop sending me messages',
      'lose my number',
      'delete my number',
      'stop emailing me',
      'never contact me again',
      'STOP',
      'Stop.',
      'UNSUBSCRIBE',
    ],
    [
      'Stop by anytime',
      'the texts you sent were helpful',
      'Can you stop at 3pm?',
      "don't stop the service",
      "my unit won't stop running",
      'How do I stop the AC from leaking?',
      "Stop! That's a great price",
      'Can you text me instead of calling?',
      "Don't text me before 9am",
      'Please text me the address',
      'No more leaks since the repair!',
      'I stopped getting hot water',
    ],
  );

  it('returns the words that opted them out', () => {
    expect(optOutPhrase('Please stop texting me, thanks')).toBe('please stop texting me');
    expect(optOutPhrase(' Stop ')).toBe('Stop');
  });
});

describe('emergencies', () => {
  const cases: [string, (typeof EMERGENCY_KINDS)[number]][] = [
    ['I smell gas in the kitchen', 'gas'],
    ['There’s a gas smell by the furnace', 'gas'],
    ['It smells like rotten eggs in here', 'gas'],
    ['I think we have a gas leak', 'gas'],
    ['I smell gas, can you come now?', 'gas'],
    ['My CO detector is going off', 'carbon_monoxide'],
    ['The carbon monoxide alarm keeps beeping', 'carbon_monoxide'],
    ['Smoke is coming out of the furnace', 'fire'],
    ['The AC unit is on fire!', 'fire'],
    ['There’s a fire in the attic', 'fire'],
    ['The outlet is sparking', 'fire'],
    ['I see flames behind the water heater', 'fire'],
    ['Burning smell from the vents', 'fire'],
    ['The basement is flooding', 'flooding'],
    ['Water is pouring through the ceiling', 'flooding'],
    ['A pipe burst and there’s water everywhere', 'flooding'],
    ['We’re getting flooded', 'flooding'],
    ['My husband got electrocuted by the panel', 'injury'],
    ['Someone is hurt', 'injury'],
    ['He fell off the ladder and he’s bleeding', 'injury'],
    ['My son can’t breathe', 'injury'],
    ['I got a shock from the outlet', 'injury'],
  ];
  it.each(cases)('“%s” is %s', (text, kind) => {
    expect(emergencyKind(text)).toBe(kind);
    expect(isEmergency(text)).toBe(true);
  });

  it.each([
    'Do you service gas furnaces?',
    'How much for a gas line install?',
    'Is my gas water heater covered?',
    'Our fireplace needs cleaning',
    'You guys are fire',
    'Do you install CO detectors?',
    'Can you check my smoke detector battery?',
    'The gas bill is high this month',
    'My basement flooded last year, now it’s fine',
    'Do you fix gas leaks?',
    'I got shocked by the price',
    'The flame sensor needs replacing',
    'Can you install flood lights?',
    'It hurts my wallet',
    'The pilot light won’t stay lit',
    'Do you do carbon monoxide testing?',
  ])('lets “%s” through', (text) => {
    expect(emergencyKind(text)).toBeNull();
    expect(isEmergency(text)).toBe(false);
  });

  // An insurance agent's or a real estate agent's customers ask about these all day.
  it.each([
    'Does my policy cover flooding?',
    'Does home insurance cover flooding?',
    'Am I covered if my basement is flooded?',
    'What if my pipes burst, am I covered?',
    'Is a burst pipe covered by my policy?',
    'Does it cover water coming through the ceiling?',
    'Does the policy cover injuries if someone got hurt at my house?',
    'If someone is hurt on my property am I covered?',
    'Does my auto insurance cover me if I got hurt in an accident?',
    'Has the house had any flooding?',
    'Is the property in a flooding zone?',
    'Any history of flooding or burst pipes?',
    'Has the basement ever been flooded?',
    'Was there ever a fire in the house?',
  ])('lets a question about insurance or a home’s past through: “%s”', (text) => {
    expect(emergencyKind(text)).toBeNull();
  });

  it.each<[string, (typeof EMERGENCY_KINDS)[number]]>([
    ['My house is flooding, am I covered?', 'flooding'],
    ['My house is flooding right now!', 'flooding'],
    ['Pipes burst and water is everywhere', 'flooding'],
    ['If you’re insured, please come now, water is gushing everywhere!', 'flooding'],
    ['We are insured with you and the basement is flooding, what do we do?', 'flooding'],
    ['Are you insured, the basement is flooding?', 'flooding'],
    ['If my basement is flooding right now, am I covered?', 'flooding'],
    ['My neighbor’s pipe burst, is there any flooding in my unit?', 'flooding'],
    ['Pipes burst. Is that covered?', 'flooding'],
    ['Someone is hurt, are we covered?', 'injury'],
  ])('still sees “%s” as %s', (text, kind) => {
    expect(emergencyKind(text)).toBe(kind);
  });

  it('has fixed safety text for each kind, in plain characters', () => {
    expect(Object.keys(EMERGENCY_SAFETY_TEXT).sort()).toEqual([...EMERGENCY_KINDS].sort());
    for (const text of Object.values(EMERGENCY_SAFETY_TEXT)) expect(text).toBe(plainSmsText(text));
    expect(EMERGENCY_SAFETY_TEXT.gas).toMatch(
      /leave the building now.*call 911 or your gas company/,
    );
    // Every kind tells them the same thing about the team, in the same words.
    for (const text of Object.values(EMERGENCY_SAFETY_TEXT))
      expect(text.endsWith(" We've alerted our team.")).toBe(true);
  });
});

describe('sensitiveTopic', () => {
  const cases: [string, string][] = [
    ["I'm going to sue you", 'legal_threat'],
    ['My lawyer will be in touch', 'legal_threat'],
    ['I’ll contact my attorney', 'legal_threat'],
    ['We’re taking legal action', 'legal_threat'],
    ['See you in court', 'legal_threat'],
    ['I’ll take you to small claims', 'legal_threat'],
    ['This is going to be a lawsuit', 'legal_threat'],
    ['I want to file a complaint', 'complaint'],
    ['I’m reporting you to the BBB', 'complaint'],
    ['The technician was rude', 'complaint'],
    ['Your tech damaged my floor', 'complaint'],
    ['I’ll leave a 1-star review', 'complaint'],
    ['I want to complain about the service', 'complaint'],
    ['I want a refund', 'refund'],
    ['Can I get my money back?', 'refund'],
    ['I’m disputing the charge', 'refund'],
    ['I’ll do a chargeback', 'refund'],
    ['Cancel my maintenance plan', 'cancel_service'],
    ['I want to cancel my service', 'cancel_service'],
    ['Please cancel my membership', 'cancel_service'],
    ['Terminate my contract', 'cancel_service'],
  ];
  it.each(cases)('“%s” is %s', (text, kind) => {
    expect(sensitiveTopic(text)?.kind).toBe(kind);
  });

  it.each([
    'Sue will be home at 3',
    'No complaints, great job!',
    'Can I cancel my appointment Tuesday?',
    'My AC broke last night',
    'Is the deposit refundable?',
    'The storm broke my fence',
    'Do you work on courthouses?',
    'My neighbor is a lawyer and recommended you',
    'Please reschedule my service visit',
    'Don’t cancel, just move it to Friday',
  ])('lets “%s” through', (text) => {
    expect(sensitiveTopic(text)).toBeNull();
  });

  it('adds the business’s own topics after the built-in ones', () => {
    expect(sensitiveTopic('Can I make an insurance claim?', ['insurance claim'])).toEqual({
      kind: 'custom',
      label: 'insurance claim',
    });
    expect(sensitiveTopic('Do you offer financing?', ['Financing'])).toEqual({
      kind: 'custom',
      label: 'Financing',
    });
    expect(sensitiveTopic('I want a refund on the financing', ['financing'])).toEqual({
      kind: 'refund',
      label: 'a refund',
    });
    expect(sensitiveTopic('Do you offer financing?', [])).toBeNull();
  });

  it('finds the topics quick setup adds by what customers say', () => {
    const insurance = SETUP_KIND_INFO.insurance.sensitiveTopics;
    const label = (text: string) => sensitiveTopic(text, insurance)?.label ?? null;
    expect(label('Does my policy cover flooding?')).toBe('What a policy covers');
    expect(label('Am I covered if my basement is flooded?')).toBe('What a policy covers');
    expect(label('What’s my deductible?')).toBe('What a policy covers');
    expect(label('I need to file a claim')).toBe('Insurance claims');
    expect(label('Has the adjuster called yet?')).toBe('Insurance claims');
    expect(label('Do you cover Oklahoma?')).toBeNull();
    expect(label('Can I get a quote for my car?')).toBeNull();
    expect(sensitiveTopic('Does my policy cover flooding?', [])).toBeNull();
    for (const kind of SETUP_KINDS)
      for (const topic of SETUP_KIND_INFO[kind].sensitiveTopics)
        expect(HAND_OFF_TOPIC_WORDS[topic.toLowerCase()]).toBeInstanceOf(RegExp);
  });
});

describe('plainSmsText', () => {
  it('writes curly quotes, dashes and ellipses the plain way and drops invisible characters', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    expect(plainSmsText(` We’re “on it” — see you… soon${zeroWidth} `)).toBe(
      'We\'re "on it" - see you... soon',
    );
  });
});

describe('checkTeammateReply', () => {
  const ctx = (over: Partial<ReplyCheckContext> = {}): ReplyCheckContext => ({
    channel: 'sms',
    disclosure: 'when_asked',
    firstMessage: false,
    askedIfHuman: false,
    allowed: {
      domains: ['https://www.lonestarhvac.com/', 'lonestarhvac.wixsite.com'],
      urlPrefixes: ['https://book.handsfreeos.com/lone-star'],
      urls: ['https://app.handsfreeos.com/m/tok_abc123'],
      phones: ['+12145550100', '(972) 555-0142'],
      emails: ['hello@lonestarhvac.com', 'Maria@Example.com'],
    },
    allowPrices: false,
    knowledge: [],
    done: { booked: false, rescheduled: false, cancelled: false },
    discountPercent: null,
    ...over,
  });
  const rules = (reply: string, over?: Partial<ReplyCheckContext>) =>
    checkTeammateReply(reply, ctx(over)).problems.map((p) => p.rule);

  it('passes a good reply', () => {
    const check = checkTeammateReply(
      'Hi Maria! Call us at (214) 555-0100 or see lonestarhvac.com/services. Book here: https://book.handsfreeos.com/lone-star/tune-up',
      ctx(),
    );
    expect(check).toEqual({ ok: true, problems: [] });
  });

  it('lists every problem in rule order, in plain words', () => {
    const check = checkTeammateReply(
      "I'm a real person! You're booked. It's $150, call (469) 555-0199 or see evil.com, [Name]",
      ctx(),
    );
    expect(check.ok).toBe(false);
    expect(check.problems.map((p) => p.rule)).toEqual([
      'claims_human',
      'placeholder',
      'false_claim',
      'money',
      'link',
      'phone',
    ]);
    expect(check.problems.map((p) => p.message)).toEqual([
      'It claims to be a person; it must say it’s an AI',
      'It still has a placeholder: [Name]',
      'It says they’re booked, but nothing was booked',
      'It quotes $150, and prices aren’t allowed',
      'It links to evil.com, which isn’t one of the business’s own links',
      'It gives (469) 555-0199, which isn’t the business’s number or this customer’s',
    ]);
    const order = check.problems.map((p) => REPLY_RULES.indexOf(p.rule));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  describe('length, per channel', () => {
    it('counts a text after the plain-text form', () => {
      expect(rules('a'.repeat(320))).toEqual([]);
      expect(rules('a'.repeat(321))).toEqual(['length']);
      // An ellipsis becomes three dots, so 107 of them are 321 characters.
      expect(rules('…'.repeat(107))).toEqual(['length']);
      expect(rules('’'.repeat(320))).toEqual([]);
    });
    it('allows 800 characters in chat and 200 words in email', () => {
      expect(rules('a'.repeat(800), { channel: 'chat' })).toEqual([]);
      expect(rules('a'.repeat(801), { channel: 'chat' })).toEqual(['length']);
      expect(rules(Array(200).fill('word').join(' '), { channel: 'email' })).toEqual([]);
      expect(rules(Array(201).fill('word').join(' '), { channel: 'email' })).toEqual(['length']);
      expect(rules('a'.repeat(500), { channel: 'email' })).toEqual([]);
    });
  });

  describe('links', () => {
    it.each([
      'See lonestarhvac.com/services for details.',
      'https://www.lonestarhvac.com/financing',
      'Our shop is at shop.lonestarhvac.com',
      'lonestarhvac.wixsite.com/contact',
      'Book here: https://book.handsfreeos.com/lone-star/tune-up',
      'Change it here: https://app.handsfreeos.com/m/tok_abc123.',
      "We're open 8 a.m. to 5 p.m.",
      'e.g. a tune-up or a repair',
      'Thanks.It was great to talk',
      'It takes about 1.5 hours',
      'St. Louis and U.S. customers',
      'Mr.Smith will call',
      'Version 2.0 of the app',
      'Email hello@lonestarhvac.com',
      'Find us at lonestarhvac.com',
    ])('allows “%s”', (reply) => {
      expect(rules(reply)).toEqual([]);
    });

    it.each([
      'Try evil.com',
      'https://bit.ly/3xYz',
      'Go to evil[.]com',
      'Go to evil (dot) com',
      'Go to evil dot com',
      'hxxps://evil.com/x',
      'Visit evil．com',
      'www.evil.io',
      'lonestarhvac.com.evil.io',
      'evil-lonestarhvac.com',
      'http://192.168.1.10/login',
      'https://book.handsfreeos.com/lone-star-deals',
      'book.handsfreeos.com',
      'https://app.handsfreeos.com/m/tok_other',
    ])('blocks “%s”', (reply) => {
      expect(rules(reply)).toEqual(['link']);
    });
  });

  describe('phone numbers and emails', () => {
    it.each([
      'Call us at 214.555.0100',
      'We’ll text you at (972) 555-0142',
      'If it’s an emergency, call 911',
      'Service in ZIP 75201',
      'The unit is $1,500',
      'We came out on 9/14/2026',
      'We’ll write to maria@example.com',
    ])('allows “%s”', (reply) => {
      expect(rules(reply, { allowPrices: true, knowledge: ['A new unit is $1,500.'] })).toEqual([]);
    });

    it.each([
      ['Call Mike at (469) 555-0199', 'phone'],
      ['Call +1 972-555-0177', 'phone'],
      ['Our UK office: +44 20 7946 0958', 'phone'],
      ['Email dale@gmail.com', 'email'],
      ['Email dale [at] gmail [dot] com', 'email'],
      ['Email dale(at)gmail.com', 'email'],
      ['Email dale at gmail dot com', 'email'],
    ])('blocks “%s”', (reply, rule) => {
      expect(rules(reply)).toEqual([rule]);
    });
  });

  describe('money', () => {
    const knowledge = [
      'Tune-ups are $89 and come with a free filter.',
      'Maintenance plans save 15% on repairs.',
    ];
    const priced = { allowPrices: true, knowledge };

    it('blocks prices, percentages and “free” when prices aren’t allowed', () => {
      expect(rules('A tune-up is $89.')).toEqual(['money']);
      expect(rules('Save 10% today')).toEqual(['money']);
      expect(rules('We offer free estimates')).toEqual(['money']);
      expect(rules('That is 89 dollars')).toEqual(['money']);
    });

    it('allows what the knowledge used says, and only that, when prices are allowed', () => {
      expect(rules('A tune-up is $89.', priced)).toEqual([]);
      expect(rules('A tune-up is $89.00.', priced)).toEqual([]);
      expect(rules('Plans save 15% on repairs.', priced)).toEqual([]);
      expect(rules('It comes with a free filter.', priced)).toEqual([]);
      expect(rules('A tune-up is $99.', priced)).toEqual(['money']);
      expect(rules('Plans save 20%.', priced)).toEqual(['money']);
      expect(rules('We give free estimates.', priced)).toEqual(['money']);
      expect(rules('A tune-up is $89.', { knowledge })).toEqual(['money']);
    });

    it('never offers a discount or a refund on its own', () => {
      expect(rules('I can give you a 10% discount', priced)).toEqual(['money', 'money']);
      expect(rules('Use coupon code SAVE', priced)).toEqual(['money']);
      expect(rules("We'll refund you.", priced)).toEqual(['money']);
      expect(rules('Deposits are refundable.', priced)).toEqual(['money']);
      expect(checkTeammateReply("We'll refund you.", ctx()).problems[0]!.message).toBe(
        'It talks about a refund; refunds go to a person',
      );
    });

    it('mentions a discount proposed this run, at its percent (the reply waits for approval)', () => {
      expect(rules('I can offer 10% off your repair.', { discountPercent: 10 })).toEqual([]);
      expect(rules('I can offer a 10% discount.', { discountPercent: 10 })).toEqual([]);
      expect(rules('I can offer 15% off your repair.', { discountPercent: 10 })).toEqual(['money']);
      expect(rules("We'll refund you instead.", { discountPercent: 10 })).toEqual(['money']);
    });

    it('lets “free” in the everyday sense through', () => {
      expect(rules('Feel free to text us anytime.')).toEqual([]);
      expect(rules('Are you free Thursday at 2?')).toEqual([]);
      expect(rules('We are free on Thursday.')).toEqual([]);
    });
  });

  describe('placeholders', () => {
    it.each([
      'Hi {{first_name}}!',
      'Thanks, [Your Name]',
      'See you at XX:XX',
      'Hi {name}',
      'Dear <customer name>,',
      'Sign here: ___',
      'We can come [insert time].',
      "I've passed this on, and {expectation}.",
    ])('blocks “%s”', (reply) => {
      expect(rules(reply)).toEqual(['placeholder']);
    });

    it.each(['Text hello@lonestarhvac.com :)', 'We’re open 8–5', '<3 thanks', 'A size XXL filter'])(
      'allows “%s”',
      (reply) => {
        expect(rules(reply)).toEqual([]);
      },
    );
  });

  describe('booking claims', () => {
    it.each([
      'You’re booked for Thursday at 2 PM.',
      'I’ve booked you in for 9 AM tomorrow.',
      'Your appointment is confirmed for Friday.',
      'Got you down for Monday at 10.',
      'Not sure yet, but you’re all set for Friday at 3.',
    ])('blocks “%s” when nothing was booked', (reply) => {
      expect(rules(reply)).toEqual(['false_claim']);
      expect(
        rules(reply, { done: { booked: true, rescheduled: false, cancelled: false } }),
      ).toEqual([]);
    });

    it.each([
      'Once you pick a time, you’re booked.',
      'I haven’t booked you yet.',
      'Would you like me to book you for Thursday?',
      'Are you booked already?',
      'If that works, you’re all set for Friday.',
      'When you’re booked, you’ll get a text.',
    ])('allows “%s”', (reply) => {
      expect(rules(reply)).toEqual([]);
    });

    it('needs a reschedule or a cancellation for those claims', () => {
      const moved = 'I’ve moved your appointment to Friday at 3.';
      const gone = 'Your appointment has been cancelled.';
      expect(rules(moved)).toEqual(['false_claim']);
      expect(rules(gone)).toEqual(['false_claim']);
      expect(
        rules(moved, { done: { booked: false, rescheduled: true, cancelled: false } }),
      ).toEqual([]);
      expect(
        rules('You’re booked for Friday at 3 instead.', {
          done: { booked: false, rescheduled: true, cancelled: false },
        }),
      ).toEqual([]);
      expect(rules(gone, { done: { booked: false, rescheduled: false, cancelled: true } })).toEqual(
        [],
      );
    });
  });

  describe('disclosure', () => {
    const plain = 'Hi Maria, thanks for reaching out to Lone Star HVAC!';
    const honest = "Hi Maria, I'm Ava, Lone Star's AI assistant. How can I help?";

    it('in first-message mode, the first message says it’s AI', () => {
      const first = { disclosure: 'first_message' as const, firstMessage: true };
      expect(rules(plain, first)).toEqual(['disclosure']);
      expect(rules(honest, first)).toEqual([]);
      expect(rules(plain, { disclosure: 'first_message', firstMessage: false })).toEqual([]);
      expect(rules(plain, { disclosure: 'when_asked', firstMessage: true })).toEqual([]);
    });

    it('in either mode, a sincere question gets the truth', () => {
      for (const disclosure of ['first_message', 'when_asked'] as const) {
        expect(rules('Yes! How can I help?', { disclosure, askedIfHuman: true })).toEqual([
          'disclosure',
        ]);
        expect(
          rules("I'm an AI assistant, but a person can call you.", {
            disclosure,
            askedIfHuman: true,
          }),
        ).toEqual([]);
      }
    });

    it('never lets it claim to be a person, whatever the mode', () => {
      for (const disclosure of ['first_message', 'when_asked'] as const)
        expect(
          rules("I'm a real person, how can I help?", {
            disclosure,
            firstMessage: true,
            askedIfHuman: true,
          }),
        ).toEqual(['claims_human']);
    });
  });
});
