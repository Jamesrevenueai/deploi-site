import { PageHeader } from './ui/PageHeader'
import { Empty } from './ui/Empty'
export function Placeholder({ title, section }: { title: string; section: number }) {
  return (
    <>
      <PageHeader title={title} />
      <Empty title="Not built yet">This screen is delivered in section {section}.</Empty>
    </>
  )
}
