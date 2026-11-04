# Data Processing Addendum

> **DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH**
>
> Working draft for legal review. The Standard Contractual Clauses are referenced, not reproduced, and
> the annexes must be completed and checked by counsel before use.

| Field | Value |
|---|---|
| Document key | `dpa` |
| Version | 0.1.0-draft |
| Effective date | [EFFECTIVE DATE — set on publication] |
| Last updated | 2026-11-04 |

This Data Processing Addendum ("**DPA**") forms part of the Terms of Service between the Customer and
**[COMPANY LEGAL NAME]** d/b/a Deploi AI ("**Deploi**") and applies whenever Deploi processes Customer
Personal Data on the Customer's behalf.

## 1. Definitions

"**Data Protection Laws**" means the GDPR (Regulation (EU) 2016/679), the UK GDPR and Data Protection
Act 2018, the Swiss FADP, the California Consumer Privacy Act as amended by the CPRA ("**CCPA**") and
other US state privacy laws, each as applicable. "**Customer Personal Data**" means personal data in
Customer Data that Deploi processes on the Customer's behalf. "**Controller**", "**Processor**",
"**Data Subject**", "**Personal Data Breach**", "**Business**", "**Service Provider**" and
"**Processing**" have the meanings in the Data Protection Laws. "**Subprocessor**" means a third party
Deploi engages to process Customer Personal Data.

## 2. Roles and instructions

2.1 The Customer is the Controller (Business) and Deploi is the Processor (Service Provider) of Customer
Personal Data.

2.2 Deploi processes Customer Personal Data only on the Customer's documented instructions. The
Customer's instructions are: these Terms; the configuration of the Service, in particular each Agent's
granted **Authorization** (the numbered rule set that names the tools, the records, the fields, the
recipients, the limits and the permission level); approvals given in the Service; and other written
instructions agreed by the parties. An Agent cannot process data outside its granted Authorization: the
Service checks the Authorization at the moment of each action and refuses and logs anything else.

2.3 Deploi will inform the Customer if, in its opinion, an instruction infringes Data Protection Laws.

2.4 **CCPA.** Deploi will not sell or share Customer Personal Data; will not retain, use or disclose it
for any purpose other than the business purposes in Annex 1 or outside the direct business relationship;
will not combine it with personal information received from others except as the CCPA permits; and will
comply with the CCPA and notify the Customer if it can no longer do so. The Customer may take reasonable
steps to stop and remediate unauthorized use.

## 3. Deploi's obligations

3.1 **Confidentiality.** Personnel with access are bound by confidentiality. Deploi staff access to
customer organizations is read-only in the application (staff cannot approve or make changes for a
customer) and is logged.

3.2 **Security.** Deploi implements the technical and organizational measures in Annex 2.

3.3 **Subprocessors.** The Customer gives general authorization to the Subprocessors in the Subprocessor
List (`subprocessors`). Deploi will give at least [30] days' notice of a new Subprocessor by updating the
list and e-mailing account owners who subscribe to notices; the Customer may object on reasonable data
protection grounds, and if the parties cannot resolve the objection the Customer may terminate the
affected Service and receive a pro-rata refund of prepaid fees. Deploi imposes data protection terms on
each Subprocessor that are no less protective than this DPA and remains responsible for them.

Platforms the Customer connects (its own Shopify store, WooCommerce site, HubSpot portal, Google or
Microsoft account) are **chosen and contracted by the Customer**. Deploi reads from and writes to them on
the Customer's instruction; the Customer's own agreement with each platform governs the platform's
processing. [COUNSEL: confirm whether to treat these as Subprocessors or as Customer-instructed
recipients — see REVIEW-CHECKLIST D-2.]

3.4 **Data Subject requests.** Deploi will, taking into account the nature of the processing, assist the
Customer by appropriate measures to respond to Data Subject requests, and will forward to the Customer
any request it receives directly that relates to Customer Personal Data. For Shopify stores, Deploi
honours Shopify's mandatory privacy webhooks (`customers/data_request`, `customers/redact`,
`shop/redact`).

3.5 **Personal Data Breach.** Deploi will notify the Customer without undue delay, and in any case within
**[48] hours**, after becoming aware of a Personal Data Breach affecting Customer Personal Data, with the
information reasonably available (nature, categories and approximate numbers, likely consequences,
measures taken), updated as more becomes known.

3.6 **Assistance.** Deploi will reasonably assist with data protection impact assessments and prior
consultations relating to the Service.

3.7 **Deletion and return.** On termination, or when the Customer disconnects a Connected Account,
Deploi deletes the related Customer Personal Data within [30] days (for Shopify, on receipt of
`shop/redact`), except where law requires retention. The Customer may export its data and work log
before deletion. Encrypted backups are overwritten on the provider's rotation ([COUNSEL: state period]).

