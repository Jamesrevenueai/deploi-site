/** Shape of the signed-in user as the app sees it. Shared by both auth modes. */
export type Role = 'staff' | 'client'
export type Session = {
  uid: string
  email: string
  role: Role
  agencyId: string | null
  fullName?: string | null
  /** 'merchant' for subscription-product customers; 'care_agency' for the earlier service clients */
  orgType?: 'merchant' | 'care_agency' | null
}

/** Where a signed-in user lands. */
export function homeFor(s: Pick<Session, 'role' | 'orgType'>): string {
  if (s.role === 'staff') return '/staff/pipeline'
  return s.orgType === 'merchant' ? '/store' : '/app/home'
}
