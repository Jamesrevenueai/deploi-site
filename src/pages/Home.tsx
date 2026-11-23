import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useSeo } from '../hooks/useSeo'
import { css } from '../lib/css'
import { STORE_OVERAGE, TRIAL_DAYS } from '../lib/pricing'
import { TRIAL_HREF } from '../components/Nav'
import { PricingSection } from '../components/PricingSection'

export const HOME_TITLE = 'Deploi — AI agents that run your store and your office'
export const HOME_DESCRIPTION = 'Deploi agents watch your Shopify store and your office, fix problems on their own and show you a receipt for every action. Big decisions wait for your one-tap OK.'
export const HERO_EXAMPLE_LABEL = 'Example data from a Deploi test store'
export const TICKER_LABEL = 'Examples of things Deploi agents do'

export const TICKER = ['Reordered 40 units before stock ran out', 'Answered 22 support tickets', 'Fixed 2 broken collection links', 'Chased a late supplier order', 'Flagged a $38 payout fee error', 'Rewrote 6 product descriptions', 'Sent a commission invoice', 'Routed 7 jobs to 3 crews', 'Replied to a new lead in 90 seconds', 'Texted the owner a 6 pm summary']

export const CREW = [
  { name: 'Order Tracker', area: 'Orders', desc: 'Spots stuck shipments and updates customers before they ask.', bg: '#EEF2FF', body: '#4F46E5' },
  { name: 'Inventory Watcher', area: 'Products', desc: 'Predicts stock-outs and drafts reorders with your suppliers.', bg: '#E0E7FF', body: '#3730A3' },
  { name: 'Customer Care', area: 'Customers', desc: 'Answers tickets in your tone and escalates only what needs you.', bg: '#EEF2FF', body: '#6366F1' },
  { name: 'Listing Writer', area: 'Products', desc: 'Writes product pages and SEO in your brand voice.', bg: '#E0E7FF', body: '#4F46E5' },
  { name: 'Promo Manager', area: 'Marketing', desc: 'Finds slow movers and proposes discounts that protect margin.', bg: '#EEF2FF', body: '#3730A3' },
  { name: 'Returns', area: 'Orders', desc: 'Handles returns under your policy and restocks items.', bg: '#E0E7FF', body: '#6366F1' },
  { name: 'Payout & Fees Checker', area: 'Finance', desc: 'Checks every payout and flags fees that look wrong.', bg: '#EEF2FF', body: '#4F46E5' },
  { name: 'AI Visibility', area: 'Marketing', desc: 'Gets your products found in AI shopping assistants.', bg: '#E0E7FF', body: '#3730A3' },
]

export const OFFICE = [
  { name: 'Invoice Runner', desc: 'Builds job and commission invoices and sends them for you.' },
  { name: 'Dispatch Coordinator', desc: 'Routes jobs to crews and keeps everyone updated by text.' },
  { name: 'Lead Responder', desc: 'Replies to new leads in minutes and books the next step.' },
  { name: 'Owner Updates', desc: 'Texts and voice notes to your phone, with links to the proof.' },
]

export const HOME_FAQ = [
  { q: 'How is Deploi different from Shopify Sidekick?', a: 'Sidekick is a great free assistant that helps when you ask it. Deploi agents work on their own: they watch your store all day, take care of jobs end to end, and keep a proof log of everything they did.' },
  { q: 'Can an agent do something I did not want?', a: 'Every agent starts with the safest permissions. Anything that spends money, changes prices or goes outside your rules waits for your approval.' },
  { q: 'What counts as an action?', a: 'One finished step — an email sent, an order updated, a product rewritten, an invoice drafted. Watching your store and checking for problems is free.' },
  { q: 'What happens if I run out of actions?', a: `Agents keep working and extra actions are billed at ${STORE_OVERAGE}, up to the monthly cap you set. Hit the cap and agents pause anything non-urgent until next month.` },
  { q: 'Does Deploi Office work without Shopify?', a: 'Yes. Office is its own product. It connects to Outlook, your CRM and QuickBooks, and works for home services, property managers, leasing and real estate agents.' },
]

