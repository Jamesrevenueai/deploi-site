/** Shape of the signed-in user as the app sees it. Shared by both auth modes. */
export type Role = 'staff' | 'client'
export type Session = {
  uid: string
  email: string
  role: Role
  agencyId: string | null
  fullName?: string | null
  /** 'merchant' for store owners; anything else is an account with no store (it sees /no-store) */
  orgType?: string | null
}

/** Where a signed-in user lands. */
export function homeFor(s: Pick<Session, 'role' | 'orgType'>): string {
  if (s.role === 'staff') return '/staff/early-access'
  return s.orgType === 'merchant' ? '/store' : '/no-store'
}
