import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { actorRole } from '@/lib/platform/rbac'
import { previewUndo } from '@/lib/undo/run'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { confirmUndoAction } from './actions'
import { undoActorFor } from './actor'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Undo a change · Deploi AI', robots: { index: false } }

const ERROR_TEXT: Record<string, string> = {
  'not-allowed': 'Only an owner or admin of this business can undo a change.',
  forbidden: 'Only an owner or admin of this business can undo a change.',
  not_pending: 'This change was already undone.',
  expired: 'This undo link has expired.',
  not_found: 'This undo link is not valid.',
  not_retryable: 'The change could not be undone right now. Nothing was lost; try again in a few minutes.',
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md fade-up">
        <div className="wordmark mb-10 text-center">deploi <span className="text-grey-h">ai</span></div>
        <div className="panel p-6 md:p-8"><div className="flex flex-col gap-5" data-testid="undo">{children}</div></div>
        <p className="mt-6 text-center text-[13px] text-grey-h">Questions? hello@getdeploi.com</p>
      </div>
    </main>
  )
}

/**
 * Undo one change an agent made (/undo/<token>, linked from the owner's update). Signed-in owners and admins of
 * the business only; the page shows what will be reversed, and the button reverses it once.
 */
export default async function UndoPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params
  const sp = await searchParams
  const s = await getSession()
  if (!s) redirect('/login')
  const actor = undoActorFor(s)
  const p = actor ? await previewUndo(actor, token) : null
  const role = actor && p && p.state !== 'not_found' ? await actorRole(actor, actor.orgId) : null
  const error = sp.error ? ERROR_TEXT[sp.error] ?? 'Something went wrong.' : null

  if (!actor || !p || p.state === 'not_found') {
    return <Shell><h1 className="text-2xl" data-state="not_found">This undo link is not valid</h1><p className="text-[15px] text-grey">It may belong to another business, or it was copied incompletely. Sign in as the owner of the business the update was for.</p><Button href="/store" variant="ghost">Go to Deploi</Button></Shell>
  }
  const caseLink = p.caseRef ? <a className="underline" href={`/store/work/${p.caseRef}`}>{p.caseRef}</a> : null
  if (p.state === 'used') {
    return (
      <Shell>
        <h1 className="text-2xl" data-state="used">{p.result?.ok === false ? 'This change could not be undone' : 'Done: the change was undone'}</h1>
        <p className="text-[15px] text-grey">{p.summary}</p>
        {p.result?.detail && <Banner tone={p.result.ok ? 'info' : 'warn'} icon={p.result.ok ? 'check' : 'alert'}>{p.result.detail}</Banner>}
        {caseLink && <p className="text-[14px] text-grey">Recorded on case {caseLink}.</p>}
        <Button href="/store/work" variant="ghost">See your agents&apos; work</Button>
      </Shell>
    )
  }
  if (p.state === 'expired') {
    return <Shell><h1 className="text-2xl" data-state="expired">This undo link has expired</h1><p className="text-[15px] text-grey">{p.summary}</p>{caseLink && <p className="text-[14px] text-grey">You can still see what happened on case {caseLink}.</p>}</Shell>
  }
  const allowed = role === 'owner' || role === 'admin'
  return (
    <Shell>
      <div>
        <div className="eyebrow pb-2">Undo a change</div>
        <h1 className="text-2xl" data-state="ready">{p.summary || 'Undo this change'}</h1>
      </div>
      <p className="text-[15px] text-grey">Your agent made this change{p.createdAt ? ` on ${new Date(p.createdAt).toLocaleString()}` : ''}. Undoing puts it back the way it was before. This link works once{p.expiresAt ? ` and until ${new Date(p.expiresAt).toLocaleDateString()}` : ''}.</p>
      {caseLink && <p className="text-[14px] text-grey">Case {caseLink}</p>}
      {error && <Banner tone="warn">{error}</Banner>}
      {allowed
        ? <form action={confirmUndoAction}><input type="hidden" name="token" value={token} /><Button type="submit" variant="danger">Yes, undo this change</Button></form>
        : <Banner tone="warn">Only an owner or admin of this business can undo a change. Ask one of them to open this link.</Banner>}
    </Shell>
  )
}
