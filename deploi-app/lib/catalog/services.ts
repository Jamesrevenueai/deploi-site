/**
 * Structured service catalog: the single source of truth for what Deploi sells.
 * The marketing site reads an exported copy (scripts/export-catalog.ts -> ../src/data/catalog.json);
 * staff tools read this module directly. Availability is a software-capability status and is
 * deliberately conservative; it can be raised per service through the service_availability setting
 * once a real customer has run the service.
 */
import type { WorkerName } from '../workers/types'

export type Door = 'growth' | 'staffing' | 'operations'
export type Availability = 'demonstration' | 'supervised_pilot' | 'production_verified' | 'planned'
export type InputMethod = 'csv' | 'manual_entry' | 'email_inbox' | 'webhook' | 'sms_reply' | 'staff_delivered'

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  demonstration: 'Demonstration',
  supervised_pilot: 'Supervised pilot',
  production_verified: 'Production verified',
  planned: 'Planned',
}

export const AVAILABILITY_HELP: Record<Availability, string> = {
  demonstration: 'Works end to end on synthetic data in our own environment. No customer has run it yet.',
  supervised_pilot: 'Running for at least one customer with every action reviewed by a person.',
  production_verified: 'Has completed at least one pilot with measured results and runs under defined management.',
  planned: 'Not built. Do not sell.',
}

export type SuccessMeasure = { key: string; label: string; definition: string }

export type ServiceDef = {
  key: string
  name: string
  door: Door
  worker: WorkerName | null
  /** standalone services need no assessment and no retainer */
  standalone: boolean
  description: string
  targetCustomer: string
  availability: Availability
  inputMethods: InputMethod[]
  requiredAccess: string[]
  setupDeliverables: string[]
  ongoingDeliverables: string[]
  customerResponsibilities: string[]
  deploiResponsibilities: string[]
  volumeLimits: string[]
  exclusions: string[]
  humanReview: string[]
  successMeasures: SuccessMeasure[]
}

const HOME_CARE = 'Small home care agencies (Medicaid waiver, private pay) that keep their current scheduler, EVV and billing systems.'
const REVIEW_DEFAULT = 'Every message a worker proposes waits for a named person at the agency or at Deploi to approve, edit or skip it. Auto-send is off unless the engagement turns it on for a specific worker.'

