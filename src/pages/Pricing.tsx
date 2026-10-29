import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { Icon } from '../lib/icons'
import { AGENTS, TIERS, PRICING_COMING_SOON, tierIncludes } from '../lib/library'

export const PRICING_TITLE = `Pricing — ${BRAND}`
export const PRICING_DESCRIPTION = 'Three plans: Starter, Growth and Pro. Each includes a set of agents and a monthly action allowance, with paid overage. Prices are coming soon; early access is free while we finish.'
export const PRICING_STATUS_LINE = 'Prices coming soon. Early access is free, not yet in the Shopify App Store, and you approve any charge before it applies.'

export default function Pricing() {
  useSeo({ title: PRICING_TITLE, description: PRICING_DESCRIPTION })
  return (
    <div className="page pricing-page">
      <div className="container">
        <div className="section-head reveal" style={{ textAlign: 'center' }}>
          <span className="eyebrow">Pricing</span>
          <h1 className="two-tone">
            <span className="grey">A base fee, an action allowance,</span><br />
            <span className="white">and the agents each plan includes.</span>
          </h1>
          <p className="lead">{PRICING_STATUS_LINE}</p>
        </div>

        <div className="plan-row">
          {TIERS.map(t => (
            <div key={t.key} className={`plan-card reveal ${t.key === 'growth' ? 'featured' : ''}`} data-tier={t.key}>
              <div className="plan-name">{t.name}</div>
              <p className="plan-tag">{t.tagline}</p>
              <div className="plan-price">{PRICING_COMING_SOON ? <span className="au-gradient-text">Coming soon</span> : <>${t.proposedPriceUsd}<small>/month</small></>}</div>
              <ul className="plan-facts">
                <li><strong>{t.monthlyActions}</strong> agent actions a month included</li>
                <li>Overage: {PRICING_COMING_SOON ? 'paid per action, price coming soon' : `$${t.proposedOverageUsd.toFixed(2)} per extra action`}</li>
                <li><strong>{t.agents.length}</strong> of 12 agents{t.buildYourOwn ? ', plus build your own' : ''}</li>
              </ul>
              <ul className="plan-agents">
                {t.agents.map(k => { const a = AGENTS.find(x => x.key === k)!; return <li key={k}><span aria-hidden="true">{a.character.emoji}</span> {a.name}</li> })}
                {t.buildYourOwn && <li><span aria-hidden="true">🛠️</span> Build your own agent (read / draft / act, defaults to read)</li>}
              </ul>
              <CtaButton variant={t.key === 'growth' ? 'primary' : 'ghost'} size="sm" />
            </div>
          ))}
        </div>

        <div className="compare reveal">
          <h2 className="two-tone"><span className="grey">Compare</span> <span className="white">the plans</span></h2>
          <div className="table-wrap">
            <table className="compare-table">
              <caption className="sr-only">Plan comparison</caption>
              <thead><tr><th scope="col">What you get</th>{TIERS.map(t => <th key={t.key} scope="col">{t.name}</th>)}</tr></thead>
              <tbody>
                <tr><th scope="row">Monthly price</th>{TIERS.map(t => <td key={t.key}>{PRICING_COMING_SOON ? 'Coming soon' : `$${t.proposedPriceUsd}`}</td>)}</tr>
                <tr><th scope="row">Included actions a month</th>{TIERS.map(t => <td key={t.key}>{t.monthlyActions}</td>)}</tr>
                <tr><th scope="row">Overage per action</th>{TIERS.map(t => <td key={t.key}>{PRICING_COMING_SOON ? 'Coming soon' : `$${t.proposedOverageUsd.toFixed(2)}`}</td>)}</tr>
                <tr><th scope="row">Agents included</th>{TIERS.map(t => <td key={t.key}>{t.agents.length} of 12</td>)}</tr>
                {AGENTS.map(a => (
                  <tr key={a.key}><th scope="row">{a.name}</th>{TIERS.map(t => <td key={t.key} data-included={tierIncludes(t.key, a.key)}>{tierIncludes(t.key, a.key) ? <span className="yes"><Icon.Check width={16} height={16} /><span className="sr-only">Included</span></span> : <span className="no" aria-label="Not included">–</span>}</td>)}</tr>
                ))}
                <tr><th scope="row">Build your own agent</th>{TIERS.map(t => <td key={t.key}>{t.buildYourOwn ? <span className="yes"><Icon.Check width={16} height={16} /><span className="sr-only">Included</span></span> : <span className="no">–</span>}</td>)}</tr>
                <tr><th scope="row">Draft-for-approval on every agent</th>{TIERS.map(t => <td key={t.key}><span className="yes"><Icon.Check width={16} height={16} /></span></td>)}</tr>
                <tr><th scope="row">Auto-run per action type</th>{TIERS.map(t => <td key={t.key}><span className="yes"><Icon.Check width={16} height={16} /></span></td>)}</tr>
                <tr><th scope="row">Weekly summary of time and money saved</th>{TIERS.map(t => <td key={t.key}><span className="yes"><Icon.Check width={16} height={16} /></span></td>)}</tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 20 }}>An action is one thing an agent reports, drafts or does: one flagged order, one drafted reply, one verified change. The weekly summary and the activity log show every one.</p>
          <p className="muted" style={{ marginTop: 8 }}>Private beta is free for up to five stores. See the <Link to="/agents">agents</Link>.</p>
        </div>
      </div>
    </div>
  )
}
