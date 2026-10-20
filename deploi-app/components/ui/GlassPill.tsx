import { Icon, type IconName } from './Icon'
import type { ReactNode } from 'react'

export function GlassPill({ icon, children, muted, className = '' }: { icon?: IconName | string; children: ReactNode; muted?: boolean; className?: string }) {
  return (
    <span className={`glass ${muted ? 'muted' : ''} ${className}`}>
      {icon && <Icon name={icon} size={15} />}
      {children}
    </span>
  )
}

export function GlassFacts({ facts }: { facts: { icon?: IconName | string; label: string }[] }) {
  return (
    <span className="glass">
      {facts.map((f, i) => (
        <span key={f.label} className="inline-flex items-center gap-2">
          {i > 0 && <span className="divider" aria-hidden="true" />}
          {f.icon && <Icon name={f.icon} size={15} />}
          {f.label}
        </span>
      ))}
    </span>
  )
}
