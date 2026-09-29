/**
 * The kinds of business HandsFreeOS knows, picked when a business signs up and changed in Settings → Workspace. One
 * list for the web, the phone, the API and the Assistant; a workspace stores the id.
 *
 * - Ids are never renamed or reused: workspaces already carry them. Add a kind by adding a line.
 * - `home_services` stays for a business that does several trades, and for every workspace made before the list grew.
 * - `other` is last, for anything the list doesn't have yet.
 * - `words` are what people type instead of the name ("plumber", "AC", "realtor"), so search finds them.
 *
 * Browser-safe.
 */

/** The groups the picker shows the kinds under, in order. */
export const INDUSTRY_GROUP_NAMES = [
  'Home services & trades',
  'Real estate & property',
  'Health & care',
  'Beauty & fitness',
  'Pets',
  'Auto & vehicles',
  'Finance, legal & insurance',
  'Education & childcare',
  'Events, food & hospitality',
  'Rentals & equipment',
  'Professional services',
  'Retail',
  'Community',
  'Something else',
] as const;
export type IndustryGroupName = (typeof INDUSTRY_GROUP_NAMES)[number];

export interface IndustryOption {
  readonly id: string;
  readonly label: string;
  readonly group: IndustryGroupName;
  /** Other names for it, for search. */
  readonly words: readonly string[];
}

const line = <const Id extends string>(
  id: Id,
  label: string,
  group: IndustryGroupName,
  words: readonly string[] = [],
): IndustryOption & { readonly id: Id } => ({ id, label, group, words });

const HOME = 'Home services & trades';
const PROPERTY = 'Real estate & property';
const HEALTH = 'Health & care';
const BEAUTY = 'Beauty & fitness';
const PETS = 'Pets';
const AUTO = 'Auto & vehicles';
const FINANCE = 'Finance, legal & insurance';
const EDUCATION = 'Education & childcare';
const EVENTS = 'Events, food & hospitality';
const RENTALS = 'Rentals & equipment';
const PRO = 'Professional services';
const RETAIL = 'Retail';
const COMMUNITY = 'Community';

