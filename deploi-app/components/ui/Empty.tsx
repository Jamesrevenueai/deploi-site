import type { ReactNode } from 'react'
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[20px] border border-line p-8 text-center">
      <div className="text-ink font-medium">{title}</div>
      {children && <div className="mt-2 text-grey text-[15px]">{children}</div>}
    </div>
  )
}
