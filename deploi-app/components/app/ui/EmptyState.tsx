import type { ReactNode } from 'react'

/** An honest empty state: what is (not) there yet, and what to do about it. Never placeholder rows. */
export function EmptyState({ title, children, action, testId }: { title: string; children?: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="app-empty" role="status" data-testid={testId}>
      <p className="app-empty-title">{title}</p>
      {children && <p className="app-empty-body">{children}</p>}
      {action && <div className="app-empty-action">{action}</div>}
    </div>
  )
}
