/** Shape of the signed-in user as the app sees it. Shared by both auth modes. */
export type Role = 'staff' | 'client'
export type Session = {
  uid: string
  email: string
  role: Role
  agencyId: string | null
  fullName?: string | null
}
