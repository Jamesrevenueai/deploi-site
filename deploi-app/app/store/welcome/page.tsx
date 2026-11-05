import { FirstRun } from '@/components/discover/FirstRun'

export const metadata = { title: 'We found work' }

/** First run: what Deploi found and the team it recommends (reads the discovery API when it is deployed). */
export default function WelcomePage() {
  return <FirstRun />
}
