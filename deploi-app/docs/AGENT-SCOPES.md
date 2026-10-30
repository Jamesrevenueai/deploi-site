# Agent library: Shopify scopes per agent

Written against `lib/library/agent-library.json` (the `scopes` and `protectedScopes` fields). **Nothing in the
Shopify app configuration was changed**: `shopify.app.toml.example` still requests the read-only install scopes,
and the other session owns the dev store, the Shopify CLI and the app config. This table is what a later config
change would need, with the App Store review risk of each scope and draft justification text.

Scope names should be verified against the current Admin API scope list before they are added to the app
configuration; the Agentic sales channel's read requirements in particular are new and may change.

## Scope table

| Agent | Scopes it needs | Protected customer data | Review risk | Why it needs them |
|---|---|---|---|---|
| Order Tracker | `read_orders`, `read_fulfillments` | **yes** (`read_orders`) | High: order and customer fields | Finds unfulfilled orders past the promised dispatch time, fulfilled orders without tracking, and tracking that has not moved. Reads order name, dates, fulfilment status, tracking events, and the customer's first name and email to draft the delay update. |
| Returns | `read_orders`, `read_returns`, `write_returns` | **yes** (all three) | High: customer data plus a write that affects money | Reads return requests with their reason and the delivered order; drafts the reply; with your approval marks a return approved (never a refund). |
| Listing Writer | `read_products`, `write_products` | no | Low | Reads titles and descriptions; writes the title or description you approve. |
| Inventory Watcher (existing) | `read_products`, `read_inventory`, `read_locations` (+ `write_products` only when widened past drafts) | no | Low | Already in the install scopes. |
| Supplier Chaser (existing) | `read_products`, `read_inventory` | no | Low | Already in the install scopes; email goes from the agent's own address. |
| Customer Care | `read_orders`, `read_customers` | **yes** (both) | High: the broadest customer data of any agent | Looks up the order a message is about and drafts the reply with the real tracking link and the customer's name. Message content comes from what the merchant forwards or copies to the agent, never from the customer's inbox. |
| Campaign | `read_products`, `read_discounts` | no | Low | Reads the products and any active discount code to draft the email. Never sends to customers. |
| Promo Manager | `read_products`, `read_inventory`, `read_discounts`, `write_discounts` | no | Medium: creates and ends discount codes (money) | Proposes codes for slow stock, creates the code you approve with its end date, ends codes past their date. Every write is approval-only. |
| Weekly Insights | `read_orders`, `read_products`, `read_inventory` | **yes** (`read_orders`, aggregate only) | Medium: order totals, no customer fields displayed | Counts orders and revenue by week and by product. Customer fields are not shown; the summary is aggregate. |
| Payout and Fees Checker | `read_orders`, `read_shopify_payments_payouts` | **yes** (`read_orders`) | Medium: financial data | Reconciles each payout against the orders it covers and checks the fees against the merchant's expected rate. |
| Store Health Checker (existing) | `read_products`, `read_inventory`, `read_locations` | no | Low | Already in the install scopes. |
| AI Visibility | `read_products`, `read_publications` | no | Low | Checks which products are published to the Agentic sales channel and whether each listing has what an AI shopping assistant needs. Recommends; never publishes. |

Scope totals if every agent were installed: `read_products`, `write_products`, `read_inventory`, `read_locations`,
`read_publications`, `read_orders`, `read_fulfillments`, `read_returns`, `write_returns`, `read_customers`,
`read_discounts`, `write_discounts`, `read_shopify_payments_payouts`. Of these, **`read_orders`, `read_fulfillments`,
`read_returns`, `write_returns` and `read_customers` are protected customer data scopes** and need the data
protection questionnaire plus a per-field justification, and `read_shopify_payments_payouts` is financial data
that reviewers look at closely.

## Recommended approach for review

Request scopes **per tier and per agent**, at runtime, only when the merchant switches the agent on (the same
optional-scope pattern the other session built for `write_products`). A Starter merchant then never grants a
customer data scope, and the App Store listing can state that plainly. Starter needs only the current install
scopes; Growth adds `read_orders`, `read_fulfillments`, `read_discounts`, `write_discounts`, `read_publications`;
Pro adds `read_returns`, `write_returns`, `read_customers`, `read_shopify_payments_payouts`.

## Draft App Store justification text (protected customer data)

**Purpose of use (all protected scopes).** Deploi AI provides merchant-controlled agents that draft routine store
work for the merchant to approve. Customer data is read only for the agent the merchant switched on, only to do
that agent's job, and is shown only to the merchant's own staff inside the app. It is never used for advertising,
profiling, resale or model training, and it is never shared with another merchant or a third party.

**`read_orders` (Order Tracker, Weekly Insights, Payout and Fees Checker, Customer Care, Returns).** Order
number, dates, fulfilment status and tracking are read to identify stuck or late orders, to total sales by week,
and to match payouts to orders. The customer's first name and email are read only by Order Tracker and Customer
Care, to address a drafted message the merchant sends. Weekly Insights and Payout and Fees Checker use aggregate
figures and display no customer fields.

**`read_fulfillments` (Order Tracker).** Fulfilment and tracking events are read to tell "shipped" from "stuck".

**`read_returns`, `write_returns` (Returns).** Return requests, their reason and timing are read to apply the
merchant's own return policy; the only write is setting a request to approved after the merchant approves it in
Deploi. Refunds are never issued by the app.

**`read_customers` (Customer Care).** The customer record behind a message the merchant forwarded is read to
address the reply and attach the right order. No customer list is ever fetched; access is per record, on demand.

**Retention and deletion.** Deploi stores the evidence an agent used (order number, dates, status, the drafted
text) with the action record, for the merchant's audit trail, and deletes it with the store on uninstall or on a
`shop/redact` request. `customers/redact` and `customers/data_request` are handled by the existing compliance
webhook. Message content from customers is never stored outside the merchant's own action records.

**Minimisation.** Each agent requests its scopes only when switched on, and a merchant on a plan that does not
include an agent is never asked for that agent's scopes.
