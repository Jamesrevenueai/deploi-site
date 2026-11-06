/**
 * Installs the real owner and crew update implementations behind lib/notify (setNotifyImpl). lib/notify/index.ts
 * loads this module on the first notifyOwner / notifyCrew call, so callers import only '@/lib/notify'.
 * Importing it also registers the email templates (agent_update, agent_action_needed, crew_jobs, morning_report).
 */
import './templates'
import { setNotifyDefaults } from './index'
import { notifyOwnerImpl } from './owner'
import { notifyCrewImpl } from './crew'

setNotifyDefaults({ owner: notifyOwnerImpl, crew: m => notifyCrewImpl(m) })
export { notifyOwnerImpl, notifyCrewImpl }
