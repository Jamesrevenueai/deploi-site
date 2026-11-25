import { Button } from '@/components/app/ui'

/** /agents/:id for an id that is not one of this organization's agents (served with a 404 status). */
export default function AgentNotFound() {
  return (
    <div className="flex w-full max-w-[640px] flex-col gap-3 py-8 text-[#2A2A3A]">
      <h1 className="app-h1">Agent not found</h1>
      <p className="m-0 text-[15px] text-[#5C5C70]">There is no agent with this address on your team. It may have been removed, or the link is from another account.</p>
      <div><Button href="/store">Back to the command center</Button></div>
    </div>
  )
}
