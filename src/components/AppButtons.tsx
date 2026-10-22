import { appLinks } from '../lib/env'

type Props = { size?: 'sm'; className?: string; onClick?: () => void }

/** "Sign in" opens the app login; same tab, it is the same product. */
export function SignInButton({ size, className = '', onClick }: Props) {
  return (
    <a href={appLinks().signIn} className={`btn btn-ghost ${size ?? ''} ${className}`.trim()} onClick={onClick}>
      Sign in
    </a>
  )
}

/** "Get started" opens the app signup / waitlist. */
export function GetStartedButton({ size, className = '', onClick }: Props) {
  return (
    <a href={appLinks().getStarted} className={`btn btn-primary ${size ?? ''} ${className}`.trim()} onClick={onClick}>
      Get started
    </a>
  )
}
