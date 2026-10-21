import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { env } from '../lib/env'

type Props = {
  children: ReactNode
  variant?: 'primary' | 'ghost'
  size?: 'sm'
  className?: string
}

/** The CTA wording: a calendar link reads "Book a call"; the on-page form is a discovery request. */
export function bookCtaLabel(short = false): string {
  if (env.bookingUrl) return 'Book a call'
  return short ? 'Request a conversation' : 'Request a discovery conversation'
}

/**
 * The primary CTA. Links straight to VITE_BOOKING_URL (new tab) when it
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