3.8 **Audits.** Deploi will make available the information necessary to demonstrate compliance with this
DPA, including the Security Overview and, when available, third-party reports of its Subprocessors. The
Customer may audit, at its cost, on [30] days' notice, no more than once a year unless a breach
occurred, under confidentiality and without access to other customers' data.

## 4. International transfers

Where Customer Personal Data is transferred from the EEA, UK or Switzerland to a country without an
adequacy decision, the parties agree to the EU Standard Contractual Clauses (Commission Implementing
Decision (EU) 2021/914), **Module Two** (controller to processor), incorporated by reference, with:
Clause 7 (docking) applying; Clause 9 option 2 (general authorization, notice period as in 3.3);
Clause 11 optional language not applying; Clause 17 governed by the law of [Ireland]; Clause 18 courts
of [Ireland]; Annexes as in this DPA. For UK transfers, the UK International Data Transfer Addendum
applies; for Swiss transfers, the FADP references apply. [COUNSEL: confirm.]

## 5. Customer obligations

The Customer is responsible for: having a lawful basis and giving the notices needed for Deploi to
process Customer Personal Data (including telling its own customers and contacts that it uses service
providers for order handling, customer service and e-mail); the lawfulness of the recipients and content
of messages its Agents send; granting only the platform scopes it needs; and not instructing Agents to
process special-category data (health, biometric and similar) or data of children, which the Service is
not designed for.

## 6. Liability

Each party's liability under this DPA is subject to the limitations in the Terms, to the extent Data
Protection Laws allow.

---

## Annex 1 — Description of the processing

| Item | Description |
|---|---|
| Subject matter | Providing the Deploi Service: agents that read connected business systems, find issues and tasks, draft changes and messages, and, within the granted Authorization, make changes and send messages, with verification and an audit trail |
| Duration | The term of the Terms, plus the deletion period in 3.7 |
| Nature and purpose | Collection through platform APIs, storage, comparison and analysis, drafting, transmission (writes back to the Customer's platforms; e-mail sending), verification reads, logging, deletion |
| Categories of data subjects | The Customer's end customers (shoppers, buyers); the Customer's CRM contacts and leads; the Customer's suppliers; the Customer's staff and users of the Service; correspondents of agent mailboxes |
| Categories of personal data | Names, e-mail addresses, phone numbers, shipping and billing addresses, order and return history, customer-service message content, CRM records (company, deal, notes, tasks), calendar availability and events, e-mail metadata and content of agent-sent mail and replies, Shopify staff user IDs |
| Special categories | None intended. The Customer must not instruct Agents to process them |
| Frequency | Continuous while Agents are switched on, on schedules and triggers the Customer sets |
| Retention | As in the Privacy Policy section 5 and section 3.7 above |

## Annex 2 — Technical and organizational measures

1. **Tenant isolation**: every table holding customer data has Postgres row-level security; a user
   session can read only its own organization's rows; the service role is used only by server code after
   an explicit organization check. Automated tests enumerate every table and fail if one lacks RLS or a
   scoped policy, and check that one organization's session reads none of another's rows.
2. **Encryption**: TLS in transit; platform access tokens and mailbox tokens encrypted with AES-256-GCM
   at the application layer with a key held outside the database; agent message content encrypted at
   rest; database and backups encrypted at rest by the hosting provider.
3. **Credentials**: credential tables are not readable by any user role; tokens are never sent to the
   browser.
4. **Least privilege for agents**: per-tool permission levels (drafts only, after approval, within
   limits), per-field and per-recipient limits, daily caps, end dates, re-read before write, verification
   after write, pause/revoke that also cancels queued work, and an incident switch that pauses all live
   writes.
5. **Webhooks**: Shopify (HMAC-SHA256), Resend (svix) and Stripe (`Stripe-Signature`, 5-minute tolerance)
   signatures verified with constant-time comparison; replays deduplicated by event id.
6. **Outbound boundary**: every outbound request is checked against an approved host list per purpose;
   private network addresses are refused.
7. **Logging and audit**: inserts, updates and deletes audited by database trigger; agent actions
   recorded in the work log; logs redact personal fields.
8. **Access control**: production refuses development sign-in at build, start-up and runtime; sign-in by
   one-time e-mail link; staff access read-only and logged.
9. **Secure development**: code review before merge, automated tests including security tests, secret
   scanning of the repository, dependency updates.
10. **Incident response and continuity**: documented runbook, rollback procedure, provider backups.

## Annex 3 — Subprocessors

See the Subprocessor List (`subprocessors`), which forms part of this DPA.
