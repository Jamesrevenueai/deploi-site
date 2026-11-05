import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { env } from '../lib/env'
import { useSeo } from '../hooks/useSeo'
import { PageHero, Section } from '../components/Page'
import { LegalDraftTag } from '../components/Footer'

export default function LegalIndex() {
  useSeo({ title: `Legal — ${BRAND}`, description: 'Terms of Service and Privacy Policy.' })
  return (
    <div className="page">
      <PageHero eyebrow="Legal" title="Terms and privacy" lead={env.legalReviewed ? undefined : 'These documents are drafts pending legal review.'} />
      <Section>
        <ul className="cards cols-2">
          <li className="card"><h3><Link to="/terms">Terms of Service</Link><LegalDraftTag /></h3><p>The terms for using this website and the Deploi app.</p></li>
          <li className="card"><h3><Link to="/privacy">Privacy Policy</Link><LegalDraftTag /></h3><p>What Deploi reads, keeps and deletes.</p></li>
        </ul>
      </Section>
    </div>
  )
}
