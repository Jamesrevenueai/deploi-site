import type { ReactNode } from 'react'

export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between fade-up">
      <div className="flex flex-col gap-2">
        {eyebrow && <div className="text-sm text-grey-h">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <p className="text-grey max-w-[60ch]">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
