import Link from 'next/link'
import { Banner } from '@/components/ui/Banner'
import type { Readiness } from '@/lib/setup/readiness'

export function SetupBanner({ readiness }: { readiness: Readiness }) {
  if (readiness.incomplete === 0) return null
  return (
    <div className="mb-5">
      <Banner tone="warn" icon="spark">
        <strong>Setup incomplete: {readiness.incomplete} {readiness.incomplete === 1 ? 'item' : 'items'}.</strong>{' '}
        <Link href="/staff/setup" className="underline text-ink">Open setup</Link>
      </Banner>
    </div>
  )
}
