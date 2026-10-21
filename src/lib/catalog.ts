/**
 * Typed view of the generated service catalog (src/data/catalog.json).
 * The JSON is exported from deploi-app/lib/catalog and is the only source of
 * service names, prices, availability and integration levels on this site.
 * Never hand-edit the JSON and never put a price in a component.
 */
import raw from '../data/catalog.json'

export type DoorKey = 'growth' | 'staffing' | 'operations'
export type Availability = 'demonstration' | 'supervised_pilot' | 'production_verified' | 'planned'
export type IntegrationLevel = 'csv_compatible' | 'api_implemented' | 'production_verified' | 'formal_partnership' | 'planned'

export type CatalogService = {
  key: string
  name: string
  door: DoorKey
  worker: string | null
  standalone: boolean
  description: string
  targetCustomer: string
  availability: Availability
  inputMethods: string[]
  requiredAccess: string[]
  setupDeliverables: string[]
  ongoingDeliverables: string[]
  customerResponsibilities: string[]
  deploiResponsibilities: string[]
  volumeLimits: string[]
  exclusions: string[]
  humanReview: string[]
  successMeasures: { key: string; label: string; definition: string }[]
}

export type CatalogIntegration = {
  key: string
  name: string
  kind: string
  level: IntegrationLevel
  note: string
}

export type Catalog = {
  generatedFrom: string
  doors: Record<DoorKey, string>
  availabilityLabel: Record<Availability, string>
  availabilityHelp: Record<Availability, string>
  services: CatalogService[]
  pricing: {
    assessment: { min: number; max: number; includes: string[]; creditTermDays: number }
    build: { min: number; max: number; includes: string[]; fixPeriodDays: number }
    management: { min: number; max: number; includes: string[]; initialTermMonths: number }
    website: { price: number; hoursBudget: number; targetBusinessDays: number; standalone: boolean; creditsTowardOtherServices: boolean }
  }
  scopeConsiderations: { key: string; label: string; note: string }[]
  notIncludedInLowestPrice: string[]
  integrations: CatalogIntegration[]
  integrationLevelLabel: Record<IntegrationLevel, string>
}

export const catalog = raw as Catalog

export const DOOR_ORDER: DoorKey[] = ['growth', 'staffing', 'operations']

/** Services the site may show. "planned" services are never rendered as available. */
export const sellableServices = catalog.services.filter(s => s.availability !== 'planned')

export const WEBSITE_SERVICE_KEY = 'website_improvement'

export const websiteService = catalog.services.find(s => s.key === WEBSITE_SERVICE_KEY)

/** Services grouped by door, in door order, keeping catalog order inside a door. */
export function servicesByDoor(list: CatalogService[] = sellableServices): { door: DoorKey; label: string; services: CatalogService[] }[] {
  return DOOR_ORDER.map(door => ({ door, label: catalog.doors[door], services: list.filter(s => s.door === door) })).filter(g => g.services.length > 0)
}

/** "$1,500" */
export function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`
}

/** "$1,500–2,500" (the second number without the dollar sign, as on the old site). */
export function moneyRange(min: number, max: number): string {
  return `${money(min)}–${max.toLocaleString('en-US')}`
}

/** Human line for an integration level, e.g. "CSV / file compatible". */
export function integrationLevel(level: IntegrationLevel): string {
  return catalog.integrationLevelLabel[level]
}
