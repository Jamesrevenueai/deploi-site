import Link from 'next/link'
import type { ReactNode } from 'react'
import { GlassPill, GlassFacts } from './GlassPill'
import type { IconName } from './Icon'

type Props = {
  tag?: string
  tagIcon?: IconName | string
  tagMuted?: boolean
  title: ReactNode
  body?: ReactNode
  facts?: { icon?: IconName | string; label: string }[]
  href?: string
  bordered?: boolean
  /** keep 16:9 (default) or let content size the card */
  ratio?: '16/9' | 'auto'
  className?: string
}

/** Full-bleed image card: brushed-metal ground, glass tag, big title, glass facts row. */
export function ImageCard({ tag, tagIcon, tagMuted, title, body, facts, href, bordered, ratio = '16/9', className = '' }: Props) {
  const inner = (
    <div className={`metal ${bordered ? 'ring-1 ring-white' : ''} ${className}`} style={ratio === '16/9' ? { aspectRatio: '16 / 9' } : undefined}>
      <div className="absolute inset-0 flex flex-col justify-between p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          {tag ? <GlassPill icon={tagIcon} muted={tagMuted}>{tag}</GlassPill> : <span />}
        </div>
        <div className="flex flex-col gap-3">
          <div className="card-title">{title}</div>
          {body && <p className="text-grey text-[15px] md:text-[17px] max-w-[52ch]">{body}</p>}
          {facts && facts.length > 0 && <div><GlassFacts facts={facts} /></div>}
        </div>
      </div>
    </div>
  )
  if (href) return <Link href={href} className="card">{inner}</Link>
  return <div className="card">{inner}</div>
}
