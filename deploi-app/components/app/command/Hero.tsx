import type { Hero as HeroData } from '@/lib/app/contract'
import { agoText, minutesText, plural } from './time'

/** The dark band: what the team did since yesterday and what waits on you. Every number comes from hero(). */
export function Hero({ hero, now }: { hero: HeroData; now: Date }) {
  const last = agoText(hero.lastCheckAt, now)
  const n = hero.handledSinceYesterday, m = hero.needYouCount
  const needLine = m === 0 ? 'Nothing needs a yes from you.' : `${m} ${m === 1 ? 'needs' : 'need'} a quick yes from you.`
  return (
    <section className="cc-hero" aria-label="Today at a glance" data-testid="hero">
      <div className="cc-hero-text">
        <p className="cc-live"><span className="cc-live-dot" aria-hidden="true" />{plural(hero.agentsRunning, 'agent', 'agents')} running · {last ? `last check ${last}` : 'no check yet'}</p>
        <p className="cc-hero-line">Your agents handled {plural(n, 'thing', 'things')} since yesterday. {needLine}</p>
        <p className="cc-hero-sub">{hero.fixedOnTheirOwn > 0 ? 'Nobody had to ask. Every fix below has proof attached.' : 'When your agents finish something, its proof shows up below.'}</p>
      </div>
      <dl className="cc-tiles">
        <div className="cc-tile" title={hero.timeSavedFormula}><dt>Time saved this week</dt><dd>{minutesText(hero.timeSavedWeekMinutes)}</dd></div>
        <div className="cc-tile"><dt>Fixed on their own</dt><dd>{hero.fixedOnTheirOwn}</dd></div>
        <div className="cc-tile"><dt>Waiting on you</dt><dd className="orange">{hero.needYouCount}</dd></div>
      </dl>
    </section>
  )
}
