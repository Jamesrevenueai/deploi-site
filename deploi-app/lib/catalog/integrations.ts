/**
 * Integration inventory with honest levels. A vendor name here is a compatibility statement,
 * never a partnership claim.
 */
export type IntegrationLevel = 'csv_compatible' | 'api_implemented' | 'production_verified' | 'formal_partnership' | 'planned'

export const INTEGRATION_LEVEL_LABEL: Record<IntegrationLevel, string> = {
  csv_compatible: 'CSV / file compatible',
  api_implemented: 'API integration implemented, not verified in production',
  production_verified: 'Verified in production',
  formal_partnership: 'Formal vendor partnership',
  planned: 'Planned',
}

export type Integration = { key: string; name: string; kind: 'evv' | 'email' | 'sms' | 'payments' | 'outreach' | 'auth' | 'storage'; level: IntegrationLevel; note: string }

export const INTEGRATIONS: Integration[] = [
  { key: 'sandata', name: 'Sandata EVV', kind: 'evv', level: 'csv_compatible', note: 'Visit Maintenance CSV export with a column preset. Live connector is a stub (NotImplemented) behind the discovery-call gate.' },
  { key: 'alayacare', name: 'AlayaCare', kind: 'evv', level: 'csv_compatible', note: 'Generic CSV mapper. Live connector is a stub.' },
  { key: 'hhaexchange', name: 'HHAeXchange', kind: 'evv', level: 'csv_compatible', note: 'Generic CSV mapper. Live connector is a stub.' },
  { key: 'wellsky', name: 'WellSky', kind: 'evv', level: 'csv_compatible', note: 'Generic CSV mapper. Live connector is a stub.' },
  { key: 'resend', name: 'Resend (email)', kind: 'email', level: 'api_implemented', note: 'Mock adapter until RESEND_API_KEY is set and a test send is verified from /staff/setup.' },
  { key: 'twilio', name: 'Twilio (SMS)', kind: 'sms', level: 'api_implemented', note: 'Mock adapter until credentials and a verified A2P 10DLC campaign exist.' },
  { key: 'stripe', name: 'Stripe (payments)', kind: 'payments', level: 'planned', note: 'Mock payment adapter only. No charges are possible from this application.' },
  { key: 'smartlead', name: 'Smartlead (outbound email)', kind: 'outreach', level: 'api_implemented', note: 'Inbound webhook for reply events. Sales data only.' },
  { key: 'supabase', name: 'Supabase (Postgres, Auth, Storage)', kind: 'auth', level: 'api_implemented', note: 'Production project exists; a BAA with the hosting provider is a prerequisite before real PHI.' },
]
