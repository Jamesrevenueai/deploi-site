import { useState } from 'react'
import { Link } from 'react-router-dom'
import { css } from '../lib/css'
import { BUNDLE_TEXT, OVERAGE, plansFor, type Product } from '../lib/pricing'
import { TRIAL_HREF } from './Nav'

const TAB_ON = 'min-height:44px;padding:0 20px;border:0;border-radius:10px;background:#4F46E5;color:#FFFFFF;font:inherit;font-size:15px;font-weight:700;cursor:pointer;'
const TAB_OFF = 'min-height:44px;padding:0 20px;border:0;border-radius:10px;background:transparent;color:#3730A3;font:inherit;font-size:15px;font-weight:700;cursor:pointer;'
const CARD = 'border-radius:24px;padding:30px;display:flex;flex-direction:column;gap:14px;background:#FFFFFF;color:#1E1B4B;'
const CARD_HOT = CARD + 'border:2px solid #4F46E5;box-shadow:0 24px 60px rgba(79,70,229,0.16);'
const CARD_COLD = CARD + 'border:1px solid #E0E7FF;'
const TAG_ON = 'font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:#4F46E5;color:#FFFFFF;white-space:nowrap;'
const TAG_OFF = 'font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:#EEF2FF;color:#3730A3;white-space:nowrap;'
const CTA_ON = 'min-height:50px;display:flex;align-items:center;justify-content:center;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;background:#4F46E5;color:#FFFFFF;'
const CTA_OFF = 'min-height:50px;display:flex;align-items:center;justify-content:center;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;background:#FFFFFF;border:1px solid #C7D2FE;color:#3730A3;'
const NOTE = 'background: #FFFFFF; border: 1px solid #E0E7FF; border-radius: 18px; padding: 22px; display: flex; flex-direction: column; gap: 6px;'
const NOTE_T = 'font-size: 16px; font-weight: 800;'
const NOTE_B = 'font-size: 14px; line-height: 1.55; color: #3730A3;'

/** The homepage pricing section (design-ref/site-home.html) with its Store / Office switch. Numbers: lib/pricing.ts. */
export function PricingSection({ headingLevel = 2 }: { headingLevel?: 1 | 2 }) {
  const [product, setProduct] = useState<Product>('store')
  const store = product === 'store'
  const H = headingLevel === 1 ? 'h1' : 'h2'
  const PlanH = headingLevel === 1 ? 'h2' : 'h3'
  return (
    <section id="pricing" style={css('background: #F5F7FF; border-top: 1px solid #E0E7FF; border-bottom: 1px solid #E0E7FF;')}>
      <div style={css('max-width: 1240px; margin: 0 auto; padding: 112px 24px; display: flex; flex-direction: column; gap: 40px;')}>
        <div style={css('display: flex; flex-direction: column; gap: 14px; text-align: center; align-items: center;')}>
          <span style={css("font-family: 'JetBrains Mono', monospace; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #4F46E5;")}>Pricing</span>
          <H style={css('margin: 0; font-size: clamp(34px, 4.4vw, 56px); line-height: 1.04; font-weight: 800; letter-spacing: -0.035em; max-width: 820px;')}>Less than one part-time hire. Works every hour.</H>
          <p style={css('margin: 0; font-size: 18px; line-height: 1.6; color: #3730A3; max-width: 640px;')}>One monthly fee with a bundle of agent actions included. Need more? Add them as you go — you set a spending cap.</p>
          <div role="group" aria-label="Choose product" style={css('display: inline-grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding: 5px; background: #FFFFFF; border: 1px solid #E0E7FF; border-radius: 14px; margin-top: 8px;')}>
            <button type="button" onClick={() => setProduct('store')} aria-pressed={store} style={css(store ? TAB_ON : TAB_OFF)}>Store · Shopify</button>
            <button type="button" onClick={() => setProduct('office')} aria-pressed={!store} style={css(store ? TAB_OFF : TAB_ON)}>Office</button>
          </div>
        </div>
        <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 20px; align-items: stretch;')}>
          {plansFor(product).map(p => (
            <div key={p.key} data-plan={`${product}-${p.key}`} style={css(p.hot ? CARD_HOT : CARD_COLD)}>
              <div style={css('display: flex; align-items: center; justify-content: space-between; gap: 8px;')}><PlanH style={css('margin: 0; font-size: 22px; font-weight: 800;')}>{p.name}</PlanH><span style={css(p.hot ? TAG_ON : TAG_OFF)}>{p.badge}</span></div>
              <p style={css('margin: 0; font-size: 15px; line-height: 1.5; color: #3730A3;')}>{p.who}</p>
              <div style={css('display: flex; align-items: baseline; gap: 6px;')}><span data-testid="plan-price" style={css('font-size: 52px; font-weight: 800; letter-spacing: -0.04em;')}>{p.price}</span><span style={css('font-size: 16px; font-weight: 600; color: #3730A3;')}>/ month</span></div>
              <span data-testid="plan-actions" style={css('font-size: 15px; font-weight: 700; color: #4F46E5;')}>{p.actions}</span>
              <Link className="hbtn" to={TRIAL_HREF} aria-label={`Start free trial: ${p.name}`} style={css(p.hot ? CTA_ON : CTA_OFF)}>Start free trial</Link>
              <ul style={css('margin: 0; padding: 18px 0 0; list-style: none; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid #E0E7FF;')}>
                {p.feats.map(f => (
                  <li key={f} style={css('display: flex; gap: 10px; font-size: 15px; line-height: 1.45;')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="3" strokeLinecap="round" aria-hidden="true" style={css('flex: none; margin-top: 2px;')}><path d="M5 12l5 5 9-10" /></svg>{f}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;')}>
          <div style={css(NOTE)}><span style={css(NOTE_T)}>What&apos;s an action?</span><span style={css(NOTE_B)}>One finished step: an email sent, an order updated, a product rewritten, an invoice drafted. Watching and checking are free.</span></div>
          <div style={css(NOTE)}><span style={css(NOTE_T)}>{OVERAGE[product].title}</span><span data-testid="overage" style={css(NOTE_B)}>{OVERAGE[product].text}</span></div>
          <div style={css(NOTE)}><span style={css(NOTE_T)}>Store + Office together</span><span data-testid="bundle" style={css(NOTE_B)}>{BUNDLE_TEXT}</span></div>
        </div>
      </div>
    </section>
  )
}
