export type Tool = {
  category: string
  name: string
  job: string
  /** TODO: swap in affiliate links later. */
  url: string
}

export const TOOL_CATEGORY_ORDER = [
  'Everyday assistant',
  'Research',
  'Automation',
  'Meetings & notes',
  'Chat & support',
  'Phone',
  'CRM & email',
  'Design & writing',
  'Video',
  'Scheduling',
  'Bookkeeping',
] as const

export const TOOLS: Tool[] = [
  /* Everyday assistant */
  { category: 'Everyday assistant', name: 'ChatGPT', job: 'General-purpose chat assistant.', url: 'https://chat.openai.com' },
  { category: 'Everyday assistant', name: 'Claude', job: 'General-purpose chat assistant with long context.', url: 'https://claude.ai' },
  { category: 'Everyday assistant', name: 'Google Gemini', job: 'General-purpose chat inside Google Workspace.', url: 'https://gemini.google.com' },
  { category: 'Everyday assistant', name: 'Microsoft Copilot', job: 'General-purpose chat inside Microsoft 365.', url: 'https://copilot.microsoft.com' },

  /* Research */
  { category: 'Research', name: 'Perplexity', job: 'AI search with cited sources.', url: 'https://www.perplexity.ai' },

  /* Automation */
  { category: 'Automation', name: 'Zapier', job: 'No-code automation between apps.', url: 'https://zapier.com' },
  { category: 'Automation', name: 'Make', job: 'Visual, more advanced automation.', url: 'https://www.make.com' },
  { category: 'Automation', name: 'n8n', job: 'Self-hosted or cloud automation for teams that want control.', url: 'https://n8n.io' },

  /* Meetings & notes */
  { category: 'Meetings & notes', name: 'Fathom', job: 'Records + summarizes video meetings.', url: 'https://fathom.video' },
  { category: 'Meetings & notes', name: 'Otter', job: 'Live transcription + notes.', url: 'https://otter.ai' },

  /* Chat & support */
  { category: 'Chat & support', name: 'Tidio', job: 'Website chat + AI replies.', url: 'https://www.tidio.com' },
  { category: 'Chat & support', name: 'Freshdesk', job: 'Help desk with AI-assisted replies.', url: 'https://www.freshworks.com/freshdesk/' },

  /* Phone */
  { category: 'Phone', name: 'Dialpad', job: 'Business phone with AI transcription + summaries.', url: 'https://www.dialpad.com' },
  { category: 'Phone', name: 'Nextiva', job: 'Business phone system with AI features.', url: 'https://www.nextiva.com' },

  /* CRM & email */
  { category: 'CRM & email', name: 'HubSpot', job: 'CRM + email + marketing, free tier available.', url: 'https://www.hubspot.com' },

  /* Design & writing */
  { category: 'Design & writing', name: 'Canva', job: 'Design tool with AI image + copy features.', url: 'https://www.canva.com' },
  { category: 'Design & writing', name: 'Grammarly', job: 'Writing polish + tone control.', url: 'https://www.grammarly.com' },

  /* Video */
  { category: 'Video', name: 'HeyGen', job: 'Talking-head videos from a script.', url: 'https://www.heygen.com' },
  { category: 'Video', name: 'Descript', job: 'Edit video like a text document.', url: 'https://www.descript.com' },

  /* Scheduling */
  { category: 'Scheduling', name: 'Calendly', job: 'Booking links + calendar automation.', url: 'https://calendly.com' },
  { category: 'Scheduling', name: 'Motion', job: 'AI schedules your calendar around priorities.', url: 'https://www.usemotion.com' },

  /* Bookkeeping */
  { category: 'Bookkeeping', name: 'QuickBooks', job: 'Small-business bookkeeping with AI categorization.', url: 'https://quickbooks.intuit.com' },
]

export function toolsByCategory(): { category: string; tools: Tool[] }[] {
  return TOOL_CATEGORY_ORDER.map(category => ({
    category,
    tools: TOOLS.filter(t => t.category === category),
  }))
}
