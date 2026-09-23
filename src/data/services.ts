export type ServiceStatus = 'available' | 'coming_soon'
export type ServiceDoor = 'plan' | 'build' | 'train' | 'run'

export type Service = {
  slug: string
  door: ServiceDoor
  name: string
  oneLiner: string
  includes: string[]
  price: string
  status: ServiceStatus
  /** Where the primary CTA should point: 'audit' | 'course' | 'mini-audit' | 'waitlist' */
  cta: 'audit' | 'course' | 'mini-audit' | 'waitlist'
}

export const SERVICES: Service[] = [
  /* ---------------------------------------------------------------- PLAN */
  {
    slug: 'ai-audit',
    door: 'plan',
    name: 'AI Audit',
    oneLiner: 'A fixed-price audit of where AI saves your business time and money. 100% credited toward setup if you sign within 30 days.',
    includes: [
      'Discovery session (60–90 min walkthrough)',
      'Tool & data inventory',
      'Opportunity scoring',
      'Written report with top 3–5 opportunities',
      'Readout call',
    ],
    price: '$750',
    status: 'available',
    cta: 'audit',
  },
  {
    slug: 'ai-roadmap',
    door: 'plan',
    name: 'AI Roadmap',
    oneLiner: '90-day sequenced plan for adopting AI across the business, with owner/effort/impact per step.',
    includes: [
      'Prioritized 90-day plan',
      'Owner + effort + impact per step',
      'Tool + data recommendations',
      'Executive summary + walkthrough',
    ],
    price: 'from $2,000',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'fractional-ai-advisor',
    door: 'plan',
    name: 'Fractional AI Advisor',
    oneLiner: 'Monthly advisory retainer — bring us in on AI decisions, tool picks, and vendor reviews. Advisory only.',
    includes: [
      'Two working sessions per month',
      'Async questions between sessions',
      'Tool + vendor reviews',
      'Quarterly plan check-in',
    ],
    price: 'from $2,000/mo',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'tool-selection',
    door: 'plan',
    name: 'Tool Selection',
    oneLiner: 'We pick the right AI tools for a specific job, based on your data, budget, and constraints.',
    includes: [
      'Requirements interview',
      'Shortlist of 2–4 tools with tradeoffs',
      'Pricing + integration notes',
      'Written recommendation',
    ],
    price: 'from $500',
    status: 'available',
    cta: 'mini-audit',
  },
  /* --------------------------------------------------------------- BUILD */
  {
    slug: 'quick-wins',
    door: 'build',
    name: 'Quick Wins',
    oneLiner: 'Missed-call text-back, review requests, lead follow-up, website chatbot. Wired into your tools, live in days.',
    includes: [
      'Missed-call text-back',
      'Review requests',
      'Lead follow-up',
      'Website chatbot',
    ],
    price: 'from $300 each',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'ai-receptionist',
    door: 'build',
    name: 'AI Receptionist',
    oneLiner: 'Answers your phone 24/7 — books, reroutes, and takes messages, in your tools.',
    includes: [
      'Setup on your phone number',
      'Custom scripts + escalation',
      'Booking into your calendar/PMS',
      '2 weeks of tuning',
    ],
    price: 'from $750',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'sales-assistant',
    door: 'build',
    name: 'Sales Assistant',
    oneLiner: 'Follows up with every new lead until they book or opt out — inside your CRM.',
    includes: [
      'Multi-channel follow-up sequences',
      'CRM integration',
      'Handoff rules to a human',
      '2 weeks of tuning',
    ],
    price: 'from $750',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'content-engine',
    door: 'build',
    name: 'Content Engine',
    oneLiner: 'A repeatable pipeline for social, email, and blog content — from your voice and your real work.',
    includes: [
      'Voice + topic template',
      'Draft-and-review workflow',
      'Publish/schedule wiring',
      'Weekly review process',
    ],
    price: 'from $500',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'company-brain',
    door: 'build',
    name: 'Company Brain Assistant',
    oneLiner: 'Ask questions of your own documents, SOPs, and notes. The AI runs in your accounts.',
    includes: [
      'Document + SOP ingestion',
      'Chat interface for your team',
      'Access controls',
      'Weekly re-index',
    ],
    price: 'from $500',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'custom-connections',
    door: 'build',
    name: 'Custom Connections & Internal Tools',
    oneLiner: 'Bespoke integrations between the tools you already use — quoted per project.',
    includes: [
      'Scoping session',
      'Fixed-price quote',
      'Built inside your own accounts',
      'Handover + docs',
    ],
    price: 'custom quote',
    status: 'available',
    cta: 'mini-audit',
  },
  /* --------------------------------------------------------------- TRAIN */
  {
    slug: 'founding-cohort-course',
    door: 'train',
    name: 'Founding Cohort Course',
    oneLiner: 'Learn to run your business with AI — 4 weekly live evening Zoom sessions, small cohort.',
    includes: [
      '4 live sessions',
      'Recordings included',
      'Prompt + automation library',
      'Small-cohort Q&A',
    ],
    price: '$297',
    status: 'available',
    cta: 'course',
  },
  {
    slug: 'team-workshop',
    door: 'train',
    name: 'Team Workshop',
    oneLiner: 'Hands-on half- or full-day workshop for your team, in-person or virtual.',
    includes: [
      'Custom to your workflows',
      'Live exercises',
      'Take-home prompts',
      'Recording',
    ],
    price: 'from $1,500',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'executive-briefing',
    door: 'train',
    name: 'Executive Briefing',
    oneLiner: 'A private 60–90 minute briefing for owners and leadership on where AI actually helps.',
    includes: [
      'Tailored to your industry',
      'Q&A time',
      'Slide deck to keep',
      'Follow-up notes',
    ],
    price: 'from $750',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'staff-ai-guidelines',
    door: 'train',
    name: 'Staff AI Guidelines',
    oneLiner: 'A plain-English AI usage policy your team can actually follow.',
    includes: [
      'Written policy document',
      'Do / don’t examples',
      'Rollout checklist',
      '30-min review call',
    ],
    price: 'from $300',
    status: 'available',
    cta: 'mini-audit',
  },
  {
    slug: 'ai-office-hours',
    door: 'train',
    name: 'AI Office Hours',
    oneLiner: 'Drop-in monthly Q&A for your team on anything AI — subscription.',
    includes: [
      'Monthly live session',
      'Async questions',
      'Recording archive',
    ],
    price: '$49/mo',
    status: 'available',
    cta: 'mini-audit',
  },
  /* ----------------------------------------------------------------- RUN */
  {
    slug: 'managed-starter',
    door: 'run',
    name: 'Managed AI Workers — Starter',
    oneLiner: '1 AI worker, monitored, retrained, and reported on every month.',
    includes: [
      'Continuous monitoring',
      'Monthly reporting',
      'Model swaps as needed',
      'Email support',
    ],
    price: '$400/mo',
    status: 'coming_soon',
    cta: 'waitlist',
  },
  {
    slug: 'managed-growth',
    door: 'run',
    name: 'Managed AI Workers — Growth',
    oneLiner: 'Up to 3 AI workers, with active retraining and biweekly reporting.',
    includes: [
      'Everything in Starter',
      'Active retraining on your data',
      'Biweekly reporting',
      'Priority support',
    ],
    price: '$800/mo',
    status: 'coming_soon',
    cta: 'waitlist',
  },
  {
    slug: 'managed-scale',
    door: 'run',
    name: 'Managed AI Workers — Scale',
    oneLiner: 'Up to 6 AI workers, weekly reporting, monthly strategy check-ins.',
    includes: [
      'Full continuous monitoring',
      'Ongoing retraining + model swapping',
      'Weekly reporting',
      'Monthly strategy check-ins',
    ],
    price: '$1,200/mo',
    status: 'coming_soon',
    cta: 'waitlist',
  },
  {
    slug: 'private-ai-setup',
    door: 'run',
    name: 'Private AI Setup',
    oneLiner: 'A private, locally-run AI stack inside your own environment. Coming soon.',
    includes: [
      'Local model deployment',
      'Your data, your hardware',
      'Access controls',
      'Managed monthly',
    ],
    price: 'contact',
    status: 'coming_soon',
    cta: 'waitlist',
  },
  {
    slug: 'ai-risk-review',
    door: 'run',
    name: 'AI Risk Review',
    oneLiner: 'A structured review of AI risks across your business. Coming soon.',
    includes: [
      'Risk register',
      'Mitigation recommendations',
      'Written report',
    ],
    price: 'contact',
    status: 'coming_soon',
    cta: 'waitlist',
  },
  {
    slug: 'healthcare-ai-guidance',
    door: 'run',
    name: 'Healthcare AI Guidance',
    oneLiner: 'Non-clinical operational guidance on AI in healthcare businesses. Coming soon.',
    includes: [
      'Non-clinical operational scope',
      'No PHI handled',
      'Written recommendations',
    ],
    price: 'contact',
    status: 'coming_soon',
    cta: 'waitlist',
  },
]

export const DOOR_META: Record<ServiceDoor, { title: string; subtitle: string; note?: string }> = {
  plan: {
    title: 'Plan it',
    subtitle: 'Figure out where AI actually pays off in your business — with a written plan you can hand to anyone.',
  },
  build: {
    title: 'Build it',
    subtitle: 'We set up the AI workers you need, inside the tools you already use.',
    note: 'Everything is built inside your own accounts. You own it all.',
  },
  train: {
    title: 'Train your team',
    subtitle: 'Live cohort courses, workshops, and briefings so your team can run AI themselves.',
  },
  run: {
    title: 'Run it for me',
    subtitle: 'Managed AI workers — monitored, retrained, and reported on every month.',
  },
}

export function servicesFor(door: ServiceDoor): Service[] {
  return SERVICES.filter(s => s.door === door)
}
