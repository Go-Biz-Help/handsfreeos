import { describe, expect, it } from 'vitest';
import { countFields, pageFormOutline, formsOnPage, googleForm } from '../../src/forms/page-forms';

const ORDER_PAGE = `<html><head><title>Sherri’s Crafts</title><script>var x = "<form><input name=a></form>";</script></head><body>
<nav><form role="search" action="/search"><input type="search" name="s"><button>Go</button></form></nav>
<h2>T-shirt order form</h2>
<form action="/send" class="gform">
 <div class="gform_page" id="p1">
  <label for="n">Your name <span>*</span></label><input id="n" name="input_1" type="text" required>
  <label>Email</label><input type="email" name="email" placeholder="you@example.com">
  <label>Color</label>
  <select name="color" required>
    <option value="">-- Choose --</option><option>Black</option><option>White &amp; Gray</option>
    <optgroup label="Neon"><option>Pink</option></optgroup>
  </select>
  <div class="gfield conditional" style="display:none"><label>Pickup date</label><input type="date" name="d"></div>
  <fieldset><legend>Pickup or delivery</legend>
    <label><input type="radio" name="pd" value="p"> Pickup</label>
    <label><input type="radio" name="pd" value="d"> Delivery</label>
  </fieldset>
  <input type="hidden" name="token" value="abc">
 </div>
 <div class="gform_page" style="display:none">
  <label>Special instructions</label><textarea name="notes">type here</textarea>
  <label><input type="checkbox" name="ok" required> I agree</label>
  <div class="gform_validation_container" style="display:none"><label>Leave this empty</label><input name="hp"><div>nested</div></div>
  <button type="submit">Send <b>order</b></button>
 </div>
</form>
<form action="/login"><input name="user"><input type="password" name="pw"></form>
</body></html>`;

describe('the forms on a web page', () => {
  it('reads each form, leaving out a site search and a sign-in', () => {
    const forms = formsOnPage(ORDER_PAGE, 'https://sherris.test/order');
    expect(forms).toHaveLength(1);
    const [form] = forms;
    expect(form!.number).toBe(1);
    expect(form!.title).toBe('T-shirt order form');
    // Name, email, color, pickup date, pickup or delivery (one), notes, I agree. The hidden token and the robot trap
    // aren't boxes anybody fills in.
    expect(form!.fields).toBe(8);
    expect(form!.url).toBe('https://sherris.test/order');
  });

  it('keeps every dropdown choice, and marks steps and parts that show later', () => {
    const outline = formsOnPage(ORDER_PAGE, 'https://sherris.test/order')[0]!.outline;
    expect(outline).toContain(
      '[dropdown, name "color", required: Black | White & Gray | Neon: Pink]',
    );
    expect(outline).not.toContain('Choose');
    expect(outline).toContain('--- Step 1 ---');
    expect(outline).toContain('--- Step 2 (shows after Next is pressed) ---');
    expect(outline).toContain(
      '{Shows only when an earlier answer fits:\nPickup date [date box, name "d"]\n}',
    );
    expect(outline).toContain('(pick one) Pickup');
    expect(outline).toContain('Special instructions [long answer box, name "notes"]');
    expect(outline).not.toContain('type here');
    expect(outline).toContain('[tick box (required)] I agree');
    expect(outline).toContain('[button: Send order]');
    expect(outline).not.toMatch(/Leave this empty|nested|token/);
    // A field named by the form tool ("input_1") says nothing worth reading.
    expect(outline).toContain('Your name * [short answer box, required]');
  });

  it('reads boxes laid out without a form tag as one form, named by the page', () => {
    const html = `<html><head><title>Get a quote | Acme</title></head><body><div class="builder">
      <label>Name</label><input type="text"><label>Phone</label><input type="tel" required>
      <label>Service</label><select><option>Lawn</option><option>Snow</option></select></div></body></html>`;
    const [form] = formsOnPage(html, 'https://acme.test');
    expect(form).toMatchObject({ number: 1, title: 'Get a quote | Acme', fields: 3 });
    expect(form!.outline).toContain('Phone [phone box, required]');
    expect(form!.summary).toContain('Name');
  });

  it('finds nothing on a page whose form is drawn with code after it loads', () => {
    const html = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    expect(formsOnPage(html, 'https://typeform.test/to/abc')).toEqual([]);
  });

  it('numbers forms from where the page left off, for the forms framed on it', () => {
    const html = `<form><label>A</label><input name="a"><label>B</label><input name="b"></form>
      <form><label>Email</label><input type="email" name="e"></form>`;
    expect(formsOnPage(html, 'https://f.test', 3).map((f) => f.number)).toEqual([3, 4]);
  });

  it('counts radio buttons sharing a name once', () => {
    expect(
      countFields(
        '<input type="radio" name="x"><input type="radio" name="x"><input type="radio" name="y"><input type="submit">',
      ),
    ).toBe(2);
  });

  it('says a list that takes more than one choice is one', () => {
    expect(
      pageFormOutline(
        '<select name="extras" multiple><option>Edging</option><option>Mulch</option></select>',
      ),
    ).toBe('[list to pick any of, name "extras": Edging | Mulch]');
  });
});

describe('a Google Form', () => {
  const data = [
    null,
    [
      'Tell us what you need.',
      [
        [1, 'Your name', null, 0, [[11, null, 1]]],
        [2, 'Service', 'Pick the closest', 3, [[12, [['Lawn'], ['Snow']], 1]]],
        [3, 'Extras', null, 4, [[13, [['Edging'], ['Mulch']], 0]]],
        [4, 'More about the job', null, 8],
        [5, 'Anything else?', null, 1, [[15, null, 0]]],
      ],
      null,
      null,
      null,
      null,
      null,
      null,
      'Quote request',
    ],
    '/forms',
    'Untitled form',
  ];
  const html = `<html><body><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(data)};</script>
    <form><input name="entry.11"></form></body></html>`;

  it('is read from its data, sections as steps', () => {
    const form = googleForm(html, 'https://docs.google.com/forms/d/e/x/viewform');
    expect(form).toMatchObject({ number: 1, title: 'Quote request', fields: 4 });
    expect(form!.outline.split('\n')).toEqual([
      'Quote request',
      'Tell us what you need.',
      'Your name [short answer box, required]',
      'Service [dropdown, required: Lawn | Snow] (Pick the closest)',
      'Extras [pick any (checkboxes): Edging | Mulch]',
      '--- Step 2: More about the job ---',
      'Anything else? [long answer box]',
    ]);
    expect(formsOnPage(html, 'https://docs.google.com/forms/d/e/x/viewform')).toHaveLength(1);
  });

  it('falls back to the HTML when the data can’t be read', () => {
    expect(
      googleForm('<script>var FB_PUBLIC_LOAD_DATA_ = [nope];</script>', 'https://g.test'),
    ).toBeNull();
  });
});
