/**
 * Every discovery detector, registered by importing its file. lib/discovery imports this index, so a
 * detector runs in every discovery run once its file is listed here.
 */
// built in (commerce store reads)
import './store-issues'
import './inventory-low'
import './store-health'

// domain detectors
import './office-receivables'    // QuickBooks accounts receivable

// ---- INTEGRATION: domain detectors register here, one import line each, once their files exist:
//   import './supplier-exceptions'   // commerce supplier exceptions (purchase orders)
//   import './office-crm'            // Office CRM follow-up (file name per that workstream: office-*.ts)
//   import './office-email'          // Office email operations (unanswered inbox)
// ---- end of the integration list