/** Hashes from earlier versions of the site that meant the pilot application, which now lives on /signup. */
const OLD_FORM_HASHES = ['#early-access', '#waitlist', '#book']

const Tick = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
const MONO = "font-family: 'JetBrains Mono', monospace;"
const EYEBROW = "font-family: 'JetBrains Mono', monospace; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #4F46E5;"
const H2 = 'margin: 0; font-size: clamp(34px, 4.4vw, 56px); line-height: 1.04; font-weight: 800; letter-spacing: -0.035em;'
const ROW = 'display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 14px; border: 1px solid #EEF2FF;'
const AV = "width: 34px; height: 34px; border-radius: 10px; background: #EEF2FF; display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 600; color: #4F46E5;"
const DONE = 'font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 999px; background: #4F46E5; color: #FFFFFF;'
const SMALL_CARD = 'border-radius: 26px; border: 1px solid #E0E7FF; padding: 32px; display: flex; flex-direction: column; gap: 12px;'
const H3_SM = 'margin: 0; font-size: 24px; line-height: 1.15; font-weight: 800;'
const P_SM = 'margin: 0; font-size: 16px; line-height: 1.6; color: #3730A3;'
const BUBBLE = 'align-self: flex-start; max-width: 86%; padding: 12px 14px; border-radius: 16px 16px 16px 4px; background: #EEF2FF; font-size: 14px; line-height: 1.45;'
const TICK_ROW = 'display: inline-flex; align-items: center; gap: 6px;'

function TickerPill({ t, hidden }: { t: string; hidden?: boolean }) {
  return <span aria-hidden={hidden || undefined} style={css('display: inline-flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 999px; border: 1px solid #E0E7FF; font-size: 14px; font-weight: 600; color: #312E81; white-space: nowrap;')}><span style={css('width: 8px; height: 8px; border-radius: 999px; background: #4F46E5;')} />{t}</span>
}

