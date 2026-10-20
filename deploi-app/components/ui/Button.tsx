import Link from 'next/link'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'
type Size = 'md' | 'sm' | 'xs'
type Props = {
  variant?: Variant
  size?: Size
  href?: string
  external?: boolean
  children: ReactNode
  className?: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>

/** Black Glass button. Exactly one `primary` per viewport. */
export function Button({ variant = 'primary', size = 'md', href, external, children, className = '', ...rest }: Props) {
  const cls = `btn ${variant === 'primary' ? '' : variant} ${size === 'md' ? '' : size} ${className}`.replace(/\s+/g, ' ').trim()
  if (href) {
    if (external) return <a href={href} className={cls} target="_blank" rel="noopener noreferrer">{children}</a>
    return <Link href={href} className={cls}>{children}</Link>
  }
  return <button className={cls} {...rest}>{children}</button>
}
