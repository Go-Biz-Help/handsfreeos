/**
 * Social Outreach: the playbook's short video (docs/outreach.md, decision 69; ../../src/addons/outreach/video.ts). The
 * AI writes its script part by part from the live main offer and the playbook's niche, never inventing a result; one
 * part can be written again; the link is an https link with a real host; and the playbook keeps both (data version 5).
 */
import { describe, expect, it } from 'vitest';
import {
  blankPlaybook,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '../../src/addons/outreach/playbooks';
import {
  checkedScript,
  scriptMinutes,
  VIDEO_LINK_WORDS,
  VIDEO_PART_KEYS,
  videoLinkProblem,
  videoOfferOf,
  videoScriptPrompt,
  VideoScriptInput,
  type VideoScript,
} from '../../src/addons/outreach/video';
import { MainOfferParts } from '../../src/main-offer/parts';

const at = new Date('2026-10-15T09:00:00.000Z');
const draft = {
  name: 'Roofers',
  niche: 'Roofers with 2 to 3 crews',
  problem: 'No steady jobs between storms',
  proof: ['Peak Roofing got 22 inspections in 60 days'],
  offer: 'A 20-minute call',
  avoid: ['guaranteed results'],
};
const offer = videoOfferOf(
  2,
  MainOfferParts.parse({
    who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'Slow months between storms' },
    outcome: { result: '10 to 20 booked inspections a month', why: 'Crews sit idle' },
    timeframe: { typical: '60 days' },
    method: { steps: ['Find homeowners', 'Ask straight out', 'Book the inspection'] },
    guarantee: { promise: 'If you don’t get 10, you don’t pay' },
    price: { amount: '$2,000 a month' },
    proof: ['Summit Roofing booked 14 in 30 days'],
  }),
);
const answer = (say = (k: string) => `Here’s the ${k} part — said plainly.`) => ({
  parts: VIDEO_PART_KEYS.map((part) => ({ part, say: say(part), show: `Show for ${part}` })),
});

describe('the short video’s script', () => {
  it('asks for every part from the offer and the niche, with only the real results as proof', () => {
    const prompt = videoScriptPrompt(VideoScriptInput.parse({ draft }), 'Summit Roof Leads', offer);
    expect(prompt).toContain('Niche: Roofers with 2 to 3 crews');
    expect(prompt).toContain('- Book the inspection');
    expect(prompt).toContain('- Peak Roofing got 22 inspections in 60 days');
    expect(prompt).toContain('- Summit Roofing booked 14 in 30 days');
    expect(prompt).not.toContain('$2,000');
    for (const k of VIDEO_PART_KEYS) expect(prompt).toContain(`${k}: `);
    expect(prompt.trim().endsWith('Write the video script.')).toBe(true);
  });

  it('keeps all six parts or none, plain, with no long dashes or words to avoid', () => {
    const input = VideoScriptInput.parse({ draft });
    const script = checkedScript(answer(), input, at, 2)!;
    expect(script.parts.map((p) => p.part)).toEqual(VIDEO_PART_KEYS);
    expect(script.parts[0]!.say).toBe('Here’s the who part, said plainly.');
    expect(script).toMatchObject({ at: at.toISOString(), version: 2 });
    // A part missing, or one with a word to avoid: nothing to keep.
    expect(checkedScript({ parts: answer().parts.slice(0, 5) }, input, at, 2)).toBeNull();
    expect(
      checkedScript(
        answer((k) => (k === 'proof' ? 'Guaranteed results for all.' : 'Fine.')),
        input,
        at,
        2,
      ),
    ).toBeNull();
  });

  it('writes one part again, keeping the rest as they stood', () => {
    const before = checkedScript(answer(), VideoScriptInput.parse({ draft }), at, 2)!;
    const input = VideoScriptInput.parse({ draft, mode: 'improve', part: 'call', script: before });
    expect(videoScriptPrompt(input, 'Summit', offer)).toContain('Write the part "call"');
    const after = checkedScript(
      { parts: [{ part: 'call', say: 'A quick call shows it with your numbers.', show: 'You' }] },
      input,
      at,
      2,
    )!;
    expect(after.parts.find((p) => p.part === 'call')!.say).toBe(
      'A quick call shows it with your numbers.',
    );
    expect(after.parts.filter((p) => p.part !== 'call')).toEqual(
      before.parts.filter((p) => p.part !== 'call'),
    );
    expect(checkedScript({ parts: [] }, input, at, 2)).toBeNull();
    expect(VideoScriptInput.safeParse({ draft, mode: 'improve' }).success).toBe(false);
  });

  it('says about how long it runs', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    const script: Pick<VideoScript, 'parts'> = {
      parts: VIDEO_PART_KEYS.map((part) => ({ part, say: words(75), show: 'x' })),
    };
    expect(scriptMinutes(script)).toBe(3);
  });
});

describe('the video’s link and the playbook', () => {
  it('takes an https link with a real host', () => {
    expect(videoLinkProblem('https://www.loom.com/share/abc123')).toBeNull();
    expect(videoLinkProblem('')).toBeNull();
    expect(videoLinkProblem('http://www.loom.com/share/abc123')).toBe(VIDEO_LINK_WORDS);
    expect(videoLinkProblem('loom')).toBe(VIDEO_LINK_WORDS);
  });

  it('keeps the script on the playbook, and an older playbook reads with none', () => {
    const script = checkedScript(answer(), VideoScriptInput.parse({ draft }), at, 2)!;
    const details = { ...blankPlaybook(), videoLink: 'https://youtu.be/abc', videoScript: script };
    expect(PlaybookDetails.parse(details).videoScript).toEqual(script);
    expect(
      PlaybookDetails.safeParse({
        ...details,
        videoScript: { ...script, parts: script.parts.slice(1) },
      }).success,
    ).toBe(false);
    const { videoScript: _, ...before5 } = blankPlaybook();
    expect(upgradePlaybookDetails(before5)).toMatchObject({ videoScript: null });
  });
});
