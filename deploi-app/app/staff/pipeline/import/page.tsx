import { PageHeader } from '@/components/ui/PageHeader'
import { ImportWizard } from '@/components/sales/ImportWizard'

export const metadata = { title: 'Import prospects' }

export default function ImportPage() {
  return (
    <>
      <PageHeader eyebrow="Pipeline" title="Import prospects" sub="Upload a CSV of agencies. Rows that match an existing email + agency name are skipped." />
      <ImportWizard />
    </>
  )
}