export const INDUSTRIES = [
  line('home_services', 'General home services', HOME, ['home improvement', 'contractor']),
  line('hvac', 'HVAC', HOME, [
    'heating',
    'cooling',
    'air conditioning',
    'ac',
    'furnace',
    'heat pump',
    'ac repair',
  ]),
  line('plumbing', 'Plumbing', HOME, ['plumber', 'drains', 'water heater', 'sewer', 'pipes']),
  line('electrical', 'Electrical', HOME, ['electrician', 'wiring', 'panel', 'ev charger']),
  line('roofing', 'Roofing', HOME, ['roofer', 'shingles', 'roof repair']),
  line('handyman', 'Handyman', HOME, ['repairs', 'odd jobs', 'maintenance']),
  line('general_contracting', 'General contracting', HOME, [
    'general contractor',
    'builder',
    'construction',
    'new homes',
  ]),
  line('remodeling', 'Remodeling', HOME, [
    'renovation',
    'kitchen',
    'bathroom',
    'basement',
    'drywall',
    'carpentry',
  ]),
  line('landscaping', 'Landscaping', HOME, ['landscaper', 'hardscape', 'gardening', 'yard']),
  line('lawn_care', 'Lawn care', HOME, ['mowing', 'lawn mowing', 'fertilizing', 'yard']),
  line('tree_service', 'Tree service', HOME, ['arborist', 'tree trimming', 'stump removal']),
  line('irrigation', 'Irrigation & sprinklers', HOME, ['sprinkler', 'drip']),
  line('pest_control', 'Pest control', HOME, [
    'exterminator',
    'termites',
    'bugs',
    'rodents',
    'mosquito',
  ]),
  line('house_cleaning', 'House cleaning', HOME, [
    'maid',
    'cleaners',
    'cleaning service',
    'residential cleaning',
  ]),
  line('commercial_cleaning', 'Commercial cleaning', HOME, [
    'janitorial',
    'office cleaning',
    'cleaning service',
  ]),
  line('carpet_cleaning', 'Carpet & upholstery cleaning', HOME, ['rug', 'steam cleaning']),
  line('window_cleaning', 'Window cleaning', HOME, ['windows', 'gutter cleaning']),
  line('pressure_washing', 'Pressure washing', HOME, ['power washing', 'soft wash']),
  line('painting', 'Painting', HOME, ['painter', 'interior', 'exterior', 'cabinet painting']),
  line('flooring', 'Flooring', HOME, ['carpet', 'tile', 'hardwood', 'vinyl', 'laminate']),
  line('cabinets_countertops', 'Cabinets & countertops', HOME, ['granite', 'quartz', 'kitchen']),
  line('windows_doors', 'Windows & doors', HOME, ['window replacement', 'glass']),
  line('siding_gutters', 'Siding & gutters', HOME, ['exterior', 'gutter guards']),
  line('garage_doors', 'Garage doors', HOME, ['garage door opener']),
  line('fencing_decks', 'Fencing & decks', HOME, ['fence', 'deck', 'patio', 'pergola']),
  line('concrete_masonry', 'Concrete & masonry', HOME, [
    'paving',
    'driveway',
    'brick',
    'stone',
    'asphalt',
  ]),
  line('foundation_waterproofing', 'Foundation & waterproofing', HOME, [
    'basement',
    'crawl space',
    'foundation repair',
  ]),
  line('insulation', 'Insulation', HOME, ['spray foam', 'attic', 'energy']),
  line('solar', 'Solar', HOME, ['solar panels', 'battery', 'energy']),
  line('pool_spa', 'Pool & spa', HOME, ['pool cleaning', 'pool service', 'hot tub']),
  line('appliance_repair', 'Appliance repair', HOME, ['washer', 'dryer', 'refrigerator']),
  line('locksmith', 'Locksmith', HOME, ['locks', 'keys', 'lockout']),
  line('home_security', 'Security & smart home', HOME, ['alarm', 'cameras', 'home automation']),
  line('restoration', 'Water, fire & mold restoration', HOME, [
    'water damage',
    'flood',
    'mold remediation',
  ]),
  line('chimney', 'Chimney & fireplace', HOME, ['chimney sweep']),
  line('septic', 'Septic', HOME, ['septic pumping', 'drain field']),
  line('water_treatment', 'Water treatment', HOME, ['water softener', 'well', 'filtration']),
  line('moving', 'Moving', HOME, ['movers', 'relocation', 'packing']),
  line('junk_removal', 'Junk removal', HOME, ['hauling', 'cleanouts', 'debris']),
  line('snow_removal', 'Snow removal', HOME, ['snow plowing', 'ice']),
  line('home_inspection', 'Home inspection', HOME, ['inspector']),
  line('interior_design', 'Interior design', HOME, ['decorator', 'staging']),

  line('real_estate', 'Real estate agent', PROPERTY, ['realtor', 'broker', 'homes', 'listings']),
  line('property_management', 'Property management', PROPERTY, [
    'landlord',
    'rentals',
    'tenants',
    'hoa',
  ]),
  line('vacation_rentals', 'Vacation rentals', PROPERTY, ['short-term rental', 'airbnb', 'vrbo']),
  line('mortgage', 'Mortgage lending', PROPERTY, ['loan officer', 'lender', 'mortgage broker']),
  line('title_escrow', 'Title & escrow', PROPERTY, ['closing']),

  line('dental', 'Dental', HEALTH, ['dentist', 'orthodontist', 'orthodontics']),
  line('medical_practice', 'Medical practice', HEALTH, ['doctor', 'clinic', 'physician']),
  line('chiropractic', 'Chiropractic', HEALTH, ['chiropractor']),
  line('physical_therapy', 'Physical therapy', HEALTH, ['physiotherapy', 'rehab', 'pt']),
  line('med_spa', 'Med spa', HEALTH, ['aesthetics', 'botox', 'injectables', 'laser']),
  line('mental_health', 'Counseling & therapy', HEALTH, ['therapist', 'counselor', 'psychologist']),
  line('eye_care', 'Eye care', HEALTH, ['optometrist', 'optometry', 'glasses']),
  line('home_care', 'Home care', HEALTH, ['senior care', 'caregiver', 'home health']),
  line('wellness', 'Wellness & nutrition', HEALTH, ['nutritionist', 'dietitian', 'acupuncture']),

  line('hair_salon', 'Hair salon', BEAUTY, ['hairdresser', 'stylist', 'hair']),
  line('barbershop', 'Barbershop', BEAUTY, ['barber']),
  line('nail_salon', 'Nail salon', BEAUTY, ['manicure', 'pedicure', 'nails']),
  line('spa', 'Spa & skin care', BEAUTY, ['day spa', 'facials', 'esthetician']),
  line('lashes_brows', 'Lashes & brows', BEAUTY, ['lash extensions', 'waxing', 'threading']),
  line('massage', 'Massage', BEAUTY, ['massage therapist', 'bodywork']),
  line('tattoo', 'Tattoo & piercing', BEAUTY, ['tattoo artist', 'piercing']),
  line('gym', 'Gym & fitness studio', BEAUTY, ['yoga', 'pilates', 'crossfit', 'fitness']),
  line('personal_training', 'Personal training', BEAUTY, ['trainer', 'coach', 'fitness coach']),
  line('martial_arts', 'Martial arts', BEAUTY, ['karate', 'jiu jitsu', 'taekwondo', 'boxing']),
  line('dance_studio', 'Dance studio', BEAUTY, ['dance', 'ballet']),

  line('pet_grooming', 'Pet grooming', PETS, ['dog grooming', 'groomer', 'mobile grooming']),
  line('veterinary', 'Veterinary', PETS, ['vet', 'animal hospital']),
  line('dog_training', 'Dog training', PETS, ['trainer', 'obedience']),
  line('pet_sitting', 'Pet sitting & dog walking', PETS, ['dog walker', 'pet care']),
  line('pet_boarding', 'Pet boarding & daycare', PETS, ['kennel', 'dog daycare']),

  line('auto_repair', 'Auto repair', AUTO, ['mechanic', 'car repair', 'oil change', 'tires']),
  line('auto_body', 'Auto body & collision', AUTO, ['body shop', 'dent repair', 'paint']),
  line('auto_detailing', 'Auto detailing', AUTO, ['car wash', 'ceramic coating', 'window tint']),
  line('towing', 'Towing', AUTO, ['tow truck', 'roadside']),
  line('auto_glass', 'Auto glass', AUTO, ['windshield']),
  line('car_dealership', 'Car dealership', AUTO, ['used cars', 'auto sales']),
  line('boat_rv', 'Boat & RV service', AUTO, ['marine', 'rv repair']),

  line('accounting', 'Accounting & bookkeeping', FINANCE, [
    'accountant',
    'cpa',
    'bookkeeper',
    'tax prep',
    'taxes',
  ]),
  line('law_firm', 'Law firm', FINANCE, ['attorney', 'lawyer', 'legal']),
  line('insurance', 'Insurance agency', FINANCE, ['insurance agent', 'broker']),
  line('financial_advising', 'Financial advising', FINANCE, [
    'financial advisor',
    'financial planner',
    'wealth',
  ]),

  line('tutoring', 'Tutoring', EDUCATION, ['tutor', 'test prep']),
  line('childcare', 'Childcare', EDUCATION, ['daycare', 'preschool', 'nanny']),
  line('music_lessons', 'Music lessons', EDUCATION, ['music teacher', 'piano', 'guitar']),
  line('driving_school', 'Driving school', EDUCATION, ['driving lessons']),
  line('school_training', 'School & training', EDUCATION, ['classes', 'courses', 'academy']),

  line('restaurant', 'Restaurant', EVENTS, ['cafe', 'bar', 'coffee shop']),
  line('catering', 'Catering', EVENTS, ['caterer', 'private chef']),
  line('food_truck', 'Food truck', EVENTS),
  line('bakery', 'Bakery', EVENTS, ['cakes', 'pastries']),
  line('event_planning', 'Event planning', EVENTS, ['wedding planner', 'events']),
  line('event_venue', 'Event venue', EVENTS, ['wedding venue', 'banquet hall']),
  line('photography', 'Photography & video', EVENTS, ['photographer', 'videographer']),
  line('entertainment', 'DJ & entertainment', EVENTS, ['dj', 'band', 'performer']),
  line('florist', 'Florist', EVENTS, ['flowers']),
  line('lodging', 'Hotel & lodging', EVENTS, ['hotel', 'motel', 'bed and breakfast', 'inn']),
  line('travel', 'Travel agency', EVENTS, ['travel agent', 'tours']),

  line('equipment_rental', 'Equipment rental', RENTALS, ['tool rental', 'heavy equipment']),
  line('party_rentals', 'Party rentals', RENTALS, ['bounce house', 'tents', 'tables and chairs']),
  line('dumpster_rental', 'Dumpster rental', RENTALS, ['roll off', 'waste']),
  line('self_storage', 'Self storage', RENTALS, ['storage units']),
  line('portable_toilets', 'Portable restrooms', RENTALS, ['porta potty', 'portable toilets']),

  line('marketing_agency', 'Marketing agency', PRO, [
    'advertising',
    'seo',
    'digital marketing',
    'web design',
  ]),
  line('consulting', 'Consulting', PRO, ['consultant', 'business coach']),
  line('it_services', 'IT services', PRO, ['computer repair', 'tech support', 'managed services']),
  line('staffing', 'Staffing & recruiting', PRO, ['recruiter', 'temp agency']),
  line('printing_signs', 'Printing & signs', PRO, ['print shop', 'sign shop', 'screen printing']),
  line('courier', 'Courier & delivery', PRO, ['delivery', 'logistics']),
  line('security_services', 'Security services', PRO, ['security guards', 'patrol']),

  line('retail_store', 'Retail store', RETAIL, ['shop', 'boutique', 'store']),
  line('online_store', 'Online store', RETAIL, ['ecommerce', 'e-commerce', 'shopify']),

  line('nonprofit', 'Nonprofit', COMMUNITY, ['charity', 'foundation']),
  line('church', 'Church & ministry', COMMUNITY, ['ministry', 'faith']),

  line('other', 'Other', 'Something else'),
] as const;

