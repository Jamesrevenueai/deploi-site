import Link from 'next/link'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'text'
type Common = { variant?: ButtonVariant; className?: string; children: ReactNode }
type AsLink = Common & { href: string; 'aria-label'?: string; prefetch?: boolean }
type AsButton = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { href?: undefined }

const cls = (variant: ButtonVariant, extra?: string) => `app-btn app-btn--${variant}${extra ? ` ${extra}` : ''}`

/**
 * The app's button: primary (#14141F, white text), secondary (white, 1px #E3E3EC) or text (a link-styled button).
 * Radius 12, at least 44px tall. With `href` it renders a link, otherwise a real <button> (type="button" by default).
 */
export function Button(props: AsLink | AsButton) {
  const variant = props.variant ?? 'primary'
  if (props.href !== undefined) {
    const { href, children, className, prefetch } = props
    return <Link href={href} prefetch={prefetch} className={cls(variant, className)} aria-label={props['aria-label']}>{children}</Link>
  }
  const { variant: _v, className, children, type, ...rest } = props
  void _v
  return <button type={type ?? 'button'} className={cls(variant, className)} {...rest}>{children}</button>
}
