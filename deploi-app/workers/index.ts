/** Registers every worker with the runtime. Import this once wherever workers run. */
import { registerWorker } from '@/lib/workers/runtime'
import { authorizationWatch } from './authorization_watch'
import { credentialTracking } from './credential_tracking'
import { openShiftFill } from './open_shift_fill'
import { referralResponse } from './referral_response'
import { applicantScreening } from './applicant_screening'
import { retentionCheckins } from './retention_checkins'

for (const w of [authorizationWatch, credentialTracking, openShiftFill, referralResponse, applicantScreening, retentionCheckins]) registerWorker(w)

export { authorizationWatch, credentialTracking, openShiftFill, referralResponse, applicantScreening, retentionCheckins }
export * from '@/lib/workers/runtime'
export * from '@/lib/workers/types'
