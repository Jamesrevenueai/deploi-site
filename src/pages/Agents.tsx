import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { AgentCharacter } from '../components/AgentCharacter'
import { AGENTS, TIERS, lowestTierFor } from '../lib/library'

export const AGENTS_TITLE = `Agents — ${BRAND}`
export const AGENTS_DESCRIPTION = 'Twelve agents for your Shopify store, each with one job: orders, returns, listings, inventory, suppliers, customer replies, campaigns, promotions, weekly insights, payouts and fees, store health and AI shopping visibility. Every agent starts in draft-for-approval. Early access.'

export default function Agents() {
  useSeo({ title: AGENTS_TITLE, description: AGENTS_DESCRIPTION })
  return (
    <div className="page agents-page">
      <div className="container">
        <div className="section-head reveal" style={{ textAlign: 'center' }}>
          <span className="eyebrow">The agent library</span>
          <h1 className="two-tone">
            <span className="grey">Twelve agents.</span><br />
            <span className="white">Each with one job.</span>
          </h1>
          <p className="lead">
            Switch an agent on and it starts in draft-for-approval: it reads your store, drafts what it would do, and waits for you.
            Grant auto-run per action type once you trust it. Money actions and live publishing always wait for your approval.
            Early access: tested on a synthetic store, not yet in the Shopify App Store.
          </p>
        </div>
        <ul className="agent-grid" aria-label="Agents">
          {AGENTS.map(a => {
            const tier = lowestTierFor(a.key)
            return (
              <li key={a.key} className="agent-card reveal" data-agent={a.key}>
                <div className="agent-card-head">
                  <AgentCharacter agentKey={a.key} hue={a.character.hue} shape={a.character.shape} label={`${a.name} character`} />
                  <div>
                    <h2>{a.name}</h2>
                    <p className="agent-tag">{a.tagline}</p>
                  </div>
                </div>
                <p className="agent-body">{a.description}</p>
                <div className="agent-example"><span className="agent-label">Example task</span><p>&ldquo;{a.exampleTask}&rdquo;</p></div>
                <div className="agent-foot">
                  <span className={`tier-pill tier-${tier?.key ?? 'pro'}`}>Included from {tier?.name ?? 'Pro'}</span>
                  <span className="agent-status">{a.status === 'existing' ? 'Available in early access' : 'New in the library'}</span>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="agents-tiers reveal">
          <h2 className="two-tone"><span className="grey">Which plan</span> <span className="white">includes which agents</span></h2>
          <p className="lead">The plan you choose decides which agents you can switch on. Locked agents still show in your library, with an Upgrade button.</p>
          <div className="tier-row">
            {TIERS.map(t => (
              <div key={t.key} className="tier-mini">
                <div className="tier-mini-name">{t.name}</div>
                <div className="tier-mini-count">{t.agents.length} agents{t.buildYourOwn ? ' + build your own' : ''}</div>
                <div className="tier-mini-actions">{t.monthlyActions} actions a month included</div>
              </div>
            ))}
          </div>
          <div className="page-actions" style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/pricing" className="btn btn-ghost">See pricing</Link>
            <CtaButton />
          </div>
        </div>
      </div>
    </div>
  )
}
