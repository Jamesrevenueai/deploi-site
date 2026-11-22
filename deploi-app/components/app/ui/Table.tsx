import type { ReactNode } from 'react'

/**
 * A table that scrolls sideways inside its own box on narrow screens (the page itself never scrolls sideways).
 * The box is a focusable, labelled region so keyboard users can scroll it too.
 */
export function Table({ label, minWidth = 780, children, testId }: { label: string; minWidth?: number; children: ReactNode; testId?: string }) {
  return (
    <div className="app-table-wrap" role="region" aria-label={label} tabIndex={0} data-testid={testId}>
      <table className="app-table" style={{ minWidth }}>{children}</table>
    </div>
  )
}
