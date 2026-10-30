import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>

export const SUPPORT_FAQ: { q: string; a: ReactNode }[] = [
  {
    q: 'How do I install the Shopify app?',
    a: <>From the Shopify App Store listing, or from your Shopify admin under Apps. Shopify asks you to approve the permissions the app needs, then opens Deploi inside your admin. You never type your store address into Deploi.</>,
  },
  {
    q: 'What can the app change in my store?',
    a: <>Only what you approve, or what an agent&rsquo;s authorization you granted covers: a variant&rsquo;s out-of-stock setting, whether a product is published on the one sales channel you choose, a variant&rsquo;s price or compare-at price from your price list, and a variant&rsquo;s SKU from your mapping. It never changes stock counts, product status, customers or orders.</>,
  },
  {
    q: 'Deploi says my store is not enabled for changes yet. Why?',
    a: <>During the beta, Deploi scans every installed store and shows what it finds, but makes changes and sends real email only for enabled stores. Enter the invite code you were given, or use Request access in the app, and we will reply by email.</>,
  },
  {
    q: 'How do I stop an agent or undo access?',
    a: <>Pause or revoke the agent on its page in the app; queued changes and emails are cancelled. To remove all access, uninstall the app from your Shopify admin.</>,
  },
  {
    q: 'What happens to my data when I uninstall?',
    a: <>Uninstalling immediately stops all reads, changes and email for your store and deletes its access token. Shopify then sends a deletion request (about 48 hours later) and we delete your store&rsquo;s data. Email {mail} if you want it deleted sooner.</>,
  },
  {
    q: 'How do I connect or disconnect an email account?',
    a: <>In the app, open Connections. You sign in on Google&rsquo;s or Microsoft&rsquo;s own page; Deploi never asks for your mailbox password. Disconnecting deletes the tokens and cancels unsent messages.</>,
  },
  {
    q: 'How is billing handled?',
    a: <>Through Shopify. Plans, upgrades, downgrades and cancellations are shown and managed on Shopify&rsquo;s own plan page, and charges appear on your Shopify bill. During early access there is no charge.</>,
  },
]

export default function Support() {
  useSeo({ title: `Support — ${BRAND}`, description: `${BRAND} support: contact, installation, permissions, beta access, uninstalling and data deletion.` })
  return (
    <div className="page">
      <div className="container-narrow">
        <Link to="/" className="back">← Back to {BRAND}</Link>
        <h1>Support</h1>
        <p className="lead">Email {mail} with your store&rsquo;s myshopify.com address and what you were doing. Never send passwords or access keys.</p>
        <ol className="legal-sections">
          {SUPPORT_FAQ.map((f, i) => (
            <li key={f.q} className="legal-section">
              <div className="legal-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
              <h2>{f.q}</h2>
              <p>{f.a}</p>
            </li>
          ))}
        </ol>
        <p className="legal-meta">Privacy questions and data requests: see the <Link to="/privacy">Privacy Policy</Link> or email {mail}.</p>
      </div>
    </div>
  )
}
