/**
 * Starters for Settings → Relationships: the kinds of records and the relationships most businesses ask for, ready
 * to make in one press and change afterwards like anything else. Nothing here is made for a business until
 * somebody picks it: a plumber has no use for pets.
 *
 * A kind's starter makes the kind, its first fields and the relationship that ties it to customers
 * (`custom_record_type.create` with `fields` and `link`), in one command. A relationship's starter makes one type
 * between people or companies (`relationship_type.create`).
 */
import type { CustomFieldType } from '../crm/custom-fields';
import type { RecordIcon, RelationshipCardinality } from './words';

export interface StarterField {
  readonly label: string;
  readonly type: CustomFieldType;
  /** Choice and multi-choice only. */
  readonly options?: readonly string[];
}

export interface RecordKindStarter {
  /** Stable, for tests and the picker's keys. */
  readonly key: string;
  readonly singular: string;
  readonly plural: string;
  readonly nameLabel: string;
  readonly icon: RecordIcon;
  /** Who it's for, under its name in the picker. */
  readonly hint: string;
  readonly fields: readonly StarterField[];
  /** The relationship it's made with: a customer (or company) on end A, one of these on end B. */
  readonly link: {
    readonly end: 'person' | 'company';
    /** What the customer is to one of these ("Owner"). */
    readonly label: string;
    /** What one of these is to the customer; the kind's own name when left out. */
    readonly recordLabel?: string;
    readonly cardinality: RelationshipCardinality;
  };
}

/** Pets, vehicles, properties, units, students and equipment: every one of them many-to-many to start with. */
export const RECORD_KIND_STARTERS: readonly RecordKindStarter[] = [
  {
    key: 'pets',
    singular: 'Pet',
    plural: 'Pets',
    nameLabel: 'Pet’s name',
    icon: 'paw',
    hint: 'Groomers, vets, sitters and trainers',
    fields: [
      { label: 'Species', type: 'choice', options: ['Dog', 'Cat', 'Other'] },
      { label: 'Breed', type: 'text' },
      { label: 'Birthday', type: 'date' },
      { label: 'Weight (lb)', type: 'number' },
    ],
    link: { end: 'person', label: 'Owner', cardinality: 'many_to_many' },
  },
  {
    key: 'vehicles',
    singular: 'Vehicle',
    plural: 'Vehicles',
    nameLabel: 'Year, make and model',
    icon: 'car',
    hint: 'Repair shops, detailers and tire shops',
    fields: [
      { label: 'License plate', type: 'text' },
      { label: 'VIN', type: 'text' },
      { label: 'Mileage', type: 'number' },
      { label: 'Color', type: 'text' },
    ],
    link: { end: 'person', label: 'Owner', cardinality: 'many_to_many' },
  },
  {
    key: 'properties',
    singular: 'Property',
    plural: 'Properties',
    nameLabel: 'Address',
    icon: 'home',
    hint: 'Home services, property managers and cleaners',
    fields: [
      { label: 'Property type', type: 'choice', options: ['House', 'Apartment', 'Commercial'] },
      { label: 'Square feet', type: 'number' },
      { label: 'Year built', type: 'number' },
      { label: 'Gate or lockbox code', type: 'text' },
    ],
    link: { end: 'person', label: 'Owner', cardinality: 'many_to_many' },
  },
  {
    key: 'units',
    singular: 'Unit',
    plural: 'Units',
    nameLabel: 'Unit',
    icon: 'key',
    hint: 'Landlords and property managers',
    fields: [
      { label: 'Bedrooms', type: 'number' },
      { label: 'Rent', type: 'money' },
      { label: 'Lease ends', type: 'date' },
    ],
    link: { end: 'person', label: 'Tenant', cardinality: 'many_to_many' },
  },
  {
    key: 'students',
    singular: 'Student',
    plural: 'Students',
    nameLabel: 'Student’s name',
    icon: 'student',
    hint: 'Tutors, schools, camps and coaches',
    fields: [
      { label: 'Grade', type: 'text' },
      { label: 'Birthday', type: 'date' },
      { label: 'Allergies or medical notes', type: 'long_text' },
    ],
    link: { end: 'person', label: 'Parent or guardian', cardinality: 'many_to_many' },
  },
  {
    key: 'equipment',
    singular: 'Equipment',
    plural: 'Equipment',
    nameLabel: 'Name',
    icon: 'wrench',
    hint: 'HVAC, appliance and pool service',
    fields: [
      { label: 'Brand', type: 'text' },
      { label: 'Model', type: 'text' },
      { label: 'Serial number', type: 'text' },
      { label: 'Installed on', type: 'date' },
    ],
    link: { end: 'person', label: 'Owner', recordLabel: 'Equipment', cardinality: 'many_to_many' },
  },
];

export interface RelationshipStarter {
  readonly key: string;
  /** Its name in the picker. */
  readonly name: string;
  readonly hint: string;
  readonly a: { readonly end: 'person' | 'company'; readonly label: string };
  readonly b: { readonly end: 'person' | 'company'; readonly label: string };
  readonly cardinality: RelationshipCardinality;
  readonly mutual: boolean;
}

/** Between people, and between people and businesses. */
export const RELATIONSHIP_STARTERS: readonly RelationshipStarter[] = [
  {
    key: 'spouse',
    name: 'Spouse or partner',
    hint: 'One each, the same both ways',
    a: { end: 'person', label: 'Spouse' },
    b: { end: 'person', label: 'Spouse' },
    cardinality: 'one_to_one',
    mutual: true,
  },
  {
    key: 'family',
    name: 'Family member',
    hint: 'Any number, the same both ways',
    a: { end: 'person', label: 'Family member' },
    b: { end: 'person', label: 'Family member' },
    cardinality: 'many_to_many',
    mutual: true,
  },
  {
    key: 'parent',
    name: 'Parent and child',
    hint: 'A child can have more than one parent or guardian',
    a: { end: 'person', label: 'Parent' },
    b: { end: 'person', label: 'Child' },
    cardinality: 'many_to_many',
    mutual: false,
  },
  {
    key: 'emergency',
    name: 'Emergency contact',
    hint: 'Who to call, for someone who may have several',
    a: { end: 'person', label: 'Emergency contact' },
    b: { end: 'person', label: 'Emergency contact for' },
    cardinality: 'many_to_many',
    mutual: false,
  },
  {
    key: 'works_at',
    name: 'Works at',
    hint: 'People connected to more than one business or location',
    a: { end: 'person', label: 'Employee' },
    b: { end: 'company', label: 'Employer' },
    cardinality: 'many_to_many',
    mutual: false,
  },
  {
    key: 'location',
    name: 'Business location',
    hint: 'A business’s branches, each with one main business',
    a: { end: 'company', label: 'Location' },
    b: { end: 'company', label: 'Main business' },
    cardinality: 'many_to_one',
    mutual: false,
  },
];
