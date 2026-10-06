/**
 * The add-ons HandsFreeOS plans to build: the owner's catalogue (2026-09-28), cleaned of duplicates and of what core
 * already does. Every one is `planned`: a manifest with no code, never installable and never offered, only listed.
 * Businesses vote on them on the Add-ons page, and each week the one with the most votes becomes Coming soon
 * (docs/addon-architecture.md, "Voting on what's next").
 *
 * Each is one line: its id (never reused, like any add-on's), its name and category, the groups the planned list
 * filters by, one line on what it does, and, where core already does part of it, what core does and what it adds.
 * When one is built, `pnpm addon:new <id>` starts it under the same id and its real manifest takes this one's place
 * (`ADDON_CATALOG` in ./catalog.ts), so its votes and its place in Coming soon carry over.
 */
import type { AddonCategory, AddonManifest } from './manifest';

/** The lines of work the industry add-ons are grouped by on the planned list. */
export const INDUSTRY_GROUPS = [
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
] as const;

interface PlannedEntry {
  readonly id: string;
  readonly name: string;
  readonly category: AddonCategory;
  /** What the planned list filters it by: a line of work for an industry add-on, else the areas it belongs to. */
  readonly groups: readonly string[];
  /** One line, 160 characters at most. */
  readonly summary: string;
  /** The whole of it, when the summary had to be shortened. */
  readonly description?: string;
  /** What HandsFreeOS already does of this, and what the add-on would add. */
  readonly overlap?: string;
}

