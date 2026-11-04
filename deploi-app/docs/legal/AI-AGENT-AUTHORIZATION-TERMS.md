# AI Agent Authorization Terms

> **DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH**
>
> Working draft for legal review. These terms describe the authorization model the Service actually
> enforces (`lib/agents/policy.ts`, `lib/engine/execute.ts`, `lib/email/*`, `docs/HOW-AGENTS-WORK.md`).
> If the product changes, these terms must change with it.

| Field | Value |
|---|---|
| Document key | `ai_agent_terms` |
| Version | 0.1.0-draft |
| Effective date | [EFFECTIVE DATE — set on publication] |
| Last updated | 2026-11-04 |

These terms are part of the Terms of Service. They explain what an Agent may do, what you are
responsible for when you grant it permission, and what Deploi does and does not promise.

## 1. What an Agent is

An Agent is software that runs in the Deploi Service on a schedule, on a trigger, or when you press
*Run now*. It reads the Connected Accounts you have given it, compares what it finds with its rules,
and produces work: a report, a draft change, a draft message, a proposed task, or, where you allow it, a
change made or a message sent. Agents may use templates and, in future, AI language models to write
drafts; whatever writes the draft, the **Authorization decides what may happen with it**.

## 2. The Authorization

2.1 **Your words are not the grant.** When you describe a job in plain language, Deploi turns it into a
form showing what it understood, what is missing and what it cannot do. Your sentence grants nothing.
The form you confirm becomes a numbered **Authorization version** that lists, in full: the tools
(store, CRM, calendar, e-mail), the permission level per tool, the records and fields in scope, the
allowed recipients, the numeric limits (per run, per day), the schedule, the end date, and the things the
Agent never does.

2.2 **Nothing runs before you grant it.** A new Agent is saved as a draft and does nothing until a
person in your organization presses **Grant** on the exact version shown. The Service binds the grant to
that version's fingerprint; if the version changes before you press Grant, the grant is refused.

2.3 **Permission levels.** Each tool has one of three levels:

| Level | What the Agent may do |
|---|---|
| **Drafts only** (default for every tool) | Show the exact change or message. It never makes or sends it. |
| **After my approval** | Nothing is written or sent until a person approves that exact item. |
| **Without asking, within limits** | Act on its own inside the records, fields, recipients and numbers you set, until an end date no more than one year away. Anything outside those limits waits for a person. |

2.4 **Widening needs a new grant; narrowing is immediate.** Any expansion (a higher level, more
records, more recipients, higher limits) creates a new version that must be granted again; until then
the previous version keeps running unchanged. A reduction takes effect at once.

2.5 **Checked at every action.** The Authorization is checked at the moment of each write or send, not
only when the Agent starts. Before a change, the Agent re-reads the record; if it changed since the
Agent looked, the Agent stops. After a change, a fresh read decides whether it is reported **verified**,
**failed** or **unknown** — never "done" without proof.

2.6 **Content is data, never instructions.** Text inside product descriptions, uploaded files, CRM notes
or incoming e-mails cannot add rules or widen an Authorization. Incoming mail from unknown senders, or
mail failing sender checks, is quarantined.

2.7 **Things an Agent never does**, whatever is granted: change stock counts, change product status,
delete products, invent prices or SKUs, make payments, issue refunds or buy anything [unless a future
feature says so expressly and you grant it separately], or change who has access to your accounts.

## 3. Who may grant and approve

You are responsible for deciding who in your organization may grant Authorizations and approve items,
and for their decisions. Anyone signed in to your organization (or any Shopify admin user of your store
using the embedded app) can grant and approve unless you restrict them [ROLE CONTROLS: see
REVIEW-CHECKLIST A-2]. Deploi staff can view your Agents for support but can never grant, approve or
change anything on your behalf.

## 4. Your responsibility for grants

