import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

type Props = {
  children?: ReactNode
  variant?: 'primary' | 'ghost'
  size?: 'sm'
  className?: string
}

export const CTA_LABEL = 'Apply for a paid pilot'
export const CTA_HREF = '/signup#early-access'

/** The primary call to action: goes to the pilot application (the early access form) on the sign-up page. */
export function CtaButton({ children = CTA_LABEL, variant = 'primary', size, className = '' }: Props) {
  const cls = `btn btn-${variant} ${size ?? ''} ${className}`.trim()
  return (
    <Link to={CTA_HREF} className={cls}>
      {children}
    </Link>
  )
}
