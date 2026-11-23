# Selling products

HandsFreeOS started out fitting businesses that sell their time. On 2026-11-20 the owner asked for what a business that
sells things needs, with a custom T-shirt order form as the example, and picked **1a 2a 3a 4a 5a 6b**: "make sure these
updates work for already existing products and custom order products, t shirts, mugs, tumblers, keychains, pins, etc".
All of it is in core, for every business (6b), and nothing in it is shirt-only.

| Step | What                                                     | Where it's written up                                       |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------- |
| 1a   | A "How many of each" question and a Custom order starter | "How many of each (orders)" in `docs/forms.md`              |
| 5a   | Customers add their design on a public form              | "Files on a public form (designs and photos)" in `forms.md` |
| 3a   | Sizes, colors and other choices on a product             | Below                                                       |
| 2a   | Orders: a status, a pickup or delivery date, an invoice  | Below                                                       |
| 4a   | Stock counts                                             | Later, once orders work                                     |

## Sizes, colors and other choices (product options)

A product on the price list (Settings → Payments → Products) can come in up to **3 options** (Size, Color, Style…),
each with up to **40 choices**, and each choice with what it adds to the price, or takes off: "T-shirt, $12" with Size
(Youth S −$2, Adult M, Adult 2XL +$2) and Color (Black, White) is one product, not twenty. The editor starts from
**Shirt sizes**, **Cup sizes** or **Colors**, or a blank option. `packages/core/src/money/options.ts` holds every rule
below, browser-safe, so the web, the server, the Assistant and the AI teammate read options the same way.

- **Kept on the product** as `app.products.options` (JSON, migration `20261027032100_product_options`):
  `[{id, name, choices: [{id, label, priceCents}]}]`. Ids are `o_` and `v_` with 8 letters or digits.
  `product.create` and `product.update` take the whole list (`ProductOptions`) and make the ids that are missing. One
  sent without an id takes the id of the one it had by the same name (`withOptionIds`), so the Assistant can send
  options by name and a form's rows made from a choice still find it. An empty list takes them off.
