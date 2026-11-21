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
| 2a   | Orders: a status, a pickup or delivery date, an invoice  | Not built yet                                               |
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
