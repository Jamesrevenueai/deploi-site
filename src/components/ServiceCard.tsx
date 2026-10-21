import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ImageCard } from './ImageCard'
import { AvailabilityBadge } from './AvailabilityBadge'
import { BookButton, bookCtaLabel } from './Button'
import { catalog, money, WEBSITE_SERVICE_KEY, type CatalogService } from '../lib/catalog'
import type { ArtTheme } from '../lib/art'

type Props = { service: CatalogService; art: ArtTheme; icon?: ReactNode }

const MAX_SETUP = 3
const MAX_EXCLUSIONS = 3

/** Catalog-driven service card: outcome, included setup, exclusions, availability and a CTA. */
export function ServiceCard({ service, art, icon }: Props) {
  const isWebsite = service.key === WEBSITE_SERVICE_KEY
  const setup = service.setupDeliverables.slice(0, MAX_SETUP)
  const exclusions = service.exclusions.slice(0, MAX_EXCLUSIONS)
  const moreExclusions = service.exclusions.length - exclusions.length
  return (
    <ImageCard tag={catalog.doors[service.door]} tagIcon={icon} title={service.name} art={art} className="svc-card">
      <div className="icard-bottom svc">
        <div className="icard-title">{service.name}</div>
        <p className="svc-desc">{service.description}</p>
        <AvailabilityBadge availability={service.availability} />
        {isWebsite && (
          <div className="svc-price">{money(catalog.pricing.website.price)} one-time · standalone, no assessment or retainer</div>
        )}
        <div className="svc-cols">
          <div>
            <div className="svc-label">Setup includes</div>
            <ul className="svc-list">
              {setup.map(d => <li key={d}>{d}</li>)}
            </ul>
          </div>
          <div>
            <div className="svc-label">Not included</div>
            <ul className="svc-list svc-list-x">
              {exclusions.map(d => <li key={d}>{d}</li>)}
              {moreExclusions > 0 && <li className="svc-more">and {moreExclusions} more, listed on the service page</li>}
            </ul>
          </div>
        </div>
        {isWebsite ? (
          <Link to="/website" className="btn btn-ghost sm">See Website Improvement</Link>
        ) : (
          <BookButton variant="ghost" size="sm">{bookCtaLabel()}</BookButton>
        )}
      </div>
    </ImageCard>
  )
}
