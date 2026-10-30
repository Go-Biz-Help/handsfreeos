/**
 * Answering the requests the person got (docs/outreach.md, decision 136, from 0.118.0), on hand-written pages of
 * made-up people: LinkedIn's Accept and Ignore in the top card of the profile of whoever sent the invitation
 * (src/networks/linkedin/auto.ts), and Alignable's Accept and Ignore on that business's row of My Network's Requests
 * (src/networks/alignable/answer.ts), found by Alignable's id for it. Nothing else is pressed.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { answerOnRequests, requestRowFor } from '../src/networks/alignable/answer';
import { answerInvitation } from '../src/networks/linkedin/auto';
import { readPage } from '../src/networks/linkedin/page';
import { boxEverything, load } from './load';

const LI = 'https://www.linkedin.com';
const DANA = `${LI}/in/dana-reyes-4b2a1c/`;
const AL = 'https://www.alignable.com';
const REQUESTS = `${AL}/biz/my_network/connection_requests`;

const asWrittenAndBoxed = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

/**
 * Dana's profile once she's invited the person, as LinkedIn behaves: Accept makes them connected (1st, Message stays),
 * Ignore puts Connect back. `ignoreUnderMore` keeps Ignore in the More menu, and `sure` has LinkedIn ask first.
 */
function invited(boxed: boolean, options: { ignoreUnderMore?: boolean; sure?: boolean } = {}) {
  const doc = load('linkedin-profile.html', DANA);
  const pressed: string[] = [];
  const connect = doc.querySelector('[aria-label="Invite Dana Reyes to connect"]')!;
  connect.insertAdjacentHTML(
    'beforebegin',
    '<button aria-label="Accept Dana Reyes’s invitation"><span>Accept</span></button>' +
      (options.ignoreUnderMore
        ? ''
        : '<button aria-label="Ignore Dana Reyes’s invitation"><span>Ignore</span></button>'),
  );
  const buttons = [...doc.querySelectorAll('main [aria-label$="’s invitation"]')];
  connect.remove();
  if (options.ignoreUnderMore) {
    const more = doc.querySelector('[aria-label="More actions"]');
    if (more) more.remove();
    buttons[0]!.insertAdjacentHTML(
      'afterend',
      '<button aria-label="More actions"><span>More</span></button>' +
        '<div aria-hidden="true"><button aria-label="Ignore Dana Reyes’s invitation"><span>Ignore</span></button></div>',
    );
  }
  if (boxed) boxEverything(doc);
  const gone = () => {
    for (const button of doc.querySelectorAll('main [aria-label$="’s invitation"]'))
      button.remove();
  };
  doc
    .querySelector('[aria-label="Accept Dana Reyes’s invitation"]')!
    .addEventListener('click', () => {
      pressed.push('Accept');
      gone();
      for (const degree of doc.querySelectorAll('main span[aria-hidden="true"]'))
        if (degree.textContent === '· 2nd') degree.textContent = '· 1st';
    });
  const more = doc.querySelector('[aria-label="More actions"]');
  more?.addEventListener('click', () => {
    pressed.push('More');
    for (const menu of doc.querySelectorAll('main [aria-hidden="true"]'))
      if (menu.querySelector('[aria-label="Ignore Dana Reyes’s invitation"]'))
        menu.removeAttribute('aria-hidden');
  });
  const ignored = () => {
    gone();
    doc
      .querySelector('[aria-label="Message Dana Reyes"]')!
      .insertAdjacentHTML(
        'beforebegin',
        '<button aria-label="Invite Dana Reyes to connect"><span>Connect</span></button>',
      );
  };
  doc
    .querySelector('[aria-label="Ignore Dana Reyes’s invitation"]')!
    .addEventListener('click', () => {
      pressed.push('Ignore');
      if (!options.sure) return ignored();
      doc.body.insertAdjacentHTML(
        'beforeend',
        '<div role="dialog"><p>Ignore this invitation?</p><button><span>Cancel</span></button><button id="sure"><span>Ignore</span></button></div>',
      );
      doc.querySelector('#sure')!.addEventListener('click', () => {
        pressed.push('Ignore in the box');
        doc.querySelector('[role="dialog"]')!.remove();
        ignored();
      });
    });
  return { doc, pressed };
}

