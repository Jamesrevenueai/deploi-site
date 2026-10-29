import { requireSession } from '@/lib/auth'

export const metadata = { title: 'No store connected' }
export const dynamic = 'force-dynamic'

/** A signed-in account that is not linked to a store organization (for example one from before the agent product). */
export default async function NoStore() {
  const s = await requireSession()
  return (
    <main className="mx-auto flex min-h-screen max-w-[560px] flex-col justify-center gap-4 px-4">
      <h1 className="text-[1.6rem]">No store is linked to this account</h1>
      <p className="text-[15px] text-grey">You are signed in as {s.email}, but this account is not linked to an online store, so there is nothing to show yet. Deploi now runs AI agents for online stores. If you expected to see your store here, write to <a className="text-ink underline" href="mailto:hello@getdeploi.com">hello@getdeploi.com</a>.</p>
      <form action="/logout" method="post"><button type="submit" className="btn ghost sm">Sign out</button></form>
    </main>
  )
}
