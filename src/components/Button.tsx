import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { env } from '../lib/env'

type Props = {
  children: ReactNode
  variant?: 'primary' | 'ghost'
  size?: 'sm'
  className?: string
}

/**
 * The "Book a call" CTA. Links straight to VITE_BOOKING_URL (new tab) when it
 * is set, otherwise scrolls to the on-page form at #book.
 */
export function BookButton({ children, variant = 'primary', size, className = '' }: Props) {
  const cls = `btn btn-${variant} ${size ?? ''} ${className}`.trim()
  if (env.bookingUrl) {
    return (
      <a href={env.bookingUrl} className={cls} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  }
  return (
    <Link to="/#book" className={cls}>
      {children}
    </Link>
  )
}