export type IndustryId = (typeof INDUSTRIES)[number]['id'];

/** Every id, for the schema that checks one. */
export const INDUSTRY_IDS = INDUSTRIES.map((i) => i.id) as [IndustryId, ...IndustryId[]];

const byId = new Map<string, IndustryOption>(INDUSTRIES.map((i) => [i.id, i]));

/** The kind of business an id names, or undefined for one the list doesn't have. */
export const findIndustry = (id: string | null | undefined): IndustryOption | undefined =>
  id ? byId.get(id) : undefined;

/** Its name, for showing: "Plumbing". An id the list doesn't have is shown as it is. */
export const industryLabel = (id: string | null | undefined): string =>
  findIndustry(id)?.label ?? id ?? '';

/** A trade done at people's homes, where the home, the job and its ZIP code are what a lead is about. */
export const isHomeServices = (id: string | null | undefined): boolean =>
  findIndustry(id)?.group === HOME;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** How well one kind matches the words typed: 0 is no match, higher is better. */
function score(option: IndustryOption, words: readonly string[]): number {
  const label = fold(option.label);
  const others = option.words.map(fold);
  const group = fold(option.group);
  let total = 0;
  for (const w of words) {
    const starts = (s: string) => s.startsWith(w) || s.includes(` ${w}`);
    if (label.startsWith(w)) total += 6;
    else if (starts(label)) total += 5;
    else if (others.some(starts)) total += 3;
    else if (label.includes(w) || others.some((o) => o.includes(w))) total += 2;
    else if (starts(group)) total += 1;
    else return 0;
  }
  return total;
}

/**
 * The kinds that match what someone typed, best first; the whole list, in order, when nothing is typed. Every word
 * has to match the name, another name for it or its group: "dog" finds Pet grooming, Dog training and more,
 * "ac repair" finds HVAC. `Other` is never a match of its own, so a picker can always offer it last.
 */
export function searchIndustries(query: string): IndustryOption[] {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...INDUSTRIES];
  return INDUSTRIES.map((option, order) => ({ option, order, s: score(option, words) }))
    .filter((m) => m.s > 0 && m.option.id !== 'other')
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .map((m) => m.option);
}

/**
 * The kind someone means by a name or an id ("hvac", "Plumbing", "plumber"), for the Assistant, which is told
 * names; undefined when nothing fits well enough to pick one.
 */
export function industryFromText(text: string): IndustryOption | undefined {
  const exact = findIndustry(text.trim());
  if (exact) return exact;
  const folded = fold(text);
  const named = INDUSTRIES.find(
    (i) => fold(i.label) === folded || i.words.some((w) => fold(w) === folded),
  );
  return named ?? searchIndustries(text)[0];
}
