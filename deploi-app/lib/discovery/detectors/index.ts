/**
 * Every discovery detector, registered by importing its file. lib/discovery imports this index, so a
 * detector runs in every discovery run once its file is listed here.
 */
// built in (commerce store reads)
import './store-issues'
import './inventory-low'
import './store-health'

// ---- INTEGRATION: domain detectors register here, one import line each, once their files exist:
//   import './supplier-exceptions'   // commerce supplier exceptions (purchase orders)
//   import './office-crm'            // Office CRM follow-up (file name per that workstream: office-*.ts)
//   import './office-email'          // Office email operations (unanswered inbox)
//   import './office-receivables'    // QuickBooks accounts receivable
// ---- end of the integration list
