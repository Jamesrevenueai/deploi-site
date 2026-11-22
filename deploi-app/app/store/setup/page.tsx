import { OnboardingWizard } from '@/components/cx/Onboarding'
import { BusinessTypePicker } from '@/components/packs/Packs'
export const metadata = { title: 'Set up' }
/** The one first-run path; resumable (components/cx/Onboarding.tsx, lib/library/onboarding.ts). The business type turns agent packs on (lib/packs). */
export default function StoreSetupPage() { return <><OnboardingWizard /><BusinessTypePicker /></> }