const ENTRIES: readonly PlannedEntry[] = [
  {
    id: 'realestate',
    name: 'Real Estate Agent',
    category: 'industry',
    groups: ['Real estate & property'],
    summary:
      'MLS/property data, showing management, lockbox details, comparative property reports, listing activity, and buyer/seller-specific workflows.',
  },
  {
    id: 'construction',
    name: 'Construction',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Projects, job sites, subcontractors, plans, change orders, inspections, permits, material selections, and project phases.',
  },
  {
    id: 'roofing',
    name: 'Roofing',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Roof measurements, inspection photos, storm-damage documentation, insurance claim data, material selections, and installation records.',
  },
  {
    id: 'hvac',
    name: 'HVAC',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Equipment records tied to properties, model/serial numbers, warranty data, filter sizes, maintenance history, and system lifecycle tracking.',
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Property fixture/equipment records, water-heater details, recurring maintenance information, and property-specific plumbing history.',
  },
  {
    id: 'electrical',
    name: 'Electrical',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Panels, circuits, equipment, inspection findings, property electrical history, and installed-system documentation.',
  },
  {
    id: 'pestcontrol',
    name: 'Pest Control',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Property pest history, treatment maps, chemical/application records, infestation severity, bait stations, and regulatory service documentation.',
  },
  {
    id: 'landscaping',
    name: 'Lawn & Landscaping',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Property maps, service zones, plant/material records, irrigation systems, treatment schedules, and seasonal property plans.',
  },
  {
    id: 'poolservice',
    name: 'Pool Service',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Pool/equipment profiles, chemical readings, equipment history, service measurements, and recurring water-quality records.',
  },
  {
    id: 'cleaning',
    name: 'Cleaning Company',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Property-specific room/service checklists, access instructions, inspection photos, consumable preferences, and recurring cleaning configurations.',
  },
  {
    id: 'moving',
    name: 'Moving Company',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Inventory lists, room-by-room items, cubic-foot estimates, origin/destination details, crew requirements, and move-specific logistics.',
  },
  {
    id: 'solar',
    name: 'Solar',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Property energy data, system designs, panels/inverters, utility information, permitting, interconnection, and installation milestones.',
  },
  {
    id: 'securityco',
    name: 'Security Company',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Customer sites, alarm systems, sensors, access points, monitoring configurations, inspection history, and installed-device records.',
  },
  {
    id: 'homeinspector',
    name: 'Home Inspector',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'Property inspections with room/system findings, annotated photos, severity classifications, reports, and property-condition histories.',
  },
  {
    id: 'fieldinventory',
    name: 'Field Service Inventory',
    category: 'industry',
    groups: ['Home services & trades'],
    summary:
      'For trades that carry parts, tracks truck-specific inventory, serialized equipment, replenishment, and parts used on each job.',
  },
  {
    id: 'propertymgmt',
    name: 'Property Management',
    category: 'industry',
    groups: ['Real estate & property'],
    summary:
      'Units, tenants, leases, maintenance requests, rent status, inspections, and property-level records for single or multi-property operators.',
  },
  {
    id: 'reinvestor',
    name: 'Real Estate Investor',
    category: 'industry',
    groups: ['Real estate & property'],
    summary:
      'Properties as first-class records with ownership, liens, comps, rehab estimates, offers, acquisition analysis, and disposition tracking.',
  },
  {
    id: 'titleescrow',
    name: 'Title & Escrow',
    category: 'industry',
    groups: ['Real estate & property'],
    summary:
      'Properties, buyers/sellers, title requirements, escrow milestones, liens, closing documents, and transaction-party relationships.',
  },
  {
    id: 'hoa',
    name: 'HOA',
    category: 'industry',
    groups: ['Real estate & property'],
    summary:
      'Properties, homeowners, violations with photo inspections and fix-by dates, architectural requests, amenity access, board items, and owner histories.',
    description:
      'Properties, homeowners, violations with photo inspections and fix-by dates, architectural requests, amenity access, board items, and property-to-owner histories.',
  },
  {
    id: 'selfstorage',
    name: 'Self-Storage',
    category: 'industry',
    groups: ['Real estate & property'],
    summary:
      'Storage units, occupancy, gate/access credentials, unit sizes, tenant-unit relationships, and facility-specific records.',
  },
  {
    id: 'dental',
    name: 'Dental',
    category: 'industry',
    groups: ['Health & care'],
    summary:
      'Patient treatment plans, tooth-specific records, procedure history, insurance information, and dental recall scheduling logic.',
  },
  {
    id: 'medspa',
    name: 'Med Spa',
    category: 'industry',
    groups: ['Health & care'],
    summary:
      'Treatment areas, before/after photos, treatment history, contraindication forms, package balances, and procedure-specific documentation.',
  },
  {
    id: 'chiropractic',
    name: 'Chiropractic',
    category: 'industry',
    groups: ['Health & care'],
    summary:
      'Patient care plans, visit progression, injury/body-area tracking, treatment notes, and prescribed visit-frequency management.',
  },
  {
    id: 'homehealth',
    name: 'Home Healthcare',
    category: 'industry',
    groups: ['Health & care'],
    summary:
      'Patient care plans, caregiver assignments, visit documentation, medication/task verification, and family-member access or updates.',
  },
  {
    id: 'seniorliving',
    name: 'Senior Living',
    category: 'industry',
    groups: ['Health & care'],
    summary:
      'Resident profiles, rooms, family contacts, care requirements, activities, incidents, and resident-specific service records.',
  },
  {
    id: 'salon',
    name: 'Salon & Barbershop',
    category: 'industry',
    groups: ['Beauty & fitness'],
    summary:
      'Client hair/service history, color formulas, style photos, preferred products, and stylist-specific consultation records.',
  },
  {
    id: 'tattoo',
    name: 'Tattoo Studio',
    category: 'industry',
    groups: ['Beauty & fitness'],
    summary:
      'Artist portfolios, design approvals, placement references, session progress photos, consent records, and multi-session tattoo projects.',
  },
  {
    id: 'fitness',
    name: 'Gym & Fitness',
    category: 'industry',
    groups: ['Beauty & fitness'],
    summary:
      'Member workout programs, measurements, fitness assessments, trainer assignments, progress photos, and personal-record tracking.',
  },
  {
    id: 'martialarts',
    name: 'Martial Arts',
    category: 'industry',
    groups: ['Beauty & fitness'],
    summary:
      'Belt/rank progression, testing eligibility, attendance requirements, competition records, and student skill milestones.',
  },
  {
    id: 'veterinary',
    name: 'Veterinary',
    category: 'industry',
    groups: ['Pets'],
    summary:
      'Creates pets as separate records connected to owners with vaccines, medical history, medications, breed data, and future-care requirements.',
  },
  {
    id: 'petgrooming',
    name: 'Pet Grooming',
    category: 'industry',
    groups: ['Pets'],
    summary:
      'Pet profiles with breed, coat condition, grooming preferences, behavior notes, allergies, and grooming history.',
  },
  {
    id: 'autorepair',
    name: 'Auto Repair',
    category: 'industry',
    groups: ['Auto & vehicles'],
    summary:
      'Tracks multiple vehicles per customer with VIN, mileage, service history, recommended repairs, parts, and vehicle-specific maintenance records.',
  },
  {
    id: 'autodetailing',
    name: 'Auto Detailing',
    category: 'industry',
    groups: ['Auto & vehicles'],
    summary:
      'Vehicle profiles, service-condition photos, coating/warranty history, recurring detail schedules, and vehicle-specific service packages.',
  },
  {
    id: 'cardealer',
    name: 'Car Dealership',
    category: 'industry',
    groups: ['Auto & vehicles'],
    summary:
      'Vehicle inventory, VIN-level records, trade-ins, test drives, deal structure, vehicle acquisition, and vehicle ownership relationships.',
  },
  {
    id: 'boatrv',
    name: 'Boat & RV Dealership',
    category: 'industry',
    groups: ['Auto & vehicles'],
    summary:
      'Unit inventory, specifications, serial/VIN records, service history, trade-ins, storage, and ownership records.',
  },
  {
    id: 'legal',
    name: 'Legal Practice',
    category: 'industry',
    groups: ['Finance, legal & insurance'],
    summary:
      'Matter/case records, opposing parties, court dates, case documents, conflict relationships, and matter-specific timelines.',
  },
  {
    id: 'accounting',
    name: 'Accounting & Bookkeeping',
    category: 'industry',
    groups: ['Finance, legal & insurance'],
    summary:
      'Client entities, tax-year records, document request tracking, filing status, bookkeeping periods, and entity-specific financial work.',
  },
  {
    id: 'insurance',
    name: 'Insurance Agency',
    category: 'industry',
    groups: ['Finance, legal & insurance'],
    summary:
      'Policies, insured assets, carriers, coverage details, renewal dates, claims, and household/business policy relationships.',
  },
  {
    id: 'mortgage',
    name: 'Mortgage',
    category: 'industry',
    groups: ['Finance, legal & insurance'],
    summary:
      'Loan applications, borrower/co-borrower relationships, property records, underwriting milestones, document conditions, and loan-status tracking.',
  },
  {
    id: 'childcare',
    name: 'Childcare & Daycare',
    category: 'industry',
    groups: ['Education & childcare'],
    summary:
      'Child profiles connected to guardians, authorized pickup lists, attendance, allergies, incident reports, and classroom assignments.',
  },
  {
    id: 'tutoring',
    name: 'School & Tutoring',
    category: 'industry',
    groups: ['Education & childcare'],
    summary:
      'Student records connected to multiple parents/guardians with grades, lessons, assignments, attendance, and academic progress tracking.',
  },
  {
    id: 'catering',
    name: 'Restaurant & Catering',
    category: 'industry',
    groups: ['Events, food & hospitality'],
    summary:
      'Catering events, menus, guest counts, dietary requirements, venue logistics, equipment needs, and event production details.',
  },
  {
    id: 'eventplanner',
    name: 'Wedding & Event Planner',
    category: 'industry',
    groups: ['Events, food & hospitality'],
    summary:
      'Events, venues, vendors, timelines, seating, guest lists, budgets, and event-specific dependencies.',
  },
  {
    id: 'lodging',
    name: 'Hotel & Short-Term Rental',
    category: 'industry',
    groups: ['Events, food & hospitality'],
    summary:
      'Properties/rooms, guest stays, housekeeping status, damages, access information, and property-specific guest records.',
  },
  {
    id: 'photography',
    name: 'Photography',
    category: 'industry',
    groups: ['Events, food & hospitality'],
    summary:
      'Client photo galleries, watermarking, proof selection limits, image favorites, revision requests, and automatic high-resolution delivery after approval/payment.',
  },
  {
    id: 'funeralhome',
    name: 'Funeral Home',
    category: 'industry',
    groups: ['Events, food & hospitality'],
    summary:
      'Decedent records, family relationships, service arrangements, obituary information, cemetery/cremation details, and required documentation.',
  },
  {
    id: 'dumpster',
    name: 'Dumpster Rental',
    category: 'industry',
    groups: ['Rentals & equipment'],
    summary:
      'Dumpster inventory, container sizes, delivery/pickup locations, weight/tonnage, landfill charges, and container availability.',
  },
  {
    id: 'equipmentrental',
    name: 'Equipment Rental',
    category: 'industry',
    groups: ['Rentals & equipment'],
    summary:
      'Individual equipment assets, serial numbers, condition photos, deposits, maintenance, availability, and checkout/check-in history.',
  },
  {
    id: 'salescoach',
    name: 'AI Sales Coach',
    category: 'sales',
    groups: ['Sales Enablement'],
    summary:
      'Listens to live or recorded sales calls and gives reps objection handling, talking points, coaching, and post-call feedback.',
  },
  {
    id: 'salesassist',
    name: 'Live Sales Assist',
    category: 'sales',
    groups: ['Sales Enablement', 'Voice & Calling'],
    summary:
      'Transcribes calls in real time and surfaces suggested responses, scripts, product information, and next-best actions during the conversation.',
  },
  {
    id: 'proposals',
    name: 'Proposal Builder',
    category: 'sales',
    groups: ['Sales Enablement'],
    summary:
      'Generates branded proposals from CRM data, selected services, pricing, scope, and customer requirements.',
  },
  {
    id: 'revenueintel',
    name: 'Revenue Intelligence',
    category: 'sales',
    groups: ['Revenue Intelligence'],
    summary:
      'Pipeline behavior, conversion rates, sales velocity and lost revenue, with forecasting, deal-risk alerts, win/loss analysis and next-best actions.',
    description:
      'Tracks pipeline behavior, conversion rates, sales velocity and lost revenue, with pipeline forecasting, deal-risk alerts, win/loss analysis and next-best actions.',
  },
  {
    id: 'leadscoring',
    name: 'Lead Scoring AI',
    category: 'sales',
    groups: ['Revenue Intelligence', 'Outbound Sales'],
    summary:
      'Scores incoming leads using behavior, conversations, source, profile, and historical conversion data.',
    overlap:
      'HandsFreeOS already flags hot leads with fixed rules. This adds a score learned from past results.',
  },
  {
    id: 'upsell',
    name: 'Upsell/Cross-Sell AI',
    category: 'sales',
    groups: ['Revenue Intelligence', 'Customer Success'],
    summary:
      'Finds existing customers who are likely candidates for additional products or services.',
  },
  {
    id: 'researcher',
    name: 'AI Research Assistant',
    category: 'sales',
    groups: ['Outbound Sales'],
    summary:
      'Researches companies, prospects, industries, competitors, and other business information directly from inside HandsFreeOS.',
  },
  {
    id: 'prospecting',
    name: 'Prospecting Assistant',
    category: 'sales',
    groups: ['Outbound Sales'],
    summary:
      'Finds potential customers, enriches company information, identifies decision-makers, and prepares outreach context.',
  },
  {
    id: 'prospectwriter',
    name: 'AI Sales Prospecting Writer',
    category: 'sales',
    groups: ['Outbound Sales'],
    summary:
      'Creates personalized cold emails, SMS, LinkedIn outreach, and follow-ups based on prospect research.',
    overlap:
      'HandsFreeOS’s campaigns already write to existing customers. This writes cold outreach to new prospects.',
  },
  {
    id: 'enrichment',
    name: 'Lead Database Enrichment',
    category: 'sales',
    groups: ['Outbound Sales'],
    summary:
      'Adds missing company, contact, industry, website, social, and firmographic information to CRM records.',
    overlap: 'HandsFreeOS’s AI already fills in details customers give. This adds outside data.',
  },
  {
    id: 'commissions',
    name: 'Commission Manager',
    category: 'sales',
    groups: ['Sales Enablement', 'Finance & Accounting'],
    summary:
      'Calculates commissions based on sales, services, products, teams, or custom compensation rules.',
  },
  {
    id: 'socialscheduler',
    name: 'Social Media Scheduler',
    category: 'marketing',
    groups: ['Social Media'],
    summary:
      'Plans, schedules, and publishes content across connected social platforms from one calendar.',
  },
  {
    id: 'socialcontent',
    name: 'AI Social Media Content Creator',
    category: 'marketing',
    groups: ['Social Media', 'Content Marketing'],
    summary:
      'Generates platform-specific posts, captions, hooks, image ideas, and content variations based on the company’s brand and goals.',
  },
  {
    id: 'socialinbox',
    name: 'Social Media Inbox',
    category: 'marketing',
    groups: ['Social Media'],
    summary:
      'Combines comments, mentions, and social DMs into one workspace for response and follow-up.',
    overlap:
      'HandsFreeOS’s inbox already answers Facebook Messenger and Instagram messages, and shows the ad each came from. This adds comments, mentions and other networks.',
  },
  {
    id: 'sociallistening',
    name: 'Social Listening',
    category: 'marketing',
    groups: ['Social Media'],
    summary:
      'Monitors brand mentions, competitors, relevant keywords, and customer sentiment across social channels.',
  },
  {
    id: 'contentcalendar',
    name: 'AI Content Calendar',
    category: 'marketing',
    groups: ['Content Marketing', 'Marketing Automation'],
    summary:
      'Automatically creates a monthly or weekly content plan based on promotions, industry topics, seasonality, and business goals.',
  },
  {
    id: 'blogwriter',
    name: 'AI Blog Writer',
    category: 'marketing',
    groups: ['Content Marketing', 'SEO'],
    summary:
      'Researches topics and produces SEO-focused blog drafts based on the company’s services and target customers.',
  },
  {
    id: 'seoplanner',
    name: 'SEO Content Planner',
    category: 'marketing',
    groups: ['SEO', 'Content Marketing'],
    summary:
      'Finds keyword opportunities and builds topic clusters, content briefs, internal-linking suggestions, and publishing priorities.',
  },
  {
    id: 'googlerank',
    name: 'Google Ranking',
    category: 'marketing',
    groups: ['SEO'],
    summary:
      'Keyword and local rank tracking, technical SEO checks, Google Business Profile tips, backlink monitoring, and how competitors rank.',
  },
  {
    id: 'conversioncoach',
    name: 'Website Conversion Coach',
    category: 'marketing',
    groups: ['Website & Conversion Optimization'],
    summary:
      'Reviews landing pages and recommends improvements to copy, layout, calls to action, trust signals, and conversion flow.',
  },
  {
    id: 'adcreator',
    name: 'AI Ad Creator',
    category: 'marketing',
    groups: ['Advertising'],
    summary:
      'Generates advertising concepts, headlines, primary copy, offers, and creative variations for paid campaigns.',
  },
  {
    id: 'adperformance',
    name: 'Ad Performance Assistant',
    category: 'marketing',
    groups: ['Advertising'],
    summary:
      'Analyzes campaign results and highlights weak ads, wasted spend, audience issues, and optimization opportunities.',
  },
  {
    id: 'competitors',
    name: 'Competitor Intelligence',
    category: 'marketing',
    groups: ['Social Media', 'SEO', 'Reputation & Reviews'],
    summary:
      'Tracks competitors’ websites, offers, ads, reviews, pricing, and messaging and summarizes meaningful changes.',
  },
  {
    id: 'copywriter',
    name: 'AI Copywriter',
    category: 'marketing',
    groups: ['Content Marketing', 'Advertising'],
    summary:
      'Creates sales copy, website copy, offers, emails, ads, SMS campaigns, and other business marketing content.',
  },
  {
    id: 'referralprogram',
    name: 'Referral Program Manager',
    category: 'marketing',
    groups: ['Referral & Partnership Management'],
    summary:
      'Tracks referral partners, referral links, rewards, payouts, and customers generated through referrals.',
    overlap:
      'HandsFreeOS already records who referred a customer. This adds referral links, rewards and payouts.',
  },
  {
    id: 'affiliates',
    name: 'Affiliate Manager',
    category: 'marketing',
    groups: ['Referral & Partnership Management'],
    summary: 'Manages affiliates, tracking links, commissions, attribution, and payout reporting.',
  },
  {
    id: 'ticketing',
    name: 'Events',
    category: 'marketing',
    groups: [],
    summary:
      'Registration, ticketing, attendees, seating, check-in, badges, speakers, sponsors, vendors, and post-event follow-up.',
    overlap:
      'HandsFreeOS’s event and class calendars already take sign-ups. This adds tickets, check-in, badges, speakers and sponsors.',
  },
  {
    id: 'loyalty',
    name: 'Loyalty Program',
    category: 'customers',
    groups: ['Membership & Loyalty'],
    summary:
      'Adds points, rewards, membership tiers, customer perks, and repeat-purchase incentives.',
  },
  {
    id: 'membermanager',
    name: 'Membership Manager',
    category: 'customers',
    groups: ['Membership & Loyalty'],
    summary:
      'Supports recurring memberships, benefits, usage limits, renewals, and member-specific access.',
    overlap:
      'HandsFreeOS already bills recurring plans. This adds member benefits, usage limits and access.',
  },
  {
    id: 'customerportal',
    name: 'Customer Portal',
    category: 'customers',
    groups: ['Customer Portals'],
    summary:
      'Gives customers a branded area to view appointments, invoices, documents, messages, projects, and account information.',
    overlap:
      'Customers already get their own links for bookings, estimates, invoices and plans. This puts them in one place.',
  },
  {
    id: 'onboardportal',
    name: 'Client Onboarding Portal',
    category: 'customers',
    groups: ['Customer Portals', 'Customer Success'],
    summary:
      'Guides new customers through forms, documents, payments, setup tasks, and required information.',
  },
  {
    id: 'projectportal',
    name: 'Project Portal',
    category: 'customers',
    groups: ['Customer Portals', 'Project Management'],
    summary:
      'Lets customers follow project progress, milestones, approvals, files, messages, and outstanding decisions.',
  },
  {
    id: 'successmanager',
    name: 'AI Customer Success Manager',
    category: 'customers',
    groups: ['Customer Success'],
    summary:
      'Monitors customer activity and proactively identifies customers needing help, follow-up, renewal, or expansion.',
  },
  {
    id: 'churn',
    name: 'Customer Churn Predictor',
    category: 'customers',
    groups: ['Customer Success'],
    summary: 'Identifies customers showing signs they may cancel, disengage, or stop purchasing.',
  },
  {
    id: 'renewals',
    name: 'Renewal Manager',
    category: 'customers',
    groups: ['Customer Success', 'Contracts & E-Signature'],
    summary:
      'Tracks contracts, memberships, warranties, subscriptions, and upcoming renewal opportunities.',
  },
  {
    id: 'warranties',
    name: 'Warranty Manager',
    category: 'customers',
    groups: ['Customer Success'],
    summary:
      'Tracks warranty terms, covered products, expiration dates, claims, and service history.',
  },
  {
    id: 'customervoice',
    name: 'Voice-of-Customer Analytics',
    category: 'customers',
    groups: ['Customer Success', 'Reputation & Reviews'],
    summary:
      'Analyzes calls, messages, reviews, surveys, and support conversations to identify common customer themes.',
  },
  {
    id: 'customersupport',
    name: 'Customer Support',
    category: 'customers',
    groups: [],
    summary:
      'Ticketing, knowledge-based AI support, SLA tracking, escalation rules, bug reports, customer-status pages, and support analytics.',
  },
  {
    id: 'contactcenter',
    name: 'Contact Center',
    category: 'customers',
    groups: ['Voice & Calling'],
    summary:
      'Agent queues, SLA management, supervisor dashboards, workforce routing, quality monitoring, escalation management, and omnichannel support.',
    overlap:
      'HandsFreeOS’s shared inbox already assigns conversations. This adds queues, SLAs and supervisor views.',
  },
  {
    id: 'callrouting',
    name: 'Phone Menus & Call Routing',
    category: 'customers',
    groups: ['Voice & Calling'],
    summary:
      'Phone menus (“press 1 for sales”), sending calls to the right person, call whispering, and pre-recorded voicemail drops.',
    overlap:
      'HandsFreeOS already records calls, and the AI teammate answers them. This adds menus and routing.',
  },
  {
    id: 'productfeedback',
    name: 'Product Feedback',
    category: 'customers',
    groups: ['Customer Success'],
    summary:
      'Feature requests, voting, customer feedback, roadmap requests, NPS/CSAT insights, feedback clustering, and product research.',
  },
  {
    id: 'community',
    name: 'Community Management',
    category: 'customers',
    groups: [],
    summary:
      'Private customer communities, groups, discussions, events, courses, member directories, announcements, and moderation.',
  },
  {
    id: 'routeplanner',
    name: 'Route Optimization',
    category: 'operations',
    groups: ['Field Service'],
    summary:
      'Builds efficient daily routes for field teams based on appointments, priority, geography, and travel time.',
  },
  {
    id: 'fieldtracking',
    name: 'Field Team Tracking',
    category: 'operations',
    groups: ['Field Service'],
    summary:
      'Adds technician location, job status, route progress, arrival information, and field activity visibility.',
    overlap:
      'HandsFreeOS already has job status and On my way texts. This adds live location and route progress.',
  },
  {
    id: 'projects',
    name: 'Project Management',
    category: 'operations',
    groups: ['Project Management'],
    summary:
      'Projects, milestones, which task comes first, timeline (Gantt) charts, workload planning, and project profitability.',
    overlap:
      'HandsFreeOS already gathers visits into a job. This adds timelines, task order and workload.',
  },
  {
    id: 'fleet',
    name: 'Fleet Management',
    category: 'operations',
    groups: ['Field Service'],
    summary:
      'Vehicles, drivers, mileage, maintenance schedules, fuel usage, GPS integrations, inspections, accidents, and fleet costs.',
  },
  {
    id: 'inventory',
    name: 'Inventory Management',
    category: 'operations',
    groups: ['Inventory & Warehousing'],
    summary:
      'Tracks products, parts, quantities, locations, reorder levels, and inventory movements.',
  },
  {
    id: 'purchasing',
    name: 'Purchase Order Management',
    category: 'operations',
    groups: ['Inventory & Warehousing', 'Procurement & Vendor Management'],
    summary:
      'Creates and tracks purchase orders, suppliers, receiving, costs, and outstanding inventory orders.',
  },
  {
    id: 'vendors',
    name: 'Vendor Management',
    category: 'operations',
    groups: ['Procurement & Vendor Management'],
    summary:
      'Maintains vendors, contracts, pricing, performance, certifications, and purchasing history.',
  },
  {
    id: 'staffdesk',
    name: 'Internal Help Desk',
    category: 'operations',
    groups: ['Operations'],
    summary:
      'Gives employees a place to submit IT, HR, operations, or administrative requests and track resolution.',
  },
  {
    id: 'docai',
    name: 'Document AI',
    category: 'operations',
    groups: ['Document Intelligence'],
    summary:
      'Reads uploaded contracts, forms, invoices, and documents and extracts important information into structured records.',
  },
  {
    id: 'contracts',
    name: 'Contract Generator',
    category: 'operations',
    groups: ['Contracts & E-Signature'],
    summary:
      'Builds contracts and agreements from reusable templates and automatically fills them with CRM data.',
  },
  {
    id: 'esignature',
    name: 'Digital Signature Suite',
    category: 'operations',
    groups: ['Contracts & E-Signature'],
    summary:
      'Adds reusable signature workflows, signer order, document tracking, and completed agreement storage.',
    overlap:
      'Customers already approve estimates by typing their name. This adds signing for any document.',
  },
  {
    id: 'compliance',
    name: 'Compliance & Risk',
    category: 'operations',
    groups: ['Quality Assurance'],
    summary:
      'Consent tracking, licensing, certifications, required documentation, audit trails, policy acknowledgements, data-retention rules, and compliance alerts.',
    overlap:
      'HandsFreeOS already tracks texting consent and keeps an audit log. This adds licenses, certifications and policies.',
  },
  {
    id: 'franchise',
    name: 'Franchise Management',
    category: 'operations',
    groups: [],
    summary:
      'Franchisee records, royalties, brand compliance, territory management, shared marketing, performance comparisons, and corporate oversight.',
  },
  {
    id: 'shifts',
    name: 'Employee Scheduling',
    category: 'team',
    groups: ['Workforce Management'],
    summary:
      'Handles shifts, availability, coverage, time-off requests, and staffing requirements.',
    overlap: 'HandsFreeOS already has hours and time off. This adds shifts, coverage and staffing.',
  },
  {
    id: 'timetracking',
    name: 'Time Tracking',
    category: 'team',
    groups: ['Workforce Management'],
    summary: 'Tracks employee hours, jobs, billable time, breaks, and labor allocation.',
  },
  {
    id: 'recruiter',
    name: 'AI Recruiting Assistant',
    category: 'team',
    groups: ['HR & Recruiting'],
    summary:
      'Screens applicants, summarizes resumes, coordinates interviews, and helps manage candidate communication.',
  },
  {
    id: 'hiring',
    name: 'Applicant Tracking System',
    category: 'team',
    groups: ['HR & Recruiting'],
    summary:
      'Adds jobs, applicants, interview stages, hiring notes, offers, and recruiting pipelines.',
  },
  {
    id: 'staffonboarding',
    name: 'Employee Onboarding',
    category: 'team',
    groups: ['HR & Recruiting'],
    summary: 'Manages new-hire paperwork, training, credentials, equipment, and onboarding tasks.',
  },
  {
    id: 'trainingcoach',
    name: 'Employee Training Coach',
    category: 'team',
    groups: ['Training & Learning'],
    summary:
      'Uses company knowledge to train staff through interactive scenarios, quizzes, role-play, and coaching.',
  },
  {
    id: 'qualityscoring',
    name: 'Conversation Quality Scoring',
    category: 'team',
    groups: ['Quality Assurance'],
    summary:
      'Reviews employee calls, texts, and chats against company standards and identifies coaching opportunities.',
  },
  {
    id: 'meetingnotes',
    name: 'AI Meeting Assistant',
    category: 'team',
    groups: ['Operations'],
    summary:
      'Records or transcribes meetings, creates summaries, identifies decisions, and automatically generates follow-up actions.',
  },
  {
    id: 'expenses',
    name: 'Expense Management',
    category: 'finance',
    groups: ['Finance & Accounting'],
    summary:
      'Lets employees submit receipts and expenses for categorization, approval, reimbursement, and reporting.',
  },
  {
    id: 'ecommerce',
    name: 'E-Commerce',
    category: 'finance',
    groups: [],
    summary:
      'Product catalog, abandoned-cart recovery, order tracking, returns, subscriptions, product recommendations, and inventory sync.',
    description:
      'Product catalog management, abandoned-cart recovery, order tracking, returns/RMA management, subscriptions, product recommendations, customer purchase history, and inventory synchronization.',
  },
  {
    id: 'execdashboard',
    name: 'Executive Dashboard',
    category: 'insights',
    groups: ['Business Intelligence'],
    summary:
      'Combines key business metrics into a simplified owner-level view with AI explanations of important changes.',
  },
  {
    id: 'reportbuilder',
    name: 'Business Intelligence Builder',
    category: 'insights',
    groups: ['Business Intelligence'],
    summary:
      'Lets users create custom reports, dashboards, metrics, and visualizations using CRM and operational data.',
  },
  {
    id: 'callintel',
    name: 'Call Intelligence',
    category: 'insights',
    groups: ['Voice & Calling', 'Revenue Intelligence'],
    summary:
      'Analyzes calls for topics, sentiment, objections, competitor mentions, buying signals, and outcomes.',
    overlap: 'HandsFreeOS already keeps call transcripts. This adds the analysis.',
  },
  {
    id: 'experiments',
    name: 'Analytics & Experimentation',
    category: 'insights',
    groups: ['Business Intelligence', 'Website & Conversion Optimization'],
    summary:
      'A/B testing, cohort analysis, funnel analysis, retention analysis, attribution modeling, and experiment tracking.',
  },
  {
    id: 'forecasting',
    name: 'Forecasting & Predictive AI',
    category: 'insights',
    groups: ['Business Intelligence', 'Revenue Intelligence'],
    summary:
      'Predicts revenue, appointment volume, staffing demand, churn, inventory requirements, lead conversion, and cash flow.',
  },
  {
    id: 'benchmarking',
    name: 'Industry Benchmarking',
    category: 'insights',
    groups: ['Business Intelligence'],
    summary:
      'Compares business metrics against anonymized businesses of similar size, geography, or industry.',
  },
  {
    id: 'agentbuilder',
    name: 'AI Agent Builder',
    category: 'ai',
    groups: [],
    summary:
      'Lets businesses create specialized AI workers by defining their role, permissions, knowledge, tools, escalation rules, and objectives.',
    overlap:
      'HandsFreeOS has one AI teammate. This lets a business make more, each with its own job.',
  },
  {
    id: 'decisionengine',
    name: 'AI Decision Engine',
    category: 'ai',
    groups: [],
    summary:
      'Evaluates CRM context and automatically decides what action HandsFreeOS should take next instead of relying on rigid workflows.',
    overlap:
      'The Action Center already handles safe items on its own. This decides next steps across everything.',
  },
  {
    id: 'workflowauditor',
    name: 'AI Workflow Auditor',
    category: 'ai',
    groups: [],
    summary:
      'Reviews existing automations and identifies conflicts, duplicated actions, broken logic, unnecessary steps, and opportunities for simplification.',
  },
];

/** Words that say nothing about what an add-on does, left out of its keywords. */
const FILLER = new Set(['and', 'the', 'for', 'with', 'add', 'ons']);

/** What a person might call it: the words of its name and its groups. */
function keywordsOf(e: PlannedEntry): string[] {
  const words = [e.name, ...e.groups]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !FILLER.has(w));
  return [...new Set(words)];
}

function plannedManifest(e: PlannedEntry): AddonManifest {
  return {
    id: e.id,
    name: e.name,
    summary: e.summary,
    description: e.description ?? e.summary,
    category: e.category,
    version: '0.0.0',
    dataVersion: 1,
    catalog: {
      status: 'planned',
      keywords: keywordsOf(e),
      groups: e.groups,
      ...(e.overlap ? { overlap: e.overlap } : {}),
    },
    capabilities: [],
    permissions: [],
    billing: { model: 'free' },
  };
}

/** Every planned add-on, as a manifest. */
export const PLANNED_ADDONS: readonly AddonManifest[] = ENTRIES.map(plannedManifest);
