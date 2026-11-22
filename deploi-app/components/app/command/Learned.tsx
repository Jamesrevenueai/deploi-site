import type { Learned as Data } from '@/lib/app/contract'
import { Button } from '@/components/app/ui'

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/**
 * "What your team learned": what Deploi read of the business the last time it looked, what it found, and the
 * agents and packs it set up by itself. Null (never read) shows how it starts instead of numbers.
 */
export function Learned({ data }: { data: Data | null }) {
  if (!data) {
    return (
      <section className="learned" aria-labelledby="learned-title" data-testid="learned-empty">
        <h2 className="app-h2" id="learned-title">What your team learned</h2>
        <p className="learned-line">Nothing read yet. Connect your store, inbox, CRM or books: Deploi reads your business on its own, sets up the agents it needs and they start on the work. You approve or reject what needs you.</p>
        <div><Button href="/store/integrations">Connect a system</Button></div>
      </section>
    )
  }
  const secs = data.seconds
  return (
    <section className="learned" aria-labelledby="learned-title" data-testid="learned">
      <div className="learned-head">
        <h2 className="app-h2" id="learned-title">What your team learned</h2>
        <a className="app-link" href="/store/discover">See everything it read</a>
      </div>
      <p className="learned-line" data-testid="learned-line">
        Read {data.read.length ? list(data.read) : 'your business'} in {secs < 1 ? 'under a second' : secs < 60 ? `${secs} second${secs === 1 ? '' : 's'}` : `${Math.round(secs / 60)} min`}:
        {' '}{data.findings} thing{data.findings === 1 ? '' : 's'} found, {data.casesOpened} handed to the team
        {data.agentsCreated ? `, ${data.agentsCreated} agent${data.agentsCreated === 1 ? '' : 's'} set up by Deploi` : ''}.
        {data.packs.length ? ` ${data.inferred ? 'Deploi chose' : 'On'}: ${list(data.packs)}.` : ''}
      </p>
      {data.facts.length > 0 && (
        <ul className="learned-facts" aria-label="What it read">
          {data.facts.map(f => <li key={f.label}><span className="v">{f.value}</span><span className="k">{f.label}</span></li>)}
        </ul>
      )}
      {data.notRead.length > 0 && <p className="learned-miss">Not read: {data.notRead.map(n => `${n.label} (${n.reason})`).join('; ')}</p>}
    </section>
  )
}
