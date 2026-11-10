import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { PageHero, Section } from '../components/Page'

export default function LegalIndex() {
  useSeo({ title: `Legal — ${BRAND}`, description: 'Terms of Service and Privacy Policy.' })
  return (
    <div className="page">
      <PageHero eyebrow="Legal" title="Terms and privacy" />
      <Section>
        <ul className="cards cols-2">
          <li className="card"><h3><Link to="/terms">Terms of Service</Link></h3><p>The terms for using this website and the Deploi app.</p></li>
          <li className="card"><h3><Link to="/privacy">Privacy Policy</Link></h3><p>What Deploi reads, keeps and deletes.</p></li>
        </ul>
      </Section>
    </div>
  )
}
