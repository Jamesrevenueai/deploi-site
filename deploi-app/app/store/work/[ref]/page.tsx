import { CaseDetailScreen } from '@/components/work/CaseDetail'

export const metadata = { title: 'Case' }

export default async function CasePage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  return <CaseDetailScreen caseRef={decodeURIComponent(ref)} />
}