- **Checked before every write** (`optionsProblem`, a `validation` refusal naming the option or choice): no two options
  with one name, no choice twice in an option, and no mix of choices that costs less than nothing, which is checked
  again when only the price changes ("Youth S would cost less than nothing: $1 − $2. Take less off, or raise the
  price.").
- **Picking one means picking one of each.** The estimate and invoice picker shows the choices as chips once a product
  with options is tapped, picks nothing for them, and adds "T-shirt (Adult 2XL, Black)" at $12 + $2
  (`nameWithChoices`, `priceWithChoices`, never below $0). The line keeps that copy for good, as every line does, so
  changing a choice's bump never reprices a document already sent. No line column holds the choices: the name does.
- **A form's "How many of each"** can take a row per choice of one option, each at its own price (`docs/forms.md`, "A
  row per size").
- **The AI teammate** sees "pick one Size: Adult M, Adult 2XL (+$2)" beside each product on its price list (without the
  bumps when it may not say prices) and names the choices in `propose_bill` / `propose_quote` items (`choices`). A
  product with options and no choice named is refused back to it with the choices to pick from (`choicesFromWords`);
  `invoice.create_for_customer` and `estimate.create_for_customer` price the lines again from the price list when an
  owner approves.
- **The Assistant** sets them with `manage_product` `options` (each choice's `priceChangeDollars`), shows them on its
  card, and takes `choices` on a `write_estimate` / `write_invoice` line.
- **Not on the phone yet.** The phone has no product screens and its sync stream names the product columns it sends,
  so it doesn't get options; a document's lines carry the choices in their names.
- **Not per choice yet:** a code (SKU), a picture or stock. Stock (4a) will count by product and choice.

## Orders

What a customer ordered, where it is, and when it goes out: "Order #1001, T-shirt (Adult 2XL) × 5, Mug × 2, $100,
pickup Sat, Dec 5, Making it". The owner takes one by hand on **Money → Orders → New order**, and a sent order form
makes one on its own. The words, steps and totals are in `packages/core/src/money/orders.ts`, browser-safe, so the
web, the server and the Assistant read them the same way.

- **Kept in `app.orders`** (migration `20261027034500_orders`): the customer, a number, a status, `fulfilment`
  (`pickup`, `delivery` or null), `due_on` (a day, no time), the lines, `total_cents`, notes, and where it came from
  (`form_id`, `form_response_id`) and its invoice (`invoice_id`). Those three links clear when the form, its answers
  or the invoice are deleted.
- **Numbered per business from #1001** (`private.order_number()`, under a lock so two at once never share one). The
  number, the business and who made it never change.
- **The lines are a copy,** like an invoice's: `[{productId, choiceIds, name, quantity, unitPriceCents, taxable}]`
  (`OrderLine`), up to 200. A line from the price list keeps the product and its choices' ids, which stock (4a) will
  count by; repricing a product never reprices an order. A product or choice that isn't this business's is dropped
  from the line, and its name and price stay.
- **Steps:** New → Making it → Ready (for pickup, or to deliver) → Picked up or Delivered, or Cancelled
  (`orderStatusWords`, `nextOrderStatus`). Any step can be moved to, back or forward, and a cancelled one reopens.
  "Still to do" is New, Making it and Ready (`open`, a generated column).

**Commands** (`packages/core/src/commands/order.ts`; refusals say the order's number):

- `order.create` (`records.write`): a customer and at least one line. `via: 'staff'` on its `order.created` event.
- `order.update` (`records.write`): the lines, pickup or delivery, the day and the notes. What's on a picked-up,
  delivered or cancelled order can't change (`order_closed`): move it back first.
- `order.set_status` (`records.write`): moving to the step it's on already changes nothing.
- `order.make_invoice` (`money.bill`): a draft invoice titled "Order #1001" with the order's lines, linked to it.
  Refused for a cancelled order (`order_cancelled`), one that's billed already unless that invoice was voided
  (`order_invoiced`), and one that comes to $0 (`order_unpriced`: price the lines first). The order page says when
  the order's total and its invoice's have drifted apart; it never changes the invoice.

**A sent order form makes one** (`orderFromAnswers` in `packages/core/src/forms/order.ts`, run by
`form_response.submit`) when it has a customer and something was ordered on a "How many of each" question that makes
orders (`makesOrder`, on by default; `docs/forms.md`):

- a line per row ordered, named with the product and its choice ("T-shirt (Adult 2XL)") or with what the question is
  about ("T-shirts (Adult M)"), at the price the form showed ($0 when it showed none, for the owner to price);
- the day from the form's first date question, and pickup or delivery from the first choice question whose answer
  says so (`fulfilmentFromWords`: "Pick up", "Delivery", "Ship it"…);
- the form's own invoice, when its payment step made one, linked to it; `via: 'form'` on the event.

**Where it shows:**

- **Money → Orders** (`/money/orders`): newest first, "Still to do" unless another view is picked, searched by
  number ("#1001" or "1001"), customer, what's on it or the notes. Tapping one opens it.
- **The order page:** the steps with one button for the next ("Start making it", "Mark ready", "Mark picked up"),
  back and cancel; its lines, edited in place; pickup or delivery and the day; notes; the invoice, or **Make the
  invoice**; and the form's answers with any designs sent, when a form made it.
- **The calendar:** a "Pickups and deliveries" strip over the days shown, with the open orders due on them.
- **The Assistant:** `read_order_list` and `read_order_get`, and `do_order_create`, `do_order_update`,
  `do_order_set_status` and `do_order_make_invoice` on Confirm cards.

**Rules worth knowing before changing anything:**

- **A customer in the Deleted bin hides their orders** (the policies check `bin_item_id is null`), since binned people
  stay readable for the bin. Deleting them for good deletes their orders; their invoices go to the erased keeper as
  always (`docs/deleting.md`).
- **Merging customers moves their orders** to the one kept (the `people_orders_follow_merge` trigger).
- **Not on the phone yet,** and no customer portal page or public tracking link. An order isn't a job: nothing is
  booked on the calendar for it, and no message goes to the customer when it moves along.
