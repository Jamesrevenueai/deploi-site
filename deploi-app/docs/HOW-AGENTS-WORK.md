# How agents work

One page, in plain English. Screens for every step are in `proof/screens/index.html`.

## From a job description to the first piece of work

1. **You describe the job.** Either pick a template (Inventory Watcher, Supplier Chaser, Store Health Checker, Competitor & Trend Watcher) or write the job in your own words, for example "Every 6 hours, stop products selling when they are out of stock, except anything tagged pre-order."
2. **Deploi turns your words into a form.** It shows what it understood ("overselling", "every 6 hours", "except pre-order"), what is still missing, and anything it cannot do. Your sentence grants nothing. The form is what counts, and you can change every choice in it.
3. **You choose the tools and the permission level for each tool.** The tools are your store and, if you want, email. Every tool starts at **drafts only**.
4. **You read the rules.** Deploi writes the rules out in full: what the agent may do, its limits, and a list of things it never does.
5. **You grant them.** Nothing happens before this. The agent is saved as a draft and does nothing until you press Grant.
6. **The agent does its first piece of work** when you press Run now, or on its schedule. It reads your store, finds problems that fit its rules, and records the exact change for each one. At drafts only, that is all it does: you see the change, and nothing is made.

## Where the rules come from

Only from what you granted. The rules are built from the form you confirmed, not from your sentence, and they are saved as a numbered version. Templates are just pre-filled forms, also at drafts only. Files you upload, such as a price list or SKU mapping, are read as data: Deploi takes the columns it knows and ignores everything else. Nothing in a file, a product description or an email can add a rule.

## Where permissions apply

Each tool has three levels:

- **Drafts only** (the default). The agent shows the exact change or email. It never makes or sends it.
- **After my approval.** Nothing is written or sent until you approve that exact item in Approvals.
- **Without asking, within limits.** It acts on its own, inside the products, fields, recipients and numbers you set, until an end date at most one year away. Anything outside those limits waits for you.

The level is checked at the moment of each action, not only when the agent starts. If you give an agent more (a higher level, more products, more recipients), that is saved as a new version which **you must grant again**. Until you do, the old version keeps running unchanged. Giving it less takes effect at once.

## What stops an agent doing something it should not

- **It can only do what is written in its granted version.** Everything else is refused and logged.
- **It re-reads before writing.** Just before a change, it reads the record again. If the record changed since the agent looked, it stops.
- **Every change is checked afterwards.** "Verified" means a fresh read shows the change. Anything else is reported as failed or unknown, never as done.
- **There are hard limits** on changes per run and per day, plus a loop guard so it cannot repeat the same change.
- **There are things it can never do**, whatever you grant: change stock counts, change product status, delete products, or invent prices or SKUs.
- **Email is fenced in.** It only goes to allowed recipients, for the stated purpose, from the agent's own address. Mail that arrives is shown to you. It never changes what the agent may do. Mail from unknown senders, or mail that fails sender checks, is quarantined.
- **Tasks you type later are checked against the rules.** Inside the rules, a task runs. Outside them, it waits for you to widen the agent. If Deploi cannot tell what you mean, or cannot do it, the task is refused and nothing runs.
- **You can stop it at any time.** Pause stops everything and keeps the rules. Revoke ends the rules. Delete removes the agent. All three stop changes that are already queued.
- **When it is unsure, it does nothing and asks.** A problem it cannot fix safely goes to "Needs a person".
- **Everything is in the work log**: what happened, when, why, and which permission allowed it.

## A short example for each template

- **Inventory Watcher.** Every day at 7:00 it finds the Ceramic Pour-Over Set selling at −2 available, with "Continue selling when out of stock" on. It drafts the change from On to Off and emails you an alert draft. Pre-order and backorder products are skipped. At drafts only, nothing is changed and nothing is sent.
- **Supplier Chaser.** Every day it finds products with 2 or fewer available and writes a restock request to your supplier from its own address, for example `supplier-chaser.ab12cd@agents.getdeploi.com`. At "after my approval" the request waits in Approvals; you approve it and it is sent. The supplier's reply ("We can ship Friday") appears under the request. If there is no reply after 3 days, it drafts one follow-up in the same thread.
- **Store Health Checker.** Once a week it checks the whole store for oversold products and products that keep selling when out of stock, and writes you a report: 5 problems found, 1 needs a person. It changes nothing. The report is a draft, or waits for your approval if you allowed sending.
- **Competitor & Trend Watcher.** You list a few competitor stores. It reads only their public pages, the same ones any visitor sees, and never touches your store.
  - **First check:** it records a starting point. Nothing on it is called new.
  - **Next morning:** it reports, for example, "Price down 16.9% on linen-and-loom.example: Linen Throw Blanket, 89.00 → 74.00", with the page address and the time it was seen.
  - **Across stores:** when similar oil pourers turn up as new or featured on three stores and you sell nothing like them, it suggests a possible opportunity, clearly labelled an inference.
  - **Never:** it never claims to know their sales or revenue. Those are not public.

  Details are in `COMPETITOR-WATCHER.md`.
