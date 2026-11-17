import type { ReactNode } from 'react'
import { STATUS_WORDS, shownStatus, type IntegrationEntry } from '../lib/site-config'

/** Page opening: eyebrow, one headline, a lead and optional actions. */
export function PageHero({ eyebrow, title, lead, children }: { eyebrow: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className="hero">
      <div className="container">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children && <div className="hero-actions">{children}</div>}
      </div>
    </header>
  )
}

export function Section({ id, title, lead, children, tone }: { id?: string; title?: ReactNode; lead?: ReactNode; children: ReactNode; tone?: 'alt' }) {
  return (
    <section id={id} className={`section ${tone === 'alt' ? 'section-alt' : ''}`}>
      <div className="container">
        {(title || lead) && <div className="section-head">{title && <h2>{title}</h2>}{lead && <p className="lead">{lead}</p>}</div>}
        {children}
      </div>
    </section>
  )
}

export function Cards({ items, cols = 3 }: { items: { title: string; body: ReactNode; tag?: ReactNode }[]; cols?: 2 | 3 | 4 }) {
  return (
    <ul className={`cards cols-${cols}`}>
      {items.map(i => (
        <li key={i.title} className="card">
          {i.tag && <div className="card-tag">{i.tag}</div>}
          <h3>{i.title}</h3>
          <p>{i.body}</p>
        </li>
      ))}
    </ul>
  )
}

/** Integration status as the site shows it (site-config.shownStatus: Available only when live-verified). */
export function IntegrationStatusBadge({ i }: { i: Pick<IntegrationEntry, 'key' | 'status'> }) {
  const s = shownStatus(i)
  return <span className={`status status-${s}`} data-status={s}><span className="status-dot" aria-hidden="true" />{STATUS_WORDS[s].label}</span>
}

export function Steps({ steps }: { steps: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="steps">
      {steps.map((s, n) => (
        <li key={s.title} className="step"><span className="step-n" aria-hidden="true">{n + 1}</span><div><h3>{s.title}</h3><p>{s.body}</p></div></li>
      ))}
    </ol>
  )
}
