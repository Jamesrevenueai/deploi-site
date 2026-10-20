import Link from 'next/link'
import { Icon, type IconName } from './Icon'
import type { ReactNode } from 'react'

type Props = { label: string; value: ReactNode; sub?: ReactNode; href?: string; icon?: IconName | string; tone?: 'ok' | 'warn' | 'danger' | 'none'; children?: ReactNode }

/** Dashboard tile in the image-card style. Links to its list page. */
export function Tile({ label, value, sub, href, icon, tone = 'none', children }: Props) {
  const toneCls = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : ''
  const inner = (
    <div className="metal tile h-full">
      <div className="relative flex h-full flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="tile-label">{label}</span>
          {icon && <span className="glass" style={{ padding: '6px 10px' }}><Icon name={icon} size={15} /></span>}
        </div>
        <div className={`tile-value ${toneCls}`}>{value}</div>
        {sub && <div className="tile-sub">{sub}</div>}
        {children}
        {href && <span className="mt-auto inline-flex items-center gap-1 text-sm text-ink">Open <Icon name="arrow-right" size={14} /></span>}
      </div>
    </div>
  )
  return href ? <Link href={href} className="card block h-full">{inner}</Link> : inner
}
