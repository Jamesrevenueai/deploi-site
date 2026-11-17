import { previewCrewLink } from '@/lib/notify/crew'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Mark a job done · Deploi', robots: { index: false } }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md fade-up">
        <div className="wordmark mb-10 text-center">deploi</div>
        <div className="panel p-6 md:p-8"><div className="flex flex-col gap-5" data-testid="crew-done">{children}</div></div>
      </div>
    </main>
  )
}

const TITLE = {
  used: 'This job is already marked done', expired: 'This link has expired', invalid: 'This link is not valid', closed: 'This job is no longer open',
} as const
const BODY = {
  used: 'Nothing more to do. Thank you.', expired: 'Links work for a limited time. Reply DONE and the job number to your message instead, or tell the person who manages your work.',
  invalid: 'It may have been cut short or changed. Nothing was changed.', closed: 'It was cancelled, or you are no longer on this crew. Nothing was changed.',
} as const

/**
 * A crew member's one-time "Mark done" link (/crew/done/<token>), no sign-in. Opening it only shows the job;
 * the button posts to /api/crew/done, which uses the link once and marks the job done.
 */
export default async function CrewDonePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params
  const sp = await searchParams
  const s = await previewCrewLink(decodeURIComponent(token))
  if (sp.r === 'done' && s.state === 'used') {
    return <Shell><h1 className="text-[22px]">Marked done. Thank you{s.crewName ? `, ${s.crewName}` : ''}.</h1><p className="text-grey">Job {s.jobRef} is recorded as finished{s.orgName ? ` for ${s.orgName}` : ''}. You can close this page.</p></Shell>
  }
  if (s.state !== 'ready') return <Shell><h1 className="text-[22px]">{TITLE[s.state]}</h1><p className="text-grey">{BODY[s.state]}</p></Shell>
  return (
    <Shell>
      <h1 className="text-[22px]">Finished job {s.jobRef}?</h1>
      {s.address && <p className="text-grey">{s.address}</p>}
      {sp.r === 'error' && <Banner tone="warn">That did not go through. Try again in a minute.</Banner>}
      <form method="post" action="/api/crew/done">
        <input type="hidden" name="t" value={decodeURIComponent(token)} />
        <Button type="submit">Yes, mark it done</Button>
      </form>
      <p className="text-[13px] text-grey-h">The link works once. {s.orgName ? `${s.orgName} is told right away.` : 'The business is told right away.'}</p>
    </Shell>
  )
}