export const SERVICES: ServiceDef[] = [
  {
    key: 'referral_response', name: 'Referral response and follow-up', door: 'growth', worker: 'referral_response', standalone: false,
    description: 'New referrals get a first response quickly, capacity is confirmed, intake starts the same day, and the referrer hears back when care starts.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['email_inbox', 'manual_entry'],
    requiredAccess: ['A referral inbox address we can receive from (forwarding or a dedicated alias)', 'Current capacity rules: counties, services, hours, weekly intake limit', 'Who at the agency approves replies'],
    setupDeliverables: ['Referral inbox connected or a manual logging form in place', 'Capacity rules configured', 'Reply and follow-up templates approved by the agency', 'Baseline: median time to first response over the baseline period'],
    ongoingDeliverables: ['Proposed first responses within the agreed window', '7- and 30-day follow-up proposals to the referrer', 'Referral metrics on the morning report'],
    customerResponsibilities: ['Approve or edit proposed replies inside the agreed window', 'Keep capacity rules current', 'Handle the clinical intake itself'],
    deploiResponsibilities: ['Keep the inbox and rules running', 'Review proposals during support hours', 'Report response times weekly'],
    volumeLimits: ['Up to 60 referrals per month per agency in the base management fee; more is quoted'],
    exclusions: ['No clinical eligibility decisions', 'No marketing to new referral sources', 'No phone answering'],
    humanReview: [REVIEW_DEFAULT],
    successMeasures: [
      { key: 'referral_response_time', label: 'Median time to first response', definition: 'Median of (first_response_at − received_at) over referrals received in the period. Denominator: referrals received.' },
      { key: 'followup_completion', label: 'Follow-up completion', definition: 'Referrals with a sent 7-day follow-up ÷ referrals that reached intake at least 7 days before period end.' },
    ],
  },
  {
    key: 'website_improvement', name: 'Website Improvement', door: 'growth', worker: null, standalone: true,
    description: 'We improve your existing website so visitors can understand your services, contact your team, and take the next step more easily.',
    targetCustomer: 'Any small healthcare practice with an existing website on a common platform.',
    availability: 'demonstration',
    inputMethods: ['staff_delivered'],
    requiredAccess: ['Editor access to the existing website platform, arranged through an approved access method (never a password typed into a form)', 'Up to three pages to improve', 'An approval contact'],
    setupDeliverables: ['Focused review of mobile usability, clarity and inquiry paths', 'Improvements to up to three existing pages', 'Clearer service descriptions and calls to action', 'Basic layout, readability and mobile-formatting fixes', 'One existing inquiry form improved, or one simple new form using an approved supported tool', 'Basic titles and meta descriptions for the selected pages', 'Contact-link, button and form-delivery checks', 'One consolidated revision round', 'Brief before-and-after summary'],
    ongoingDeliverables: [],
    customerResponsibilities: ['Provide access and content', 'Approve the preview before anything is published', 'Keep hosting, domain and plugin subscriptions'],
    deploiResponsibilities: ['Back up or document a rollback before changing anything', 'Stage or preview where the platform supports it', 'Verify publication and hand off a summary'],
    volumeLimits: ['Five total staff hours including review, implementation, testing and revisions', 'One website, up to three pages, one revision round'],
    exclusions: ['New website builds', 'Full redesigns', 'Site migrations', 'Custom applications', 'Patient portals', 'Branding or logo work', 'Paid advertising', 'Ongoing SEO or content production', 'Complex scheduling, EHR, CRM or payment integrations', 'Hosting, domain, plugin or subscription charges', 'Unlimited revisions', 'Ongoing maintenance'],
    humanReview: ['Customer approval of the preview is required before publishing.'],
    successMeasures: [
      { key: 'published_on_approval', label: 'Published after approval', definition: 'Approved changes published and verified, with a handoff summary delivered.' },
    ],
  },
  {
    key: 'applicant_screening', name: 'Applicant follow-up and screening support', door: 'staffing', worker: 'applicant_screening', standalone: false,
    description: 'New applicants get a fast first text, four screening questions, and an interview slot while they are still interested.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['csv', 'webhook', 'sms_reply', 'manual_entry'],
    requiredAccess: ['Applicant export (CSV) or a job-board webhook', 'Interview slots', 'SMS consent language on the application'],
    setupDeliverables: ['Applicant import or webhook connected', 'Screening questions and interview slots configured', 'Templates approved'],
    ongoingDeliverables: ['Proposed first-contact texts and screening sequences', 'Interview bookings recorded', 'Applicant metrics on the morning report'],
    customerResponsibilities: ['Collect SMS consent at application', 'Hold the interviews and make every hiring decision', 'Keep interview slots current'],
    deploiResponsibilities: ['Run the screening sequence', 'Review proposals during support hours'],
    volumeLimits: ['Up to 80 applicants per month in the base fee'],
    exclusions: ['No hiring decisions, background checks or offers', 'No job-board posting or advertising spend'],
    humanReview: [REVIEW_DEFAULT, 'No employment decision is automated; the agency decides who is interviewed and hired.'],
    successMeasures: [
      { key: 'interviews_booked', label: 'Interviews booked', definition: 'Applicants with interview_at set in the period ÷ applicants received in the period. Bookings are not hires.' },
      { key: 'applicant_first_contact_time', label: 'Median time to first contact', definition: 'Median of (first proposed-and-sent text − applied_at). Drafts do not count.' },
    ],
  },
  {
    key: 'retention_checkins', name: 'Retention check-ins', door: 'staffing', worker: 'retention_checkins', standalone: false,
    description: '30-, 60- and 90-day check-in texts to new aides, with replies that signal quit risk flagged for the agency.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['csv', 'manual_entry', 'sms_reply'],
    requiredAccess: ['Aide roster with hire dates and phone numbers', 'SMS consent per aide'],
    setupDeliverables: ['Roster imported', 'Check-in templates approved'],
    ongoingDeliverables: ['Proposed check-ins on schedule', 'Quit-risk flags on the morning report'],
    customerResponsibilities: ['Act on quit-risk flags', 'Keep the roster current'],
    deploiResponsibilities: ['Schedule and propose check-ins', 'Flag replies that need a person'],
    volumeLimits: ['Up to 150 active aides in the base fee'],
    exclusions: ['No HR decisions, no pay or scheduling changes'],
    humanReview: [REVIEW_DEFAULT],
    successMeasures: [
      { key: 'checkin_completion', label: 'Check-ins sent on time', definition: 'Check-ins sent within 3 days of due_on ÷ check-ins due in the period.' },
    ],
  },
  {
    key: 'credential_tracking', name: 'Credential reminders', door: 'staffing', worker: 'credential_tracking', standalone: false,
    description: 'Licenses, CPR, TB, background checks and training dates tracked, with reminders to the aide and the office before they lapse.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['csv', 'manual_entry'],
    requiredAccess: ['Credential list per aide with expiry dates'],
    setupDeliverables: ['Credentials imported', 'Reminder lead times and templates approved'],
    ongoingDeliverables: ['Proposed reminders at 30 and 7 days', 'Lapse list on the morning report'],
    customerResponsibilities: ['Update expiry dates when a renewal arrives', 'Decide what happens when a credential lapses'],
    deploiResponsibilities: ['Track dates and propose reminders'],
    volumeLimits: ['Up to 150 active aides in the base fee'],
    exclusions: ['No verification with licensing boards', 'No scheduling changes'],
    humanReview: [REVIEW_DEFAULT],
    successMeasures: [
      { key: 'lapses_avoided', label: 'Credentials renewed before expiry', definition: 'Credentials with a reminder sent that were updated before expiry ÷ credentials expiring in the period.' },
    ],
  },
  {
    key: 'open_shift_fill', name: 'Open-shift outreach', door: 'operations', worker: 'open_shift_fill', standalone: false,
    description: 'Open and call-off shifts offered by text to qualified, nearby aides, with the first YES recorded and the family notified.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['csv', 'manual_entry', 'sms_reply'],
    requiredAccess: ['Scheduler export of open shifts (CSV) or manual entry', 'Aide services and locations', 'SMS consent per aide'],
    setupDeliverables: ['Shift import configured', 'Offer order rules (distance, services, declined clients) configured', 'Templates approved'],
    ongoingDeliverables: ['Proposed offers per open shift', 'Fill confirmations recorded', 'Shift metrics on the morning report'],
    customerResponsibilities: ['Confirm the fill in the scheduler of record', 'Keep aide eligibility current'],
    deploiResponsibilities: ['Propose offers and record replies'],
    volumeLimits: ['Up to 120 open shifts per month in the base fee'],
    exclusions: ['No changes inside the agency scheduler', 'No pay-rate decisions'],
    humanReview: [REVIEW_DEFAULT, 'A shift counts as filled only when the agency confirms it in the scheduler.'],
    successMeasures: [
      { key: 'shifts_confirmed_filled', label: 'Shifts confirmed filled', definition: 'Open shifts with status filled (agency-confirmed) ÷ open shifts in the period. Outreach alone is not a fill.' },
      { key: 'time_to_fill', label: 'Median minutes to fill', definition: 'Median of (filled_at − open_since) over confirmed fills.' },
    ],
  },
  {
    key: 'authorization_watch', name: 'Authorization monitoring', door: 'operations', worker: 'authorization_watch', standalone: false,
    description: 'Units used against units authorized, with low-balance and expiry alerts to the office before care outruns the authorization.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['csv', 'manual_entry'],
    requiredAccess: ['Authorization export (CSV) with client, service code, units, start and end dates', 'Visit export to count units used'],
    setupDeliverables: ['Authorization import configured', 'Thresholds configured (default 15% left, 30 days to expiry)'],
    ongoingDeliverables: ['Proposed alerts to the office', 'Authorization tile on the morning report'],
    customerResponsibilities: ['Request re-authorizations', 'Keep the authorization export current'],
    deploiResponsibilities: ['Track balances and propose alerts'],
    volumeLimits: ['Up to 200 active authorizations in the base fee'],
    exclusions: ['No submissions to payers', 'No billing decisions'],
    humanReview: [REVIEW_DEFAULT],
    successMeasures: [
      { key: 'auth_overruns', label: 'Authorizations exhausted before re-auth', definition: 'Authorizations that reached 0 units before a replacement started ÷ authorizations ending in the period.' },
    ],
  },
  {
    key: 'evv_exceptions', name: 'EVV exception management', door: 'operations', worker: null, standalone: false,
    description: 'Visit exports checked against seven rules; exceptions listed with the configured correction deadline and a billing-hold list for the biller to review.',
    targetCustomer: HOME_CARE,
    availability: 'demonstration',
    inputMethods: ['csv'],
    requiredAccess: ['EVV vendor visit export (CSV) on an agreed cadence', 'Authorization export', 'Program, payer and state for the correction rule set'],
    setupDeliverables: ['CSV mapping configured for the vendor export', 'Correction rules configured with source and effective date', 'Billing-hold export tested'],
    ongoingDeliverables: ['Exception list per import with deadline', 'Advisory billing-hold CSV', 'Exception tile on the morning report'],
    customerResponsibilities: ['Export visits on the agreed cadence', 'Make corrections in the EVV vendor system', 'Review the billing-hold list before billing'],
    deploiResponsibilities: ['Run the rules and keep deadlines current with their sources'],
    volumeLimits: ['Up to 3,000 visits per month in the base fee'],
    exclusions: ['No live EVV vendor connection (CSV only)', 'No corrections made in the vendor system by Deploi', 'No claims submitted'],
    humanReview: ['Every correction and every billing decision is made by the agency. The billing-hold list is advisory.'],
    successMeasures: [
      { key: 'exception_resolution_time', label: 'Median days to resolve an exception', definition: 'Median of (corrected_at − opened_at) over exceptions corrected in the period. Detection is not recovered payment.' },
      { key: 'exceptions_past_window', label: 'Exceptions that passed the deadline', definition: 'Open exceptions whose configured deadline passed in the period ÷ exceptions opened.' },
    ],
  },
]

export const DOOR_LABEL: Record<Door, string> = { growth: 'Growth', staffing: 'Staffing', operations: 'Operations' }

export function getService(key: string): ServiceDef | undefined { return SERVICES.find(s => s.key === key) }
export function servicesByDoor(door: Door): ServiceDef[] { return SERVICES.filter(s => s.door === door) }
export function serviceForWorker(worker: WorkerName): ServiceDef | undefined { return SERVICES.find(s => s.worker === worker) }

/** Apply staff overrides (settings.service_availability = { [key]: Availability }). Overrides can only name known statuses. */
export function withAvailabilityOverrides(overrides: Record<string, unknown> | undefined | null): ServiceDef[] {
  const ok = new Set<string>(Object.keys(AVAILABILITY_LABEL))
  return SERVICES.map(s => {
    const o = overrides?.[s.key]
    return typeof o === 'string' && ok.has(o) ? { ...s, availability: o as Availability } : s
  })
}
