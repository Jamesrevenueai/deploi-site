/** Exports the service catalog + pricing to the marketing site (../src/data/catalog.json). Run: npx tsx scripts/export-catalog.ts */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SERVICES, AVAILABILITY_LABEL, AVAILABILITY_HELP, DOOR_LABEL } from '../lib/catalog/services'
import { getPricing, SCOPE_CONSIDERATIONS, NOT_INCLUDED_IN_LOWEST_PRICE } from '../lib/catalog/pricing'
import { INTEGRATIONS, INTEGRATION_LEVEL_LABEL } from '../lib/catalog/integrations'

export function catalogJson() {
  return {
    generatedFrom: 'deploi-app/lib/catalog',
    doors: DOOR_LABEL,
    availabilityLabel: AVAILABILITY_LABEL,
    availabilityHelp: AVAILABILITY_HELP,
    services: SERVICES,
    pricing: getPricing(),
    scopeConsiderations: SCOPE_CONSIDERATIONS,
    notIncludedInLowestPrice: NOT_INCLUDED_IN_LOWEST_PRICE,
    integrations: INTEGRATIONS,
    integrationLevelLabel: INTEGRATION_LEVEL_LABEL,
  }
}

if (process.argv[1] && /export-catalog\.ts$/.test(process.argv[1])) {
  const out = join(process.cwd(), '..', 'src', 'data')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'catalog.json'), JSON.stringify(catalogJson(), null, 2) + '\n')
  console.log('wrote', join(out, 'catalog.json'))
}
