# Relationships and a business's own records

A business keeps track of more than people and companies: a groomer has pets, a repair shop has
vehicles, a landlord has properties and units, a tutor has students. Relationships let a business make
those kinds of records itself and connect any two records — a customer, a company, or one of its own
records — without anyone writing code. Each connection shows on both records' pages.

## Where things are

| What                          | Where                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tables, triggers, RLS         | migrations `20261005000100_relationships_enums.sql` and `20261005000200_relationships.sql`                             |
| Commands                      | `packages/core/src/commands/custom-record.ts`, `relationship.ts`, `custom-field.ts`                                    |
| Reads                         | `packages/core/src/queries/relationship.ts`                                                                            |
| Words, starters, page choices | `packages/core/src/relationships/` (browser-safe) and `packages/core/src/crm/custom-fields.ts`                         |
| A record's page               | `apps/web/src/app/app/w/[workspaceId]/customers/records/[recordId]/`                                                   |
| The Relationships card        | `apps/web/src/components/relationships/`                                                                               |
| Settings                      | **Settings** → **Relationships** and **Settings** → **Fields** (`apps/web/src/components/settings/`)                   |
| Tests                         | `packages/core/test/relationships.test.ts`, `relationship-words.test.ts`, `packages/db/test/relationships-rls.test.ts` |

## The pieces

- **A kind of record** (`app.custom_record_types`): what one is called and more than one ("Pet", "Pets"),
  what its name is called ("Pet's name", "Address"), and a picture. Each kind gets a tab under
  **Contacts**. Owners and admins make them (`fields.manage`).
- **A record** (`app.custom_records`): a name, notes, and its own fields. It has the same timeline,
  notes, tasks, appointments and files as a customer: `activities`, `tasks` and `appointments` each gained
  a `custom_record_id`, and files hang off it like any other record. Its page also shows the
  conversations of the people it's connected to.
- **Fields** (`app.custom_fields`, from 0076): the same table now serves each kind of record, through
  `record_type_id`. **Settings** → **Fields** adds, renames, orders and retires them for customers,
  companies and each kind. A value is checked by type the same way everywhere (`checkCustomValue`).
- **A relationship type** (`app.relationship_types`): two ends, each a customer, a company or one kind of
  record, each with a label that says what it is to the other ("Owner" and "Pet"). A mutual type has one
  label and no direction ("Spouse").
- **A pair** (`app.relationships`): one row joins two records under one type, with an optional note
  ("Primary driver"). The same row is read from both sides, so a customer lists their pets and a pet
  lists its owners.

## Rules worth knowing before changing anything

**Many to many unless somebody says otherwise.** Every starter and every new type begins many to many.
"One" is only set when a business picks it for a side, and the editor spells out what that means in both
directions ("Each pet can have one owner.").

**The database enforces how many.** `private.check_relationship` runs before every insert: it refuses a
record on the wrong end, a record paired with itself, and a pair that would give a "one" side a second
partner. It takes an advisory lock per record, so two people adding an owner to the same pet at the same
moment can't both succeed. Changing a type from "many" to "one" is refused while any record already has
more than one (`private.check_relationship_cardinality`).

**A mutual pair is stored one way.** The trigger puts the lower id on end A, so "Ann ↔ Bo" and
"Bo ↔ Ann" are the same row and the unique key catches the second.

**What an end is never changes; what it's called may.** A type's ends and whether it's mutual are
immutable once made. Labels and how many can change.

**Archiving hides, deleting is only for pairs.** Archiving a kind archives the relationship types on it
at the same moment, and restoring the kind brings back exactly those. Archiving a record keeps its
history, tasks, files and pairs. Removing a pair deletes only that row, and both timelines say who did it.
Retiring a field takes its value off every record, as it always has.

**Both timelines hear about it.** Adding or removing a pair writes a `related` or `unrelated` entry on
both records, in words that read the same from either side.

**Permissions follow the rest of the CRM.** Making kinds, types and fields needs `fields.manage` (owners
and admins). Adding records, filling in fields and connecting records needs `records.write`; archiving a
record needs `records.archive`. Row-level security checks the same thing in the database.

## Not yet

- The phone app doesn't show relationships or a business's own records yet. The words and choices it
  will need are already browser-safe in `packages/core/src/relationships/`.
- Imports don't create records of a business's own kinds yet.
