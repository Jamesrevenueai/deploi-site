import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Banner({ children, tone = 'info', icon = 'alert' }: { children: ReactNode; tone?: 'info' | 'warn'; icon?: IconName | string }) {
  return (
    <div className={`banner ${tone === 'warn' ? 'warn' : ''}`} role="status">
      <Icon name={icon} size={18} className="mt-0.5 shrink-0 text-ink" />
      <div>{children}</div>
    </div>
  )
}
