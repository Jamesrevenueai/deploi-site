import { catalog, type Availability } from '../lib/catalog'

type Props = {
  availability: Availability
  /** Badge only, with the help text in a tooltip; otherwise the help line renders under the badge. */
  compact?: boolean
}

/**
 * Availability status from the catalog: label from availabilityLabel, help from availabilityHelp.
 * The help text is always in the title attribute; in the full variant it is also visible, so the
 * meaning does not depend on hover.
 */
export function AvailabilityBadge({ availability, compact = false }: Props) {
  const label = catalog.availabilityLabel[availability]
  const help = catalog.availabilityHelp[availability]
  return (
    <span className={`avail avail-${availability}`}>
      <span className="avail-badge" title={help} aria-label={`${label}: ${help}`}>
        <span className="avail-dot" aria-hidden="true" />
        {label}
      </span>
      {!compact && <span className="avail-help">{help}</span>}
    </span>
  )
}
