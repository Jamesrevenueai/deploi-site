import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { env } from '../lib/env'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { PageHero, Section, Steps } from '../components/Page'

export default function Signup() {
  useSeo({ title: `Sign up — ${BRAND}`, description: 'Start with a paid pilot, then sign in to the Deploi app.' })
  return (
    <div className="page">
      <PageHero eyebrow="Sign up" title="Start with a pilot." lead="Deploi is offered to a small number of businesses while it is in pilot. Apply, and we set up your account with you.">
        <CtaButton />
        <a href={`${env.appUrl}/login`} className="btn btn-ghost" data-testid="app-signin">Sign in to the app</a>
      </PageHero>
      <Section>
        <Steps steps={[
          { title: 'Apply', body: 'Tell us about your business and the tools you use.' },
          { title: 'Agree the pilot', body: 'We confirm the plan and price with you before anything is charged.' },
          { title: 'Sign in', body: 'Sign in to the Deploi app, connect your tools and see the work Deploi finds.' },
        ]} />
        <p className="muted pt">Already a pilot customer? <a href={`${env.appUrl}/login`}>Sign in</a>. Questions first? <Link to="/contact">Contact us</Link>.</p>
      </Section>
    </div>
  )
}
