import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { art, type ArtTheme } from '../lib/art'

type Fact = { icon: ReactNode; label: string }

type Props = {
  tag: ReactNode
  tagIcon?: ReactNode
  tagMuted?: boolean
  title: ReactNode
  body?: ReactNode
  facts?: [Fact, Fact]
  featured?: boolean
  /** generated artwork theme for the card ground */
  art?: ArtTheme
  to?: string
  className?: string
  children?: ReactNode
}

/**
 * Black Glass image card: 16:9, 20px radius, generated brushed-metal ground,
 * glass tag top-left, white title bottom-left, optional two-fact glass pill row.
 */
export function ImageCard({ tag, tagIcon, tagMuted, title, body, facts, featured, art: theme, to, className = '', children }: Props) {
  const cls = `icard ${featured ? 'featured' : ''} ${className}`.trim()
  const style = theme ? { backgroundImage: art(theme) } : undefined
  const inner = (
    <>
      <div className="icard-top">
        <span className={`pill ${tagMuted ? 'muted' : ''}`}>{tagIcon}{tag}</span>
      </div>
      {children ?? (
        <div className="icard-bottom">
          <div className="icard-title">{title}</div>
          {body && <div className="icard-body">{body}</div>}
          {facts && (
            <div className="pill pill-row" aria-label="facts">
              <span className="fact">{facts[0].icon}{facts[0].label}</span>
              <span className="divider" aria-hidden="true" />
              <span className="fact">{facts[1].icon}{facts[1].label}</span>
            </div>
          )}
        </div>
      )}
    </>
  )
  if (to) {
    return (
      <Link to={to} className={cls} style={style}>
        {inner}
      </Link>
    )
  }
  return <div className={cls} style={style}>{inner}</div>
}
