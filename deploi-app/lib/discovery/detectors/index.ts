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
import './supplier-exceptions'   // commerce supplier exceptions (purchase orders)
import './office-crm'            // Office CRM follow-up (neglected leads)
import './office-email'          // Office email operations (unanswered inbox)

