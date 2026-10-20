import type { ReactNode } from 'react'
export function Badge({ children, tone = 'none' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'none' }) {
  return <span className={`badge ${tone === 'none' ? '' : tone}`}>{children}</span>
}
