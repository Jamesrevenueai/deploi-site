/**
 * Agent packs: importing this module installs the synthetic ports, registers every pack agent in PACK_AGENTS
 * (lib/packs/registry.ts), registers each agent's event handlers (lib/events) and its undo kinds (lib/undo).
 * Safe to import more than once.
 */
import './synthetic'
import { registerUndo } from '../undo'
import { registerHomeServices, undoWorkOrderStatus } from './home-services'
import { registerLeasing } from './leasing'
import { registerRealEstate } from './real-estate'
import { registerPropertyManagement } from './property-management'
import { registerOffice } from './office'
import { undoPayment } from './commission'

let done = false
export function registerPacks() {
  if (done) return
  done = true
  registerHomeServices()
  registerLeasing()
  registerRealEstate()
  registerPropertyManagement()
  registerOffice()
  registerUndo('leasing_payment', undoPayment)
  registerUndo('work_order_status', undoWorkOrderStatus)
}
registerPacks()

export { PACK_AGENTS, PACKS, agentsFor } from './registry'
export { setPortsFactory, portsFor, type Ports, type MailPort, type CalendarPort, type CrmPort, type InvoicingPort, type PropertySystemPort } from './ports'