describe('answering an invitation on LinkedIn', () => {
  it.each(asWrittenAndBoxed)('accepts it in their profile’s top card, %s', async (_, boxed) => {
    const { doc, pressed } = invited(boxed);
    expect(readPage(doc, DANA).profile?.connection).toBe('received');
    expect(await answerInvitation(doc, DANA, 'confirm')).toBe('done');
    expect(pressed).toEqual(['Accept']);
    expect(readPage(doc, DANA).profile?.connection).toBe('connected');
    // Connected now: nothing more to accept, nor to ignore.
    expect(await answerInvitation(doc, DANA, 'confirm')).toBe('already');
    expect(await answerInvitation(doc, DANA, 'delete')).toBe('none');
  });

  it.each(asWrittenAndBoxed)('ignores it, and then nothing is waiting, %s', async (_, boxed) => {
    const { doc, pressed } = invited(boxed);
    expect(await answerInvitation(doc, DANA, 'delete')).toBe('done');
    expect(pressed).toEqual(['Ignore']);
    expect(readPage(doc, DANA).profile?.connection).toBe('not_connected');
    expect(await answerInvitation(doc, DANA, 'delete')).toBe('already');
    expect(await answerInvitation(doc, DANA, 'confirm')).toBe('none');
  });

  it('finds Ignore under More, and presses the box’s own Ignore where LinkedIn asks', async () => {
    const { doc, pressed } = invited(false, { ignoreUnderMore: true, sure: true });
    expect(await answerInvitation(doc, DANA, 'delete')).toBe('done');
    expect(pressed).toEqual(['More', 'Ignore', 'Ignore in the box']);
  });

  it('presses nothing on a profile with no invitation of theirs', async () => {
    const doc = load('linkedin-profile.html', DANA);
    let pressed = false;
    for (const button of doc.querySelectorAll('main button'))
      button.addEventListener('click', () => (pressed = true));
    expect(await answerInvitation(doc, DANA, 'confirm')).toBe('none');
    expect(await answerInvitation(doc, DANA, 'delete')).toBe('already');
    expect(pressed).toBe(false);
  });
});

/** My Network's Requests with two requests, as Alignable behaves: a row's Accept or Ignore takes it off the table. */
function requests(url = REQUESTS) {
  const doc = new JSDOM(
    `<!doctype html><html><body><main>
      <div data-testid="requests-360-table"><table><tbody>
        <tr id="sam"><td><a href="/austin-tx/best-bakery?user=6&business_id=43"><span>Sam Lee</span></a><div>Best Bakery</div></td>
          <td><p>We both serve homeowners in Austin.</p></td>
          <td><button>Accept</button><button>Ignore</button></td></tr>
        <tr id="avery"><td><a href="/columbus-oh/avery-insurance"><span>Avery Lane</span><span>Avery Insurance</span></a></td>
          <td>We serve the same homeowners</td><td><button>Accept</button><button>Ignore</button></td></tr>
      </tbody></table></div>
    </main></body></html>`,
    { url },
  ).window.document;
  const pressed: string[] = [];
  for (const row of doc.querySelectorAll('tbody tr'))
    for (const button of row.querySelectorAll('button'))
      button.addEventListener('click', () => {
        pressed.push(`${button.textContent} ${row.id}`);
        row.remove();
      });
  return { doc, pressed };
}

const sam = { id: '43', username: 'austin-tx-best-bakery', url: `${AL}/austin-tx/best-bakery` };
const avery = {
  id: null,
  username: 'columbus-oh-avery-insurance',
  url: `${AL}/columbus-oh/avery-insurance`,
};

describe('answering a connection request on Alignable', () => {
  it('accepts it on their row of Requests, by Alignable’s id for them', async () => {
    const { doc, pressed } = requests();
    expect(await answerOnRequests(doc, REQUESTS, sam, 'confirm')).toBe('done');
    expect(pressed).toEqual(['Accept sam']);
    expect(requestRowFor(doc, REQUESTS, avery)).not.toBeNull();
  });

  it('declines it with the row’s Ignore, by its address in its town where the row carries no id', async () => {
    const { doc, pressed } = requests();
    expect(await answerOnRequests(doc, REQUESTS, avery, 'delete')).toBe('done');
    expect(pressed).toEqual(['Ignore avery']);
  });

  it('takes a link to another page as answered at once, and waits on a script link for the row to go', async () => {
    const { doc, pressed } = requests();
    const [samRow, averyRow] = [...doc.querySelectorAll('tbody tr')];
    samRow!
      .querySelector('button')!
      .insertAdjacentHTML('beforebegin', '<a href="/biz/my_network/accept?id=43">Accept</a>');
    samRow!.querySelector('button')!.remove();
    averyRow!
      .querySelectorAll('button')[1]!
      .insertAdjacentHTML('beforebegin', '<a href="javascript:void(0)">Ignore</a>');
    averyRow!.querySelectorAll('button')[1]!.remove();
    // Alignable's script answers it a moment later.
    averyRow!.querySelector('a[href^="javascript"]')!.addEventListener('click', () => {
      pressed.push('Ignore avery');
      setTimeout(() => averyRow!.remove(), 1_000);
    });
    expect(await answerOnRequests(doc, REQUESTS, sam, 'confirm')).toBe('done');
    expect(requestRowFor(doc, REQUESTS, sam)).not.toBeNull();
    expect(await answerOnRequests(doc, REQUESTS, avery, 'delete')).toBe('done');
    expect(requestRowFor(doc, REQUESTS, avery)).toBeNull();
    expect(pressed).toEqual(['Ignore avery']);
  });

  it('presses nothing for someone with no row, or anywhere but Requests', async () => {
    const { doc, pressed } = requests();
    const other = { id: '99', username: 'austin-tx-other', url: `${AL}/austin-tx/other` };
    expect(await answerOnRequests(doc, REQUESTS, other, 'confirm')).toBe('none');
    const elsewhere = requests(`${AL}/biz/my_network`);
    expect(await answerOnRequests(elsewhere.doc, `${AL}/biz/my_network`, sam, 'confirm')).toBe(
      'none',
    );
    expect([...pressed, ...elsewhere.pressed]).toEqual([]);
  });
});