export default function Home() {
  useSeo({ title: HOME_TITLE, description: HOME_DESCRIPTION })
  const { hash } = useLocation()
  const navigate = useNavigate()
  useEffect(() => { if (OLD_FORM_HASHES.includes(hash)) navigate('/signup#early-access', { replace: true }) }, [hash, navigate])

  return (
    <div className="dz-x home-page">
      {/* HERO */}
      <section className="dots" style={css('position: relative; border-bottom: 1px solid #EEF2FF;')}>
        <div style={css('max-width: 1240px; margin: 0 auto; padding: 80px 24px 88px; display: flex; flex-wrap: wrap; gap: 56px; align-items: center;')}>
          <div style={css('flex: 1 1 520px; display: flex; flex-direction: column; gap: 26px; background: rgba(255,255,255,0.86); border-radius: 24px;')}>
            <span style={css('align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: #FFFFFF; border: 1px solid #C7D2FE; color: #3730A3; font-size: 13px; font-weight: 700;')}><span className="pulse" style={css('width: 8px; height: 8px; border-radius: 999px; background: #4F46E5;')} />Built for Shopify · Office tools too</span>
            <h1 style={css('margin: 0; font-size: clamp(44px, 6.2vw, 84px); line-height: 0.98; font-weight: 800; letter-spacing: -0.045em; color: #1E1B4B;')}>Your store,<br />run by a team<br />of <span style={css('color: #4F46E5;')}>AI agents.</span></h1>
            <p style={css('margin: 0; font-size: 20px; line-height: 1.55; color: #3730A3; max-width: 540px;')}>Deploi agents watch your business, spot problems on their own, fix them — and show you a receipt for every action. Big decisions wait for your one-tap OK.</p>
            <div style={css('display: flex; flex-wrap: wrap; gap: 12px;')}>
              <Link className="hbtn" to={TRIAL_HREF} style={css('min-height: 56px; display: inline-flex; align-items: center; gap: 10px; padding: 0 28px; border-radius: 16px; background: #4F46E5; color: #FFFFFF; text-decoration: none; font-size: 17px; font-weight: 700;')}>Install on Shopify <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></Link>
              <a className="hbtn" href="#how" style={css('min-height: 56px; display: inline-flex; align-items: center; padding: 0 26px; border-radius: 16px; background: #FFFFFF; border: 1px solid #C7D2FE; color: #3730A3; text-decoration: none; font-size: 17px; font-weight: 700;')}>Watch it work</a>
            </div>
            <div style={css('display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 14px; font-weight: 600; color: #3730A3;')}>
              <span style={css(TICK_ROW)}><Tick />{`${TRIAL_DAYS}-day free trial`}</span>
              <span style={css(TICK_ROW)}><Tick />Billed through Shopify</span>
              <span style={css(TICK_ROW)}><Tick />Cancel anytime</span>
            </div>
          </div>

          {/* hero visual */}
          <div aria-hidden="true" style={css('flex: 1 1 440px; position: relative; min-height: 520px;')}>
            <div style={css('position: absolute; inset: 30px 0 0 30px; border-radius: 28px; background: #FFFFFF; border: 1px solid #E0E7FF; box-shadow: 0 40px 90px rgba(49,46,129,0.16); padding: 22px; display: flex; flex-direction: column; gap: 14px;')}>
              <div style={css('display: flex; align-items: center; justify-content: space-between;')}><span style={css('font-size: 15px; font-weight: 800;')}>Command center</span><span style={css(MONO + ' font-size: 11px; color: #4F46E5; display: inline-flex; align-items: center; gap: 6px;')}><span className="pulse" style={css('width: 7px; height: 7px; border-radius: 999px; background: #4F46E5;')} />LIVE</span></div>
              <div style={css('display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;')}>
                <div style={css('border-radius: 16px; background: #4F46E5; color: #FFFFFF; padding: 16px; display: flex; flex-direction: column; gap: 4px;')}><span style={css('font-size: 12px; font-weight: 600; color: #E0E7FF;')}>Hours saved this week</span><span style={css('font-size: 34px; font-weight: 800; letter-spacing: -0.03em;')}>14.5</span></div>
                <div style={css('border-radius: 16px; background: #F5F7FF; border: 1px solid #E0E7FF; padding: 16px; display: flex; flex-direction: column; gap: 4px;')}><span style={css('font-size: 12px; font-weight: 600; color: #4F46E5;')}>Fixed before you noticed</span><span style={css('font-size: 34px; font-weight: 800; letter-spacing: -0.03em;')}>31</span></div>
              </div>
              <div style={css('display: flex; flex-direction: column; gap: 8px;')}>
                <div style={css(ROW)}><span style={css(AV)}>OT</span><div style={css('flex: 1; display: flex; flex-direction: column;')}><span style={css('font-size: 13px; font-weight: 700;')}>Order Tracker</span><span style={css('font-size: 12px; color: #3730A3;')}>Messaged carrier about 4 stuck parcels</span></div><span style={css(DONE)}>Done</span></div>
                <div style={css(ROW)}><span style={css(AV)}>CC</span><div style={css('flex: 1; display: flex; flex-direction: column;')}><span style={css('font-size: 13px; font-weight: 700;')}>Customer Care</span><span style={css('font-size: 12px; color: #3730A3;')}>Answered 22 tickets in your tone</span></div><span style={css(DONE)}>Done</span></div>
                <div style={css('display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 14px; background: #F5F7FF;')}><span style={css("width: 34px; height: 34px; border-radius: 10px; background: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 600; color: #4F46E5;")}>IW</span><div style={css('flex: 1; display: flex; flex-direction: column;')}><span style={css('font-size: 13px; font-weight: 700;')}>Inventory Watcher</span><span style={css('font-size: 12px; color: #3730A3;')}>Reorder 40 × Linen Throw?</span></div><span style={css('font-size: 11px; font-weight: 700; padding: 6px 10px; border-radius: 8px; background: #4F46E5; color: #FFFFFF;')}>Approve</span></div>
              </div>
              <span data-testid="hero-example-label" style={css('font-size: 11px; color: #4F46E5;')}>{HERO_EXAMPLE_LABEL}</span>
            </div>
            {/* floating bot */}
            <div className="float" style={css('position: absolute; left: 0; top: 0; width: 112px; height: 112px; border-radius: 30px; background: #FFFFFF; border: 1px solid #E0E7FF; box-shadow: 0 18px 40px rgba(49,46,129,0.14); display: flex; align-items: center; justify-content: center;')}>
              <svg width="80" height="80" viewBox="0 0 96 96"><path d="M48 26V16" stroke="#4F46E5" strokeWidth="3" strokeLinecap="round" /><circle cx="48" cy="14" r="5" fill="#E8734A" /><rect x="18" y="26" width="60" height="44" rx="17" fill="#4F46E5" /><rect x="27" y="36" width="42" height="22" rx="11" fill="#EEF2FF" /><circle cx="39" cy="47" r="4.5" fill="#1E1B4B" /><circle cx="57" cy="47" r="4.5" fill="#1E1B4B" /><rect x="34" y="74" width="28" height="10" rx="5" fill="#C7D2FE" /></svg>
            </div>
            {/* floating receipt */}
            <div className="float2" style={css('position: absolute; right: -8px; bottom: -18px; width: 250px; border-radius: 18px; background: #1E1B4B; color: #FFFFFF; padding: 16px; box-shadow: 0 24px 50px rgba(30,27,75,0.3); display: flex; flex-direction: column; gap: 6px;')}>
              <span style={css(MONO + ' font-size: 11px; color: #A5B4FC;')}>PROOF · 12:08</span>
              <span style={css('font-size: 14px; font-weight: 700; line-height: 1.4;')}>Supplier confirmed PO #1042 — arrives Nov 25</span>
              <span style={css('font-size: 12px; color: #C7D2FE;')}>Email thread attached</span>
            </div>
          </div>
        </div>
      </section>

      {/* TICKER: example actions (the second copy only makes the loop seamless, so screen readers skip it) */}
      <section aria-label={TICKER_LABEL} style={css('border-bottom: 1px solid #EEF2FF; padding: 18px 0; overflow: hidden; background: #FFFFFF;')}>
        <div className="track">
          {TICKER.map(t => <TickerPill key={t} t={t} />)}
          {TICKER.map(t => <TickerPill key={`${t}-2`} t={t} hidden />)}
        </div>
      </section>

      {/* PROBLEM / SHIFT */}
      <section style={css('max-width: 1240px; margin: 0 auto; padding: 112px 24px 40px; display: flex; flex-wrap: wrap; gap: 48px; align-items: flex-end;')}>
        <h2 style={css('flex: 1 1 560px; margin: 0; font-size: clamp(34px, 4.4vw, 60px); line-height: 1.04; font-weight: 800; letter-spacing: -0.035em;')}>Most AI tools wait for you to ask. <span style={css('color: #4F46E5;')}>Deploi agents don&apos;t.</span></h2>
        <p style={css('flex: 1 1 380px; margin: 0; font-size: 18px; line-height: 1.65; color: #3730A3;')}>Chat assistants answer questions. Deploi agents own jobs — inventory, orders, support, marketing, books — and keep doing them every hour of every day, inside limits you set.</p>
      </section>

      {/* BENTO */}
      <section id="how" style={css('max-width: 1240px; margin: 0 auto; padding: 40px 24px 112px;')}>
        <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px;')}>
          <div style={css('grid-column: span 2; min-width: 0; border-radius: 26px; background: #4F46E5; color: #FFFFFF; padding: 36px; display: flex; flex-direction: column; gap: 14px; min-height: 280px; box-sizing: border-box;')}>
            <span style={css(MONO + ' font-size: 13px; color: #E0E7FF;')}>01 · NOTICE</span>
            <h3 style={css('margin: 0; font-size: 32px; line-height: 1.1; font-weight: 800; letter-spacing: -0.025em; max-width: 520px;')}>They spot the problem before your customers do.</h3>
            <p style={css('margin: 0; font-size: 17px; line-height: 1.6; color: #E0E7FF; max-width: 560px;')}>Stuck shipments, low stock, broken links, fee errors, unanswered leads — agents scan around the clock and catch them early.</p>
          </div>
          <div style={css('border-radius: 26px; background: #F5F7FF; border: 1px solid #E0E7FF; padding: 32px; display: flex; flex-direction: column; gap: 12px;')}>
            <span style={css(MONO + ' font-size: 13px; color: #4F46E5;')}>02 · FIX</span>
            <h3 style={css(H3_SM)}>They do the work.</h3>
            <p style={css(P_SM)}>Emails sent, orders updated, products rewritten, invoices built — real work, not suggestions.</p>
          </div>
          <div style={css('background: #FFFFFF; ' + SMALL_CARD)}>
            <span style={css(MONO + ' font-size: 13px; color: #4F46E5;')}>03 · PROVE</span>
            <h3 style={css(H3_SM)}>Every action has a receipt.</h3>
            <p style={css(P_SM)}>See the email, the order, the before-and-after. Nothing happens in the dark.</p>
          </div>
          <div style={css('background: #FFFFFF; ' + SMALL_CARD)}>
            <span style={css(MONO + ' font-size: 13px; color: #4F46E5;')}>04 · ASK</span>
            <h3 style={css(H3_SM)}>You approve the big moves.</h3>
            <p style={css(P_SM)}>Spending money or changing prices? The agent asks first — one tap from your phone.</p>
          </div>
          <div style={css('border-radius: 26px; background: #1E1B4B; color: #FFFFFF; padding: 32px; display: flex; flex-direction: column; gap: 12px;')}>
            <span style={css(MONO + ' font-size: 13px; color: #A5B4FC;')}>05 · TALK</span>
            <h3 style={css(H3_SM)}>Chat or speak to any agent.</h3>
            <p style={css('margin: 0; font-size: 16px; line-height: 1.6; color: #C7D2FE;')}>Give standing instructions in plain words — by text or voice — and they stick.</p>
          </div>
        </div>
      </section>

      {/* CREW */}
      <section id="crew" style={css('background: #F5F7FF; border-top: 1px solid #E0E7FF; border-bottom: 1px solid #E0E7FF;')}>
        <div style={css('max-width: 1240px; margin: 0 auto; padding: 112px 24px; display: flex; flex-direction: column; gap: 48px;')}>
          <div style={css('display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 24px;')}>
            <div style={css('display: flex; flex-direction: column; gap: 14px; max-width: 660px;')}>
              <span style={css(EYEBROW)}>Meet the crew</span>
              <h2 style={css(H2)}>One agent for every part of your Shopify store.</h2>
            </div>
            <Link to="/agents" style={css('min-height: 44px; display: inline-flex; align-items: center; font-size: 16px; font-weight: 700; text-decoration: none;')}>See all 12 agents →</Link>
          </div>
          <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;')}>
            {CREW.map(c => (
              <article key={c.name} style={css('background: #FFFFFF; border: 1px solid #E0E7FF; border-radius: 22px; padding: 24px; display: flex; flex-direction: column; gap: 14px;')}>
                <div style={css('display: flex; align-items: center; justify-content: space-between;')}>
                  <svg width="52" height="52" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="12" fill={c.bg} /><rect x="9" y="13" width="22" height="16" rx="6" fill={c.body} /><circle cx="16" cy="21" r="2.4" fill="#FFFFFF" /><circle cx="24" cy="21" r="2.4" fill="#FFFFFF" /><path d="M20 13V8" stroke={c.body} strokeWidth="2" /><circle cx="20" cy="7" r="2" fill="#E8734A" /></svg>
                  <span style={css(MONO + ' font-size: 11px; font-weight: 600; color: #4F46E5; text-transform: uppercase; letter-spacing: 0.06em;')}>{c.area}</span>
                </div>
                <h3 style={css('margin: 0; font-size: 19px; font-weight: 800;')}>{c.name}</h3>
                <p style={css('margin: 0; font-size: 15px; line-height: 1.55; color: #3730A3;')}>{c.desc}</p>
              </article>
            ))}
          </div>
          <div style={css('border-radius: 22px; border: 2px dashed #A5B4FC; background: #FFFFFF; padding: 28px; display: flex; flex-wrap: wrap; align-items: center; gap: 20px;')}>
            <span style={css('width: 52px; height: 52px; border-radius: 14px; background: #4F46E5; color: #FFFFFF; display: flex; align-items: center; justify-content: center;')}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></span>
            <div style={css('flex: 1 1 360px; display: flex; flex-direction: column; gap: 4px;')}><span style={css('font-size: 20px; font-weight: 800;')}>Need something else? Build your own agent.</span><span style={css('font-size: 15px; color: #3730A3;')}>Describe the job in plain words. Deploi sets up the agent, its tools and its permissions.</span></div>
            <a className="hbtn" href="#pricing" style={css('min-height: 48px; display: inline-flex; align-items: center; padding: 0 20px; border-radius: 12px; background: #4F46E5; color: #FFFFFF; text-decoration: none; font-weight: 700;')}>Try it free</a>
          </div>
        </div>
      </section>

      {/* OFFICE */}
      <section id="office" style={css('max-width: 1240px; margin: 0 auto; padding: 112px 24px; display: flex; flex-wrap: wrap; gap: 56px; align-items: center;')}>
        <div style={css('flex: 1 1 480px; display: flex; flex-direction: column; gap: 20px;')}>
          <span style={css(EYEBROW)}>Deploi Office</span>
          <h2 style={css(H2)}>Run the office from your truck.</h2>
          <p style={css('margin: 0; font-size: 18px; line-height: 1.65; color: #3730A3;')}>For HVAC, construction and landscaping crews, property managers, leasing and real estate agents. Office agents plug into your CRM, Outlook and QuickBooks — then text and send voice notes to your phone as work gets done.</p>
          <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;')}>
            {OFFICE.map(o => (
              <div key={o.name} style={css('border: 1px solid #E0E7FF; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 6px;')}>
                <span style={css('font-size: 16px; font-weight: 800;')}>{o.name}</span>
                <span style={css('font-size: 14px; line-height: 1.5; color: #3730A3;')}>{o.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div aria-hidden="true" style={css('flex: 0 1 360px; margin: 0 auto; position: relative;')}>
          <div style={css('width: 310px; border: 11px solid #1E1B4B; border-radius: 48px; padding: 26px 16px 22px; background: #FFFFFF; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 40px 80px rgba(30,27,75,0.22);')}>
            <div style={css('display: flex; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid #EEF2FF;')}><span style={css('width: 36px; height: 36px; border-radius: 12px; background: #4F46E5;')} /><div style={css('display: flex; flex-direction: column;')}><span style={css('font-size: 14px; font-weight: 800;')}>Deploi Office</span><span style={css('font-size: 11px; color: #4F46E5;')}>Dispatch Coordinator</span></div></div>
            <div style={css(BUBBLE)}>Crew B finished the Oak Ave install. Photos and sign-off attached.</div>
            <div style={css('align-self: flex-start; width: 86%; box-sizing: border-box; padding: 12px 14px; border-radius: 16px 16px 16px 4px; background: #EEF2FF; display: flex; align-items: center; gap: 10px;')}><span style={css('width: 30px; height: 30px; border-radius: 999px; background: #4F46E5; display: flex; align-items: center; justify-content: center;')}><svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 2l7 4-7 4z" fill="#FFFFFF" /></svg></span><svg width="120" height="22" viewBox="0 0 120 22"><path d="M2 11h4M10 6v10M16 3v16M22 8v6M28 5v12M34 9v4M40 2v18M46 7v8M52 4v14M58 9v4M64 6v10M70 3v16M76 8v6M82 5v12M88 9v4M94 6v10M100 8v6M106 10v2" stroke="#6366F1" strokeWidth="2.4" strokeLinecap="round" /></svg><span style={css(MONO + ' font-size: 11px;')}>0:18</span></div>
            <div style={css(BUBBLE)}>Commission invoice for 14 Elm St is ready. Send it to the landlord?</div>
            <div style={css('align-self: flex-end; padding: 12px 16px; border-radius: 16px 16px 4px 16px; background: #4F46E5; color: #FFFFFF; font-size: 14px; font-weight: 700;')}>Send it</div>
          </div>
        </div>
      </section>

      <PricingSection />

      {/* FAQ */}
      <section id="faq" style={css('max-width: 880px; margin: 0 auto; padding: 112px 24px; display: flex; flex-direction: column; gap: 32px;')}>
        <h2 style={css('margin: 0; font-size: clamp(32px, 4vw, 48px); line-height: 1.08; font-weight: 800; letter-spacing: -0.03em; text-align: center;')}>Questions, answered.</h2>
        <div style={css('display: flex; flex-direction: column; gap: 12px;')}>
          {HOME_FAQ.map(q => (
            <details key={q.q} style={css('border: 1px solid #E0E7FF; border-radius: 16px; padding: 0 22px;')}>
              <summary style={css('min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 17px; font-weight: 700; color: #1E1B4B;')}>{q.q}<span className="chev" aria-hidden="true" style={css('font-size: 24px; color: #4F46E5; transition: transform .2s ease;')}>+</span></summary>
              <p style={css('margin: 0 0 20px; font-size: 16px; line-height: 1.65; color: #3730A3;')}>{q.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* FINAL CTA */}
      <section style={css('max-width: 1240px; margin: 0 auto; padding: 0 24px 112px;')}>
        <div className="dots" style={css('border-radius: 32px; background-color: #4F46E5; background-image: radial-gradient(rgba(255,255,255,0.16) 1.2px, transparent 1.2px); padding: 80px 40px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 22px;')}>
          <h2 style={css('margin: 0; font-size: clamp(36px, 5vw, 64px); line-height: 1.02; font-weight: 800; letter-spacing: -0.04em; color: #FFFFFF; max-width: 840px;')}>Give your business a team that never logs off.</h2>
          <p style={css('margin: 0; font-size: 19px; color: #E0E7FF; max-width: 560px;')}>Install from the Shopify App Store and switch on your first agent in minutes.</p>
          <div style={css('display: flex; flex-wrap: wrap; justify-content: center; gap: 12px;')}>
            <Link className="hbtn" to={TRIAL_HREF} style={css('min-height: 56px; display: inline-flex; align-items: center; padding: 0 28px; border-radius: 16px; background: #FFFFFF; color: #3730A3; text-decoration: none; font-size: 17px; font-weight: 800;')}>Install on Shopify</Link>
            <Link className="hbtn" to="/contact" style={css('min-height: 56px; display: inline-flex; align-items: center; padding: 0 28px; border-radius: 16px; border: 1px solid #A5B4FC; color: #FFFFFF; text-decoration: none; font-size: 17px; font-weight: 700;')}>Book an Office demo</Link>
          </div>
        </div>
      </section>
    </div>
  )
}
