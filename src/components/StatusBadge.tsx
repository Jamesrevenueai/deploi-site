export type ProductStatus = 'early_access' | 'planned'

export const STATUS_LABEL: Record<ProductStatus, string> = {
  early_access: 'Early access',
  planned: 'Planned',
}

/** Availability status for a platform integration. "Planned" is never presented as available. */
export function StatusBadge({ status }: { status: ProductStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}