4.1 You are responsible for every Authorization you grant and every item you approve, and for the
actions an Agent takes within them. If you grant *without asking, within limits*, you accept that the
Agent will act without further confirmation within those limits.

4.2 Before granting, read the rules as written out by the Service. Use the narrowest scope and the lowest
level that does the job, short end dates, and the per-day limits.

4.3 Make sure the platform permissions (for example Shopify scopes, HubSpot or Google OAuth consents)
you grant to Deploi are no wider than you intend Agents to use.

## 5. Revocation and stopping

5.1 You can **Pause** an Agent (stops everything and keeps the rules), **Revoke** its Authorization
(ends the rules) or **Delete** it (removes the Agent and closes its e-mail address) at any time. All three
also cancel changes and sends already queued. Uninstalling the app or disconnecting a Connected Account
stops every Agent that used it.

5.2 A change or message already accepted by a platform or an e-mail provider before you paused or revoked
cannot always be undone. The work log shows what was done and when.

5.3 Deploi may pause an Agent, or pause all live writes across the Service, to protect you, other
customers or a platform (for example during an incident or a suspected abuse) and will tell you why.

## 6. Audit trail

Every run, proposal, approval, change, message, refusal and verification is recorded with the time, the
Authorization version that allowed it, and who approved it. You can see it in each Agent's work log.
Deploi keeps the trail as described in the Privacy Policy and may use it to investigate disputes.

## 7. E-mail sent on your behalf

7.1 **You are the sender.** When an Agent sends e-mail — from its own address on Deploi's domain or from
a mailbox you connected — it sends **on your behalf and in your name**. For the purposes of the CAN-SPAM
Act, the Telephone Consumer Protection Act (if messaging is ever added), Canada's CASL, the EU/UK
ePrivacy rules and similar laws, **your business is the sender and the advertiser**, and Deploi provides
the tool. [COUNSEL: confirm characterization — REVIEW-CHECKLIST A-3.]

7.2 **Your responsibilities.** You are responsible for:

- having a lawful basis and, where required, **prior consent** for every recipient, and keeping records
  of it;
- the content: accurate sender identity and subject lines; identifying commercial messages as
  advertisements where the law requires; your **valid physical postal address** in commercial messages;
- a working **unsubscribe** mechanism in commercial messages, honouring opt-outs within **10 business
  days** (CAN-SPAM) or sooner where required, and never sending to people who opted out;
- not sending to purchased, rented or harvested lists;
- transactional and relationship messages (order updates, replies to a customer's own question,
  supplier follow-ups) staying transactional and not carrying marketing content that changes their
  classification.

7.3 **What the Service does to help, not instead of you.** Agents send only to the recipients and for
the purposes in their Authorization; marketing e-mail (for example Campaign drafts) is drafts-only or
after-approval; real sending is off by default in each environment until enabled; and messages carry the
agent's identity. These controls do not make your e-mail lawful by themselves.

7.4 **Deliverability and abuse.** We may suspend an agent address that generates complaints, bounces or
spam reports above provider thresholds, as Resend and mailbox providers require.

## 8. No guarantee of outcomes

Agents can be wrong: they may miss a problem, misread data, draft an unsuitable message, or a platform may
reject or alter a change. Deploi does **not** guarantee any business outcome — sales, recovered revenue,
fewer oversells, reply rates, search or AI-channel visibility, or savings — nor that an Agent's draft is
accurate, complete, lawful or suitable for your purpose. Review drafts before approving them. The Service's
verification confirms only that the field it changed reads back as expected; it does not confirm physical
stock, delivery, or that a recipient read a message.

## 9. Your remedies

If an Agent acts outside its granted Authorization because of a defect in the Service, tell us at once;
we will investigate using the audit trail, help you reverse the change where the platform allows, and fix
the defect. [COUNSEL: whether to offer a specific service credit or remedy — REVIEW-CHECKLIST A-5.] This
section is subject to the limitation of liability in the Terms.
