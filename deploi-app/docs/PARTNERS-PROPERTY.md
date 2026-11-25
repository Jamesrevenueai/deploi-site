# Property management partners

What each property-management platform requires before Deploi can integrate. Sources are marked:
**[web 2026-11]** found in public sources this week (mostly third-party integration guides, not the vendor's own
terms); **[prior]** from prior knowledge, not re-checked. **Every fee and timeline must be confirmed with the vendor
before signing.** Buildium is already built (API key, docs/CONNECTIONS.md).

## Apply now

### Rent Manager (London Computer Systems)
- **Apply for:** the Rent Manager Integrations Program (rentmanager.com, "Become an Integration" request form). [web 2026-11]
- **Process:** request form, then a call about the business; Rent Manager then sends API documentation and access to a
  test portal; the finished integration is approved through the Partner Web Access site. [web 2026-11]
- **Requires:** a signed integration agreement; production calls use a **partner token** (with each customer's
  entity/corporate id); the **calling IP addresses must be allow-listed**, so Deploi needs fixed egress IPs (Vercel static
  IPs or an egress proxy). [web 2026-11]
- **Fees:** paid program. One integrator guide lists about **$3,000 per year plus a monthly per-customer fee** (the greater
  of $50 or a per-transaction fee); an older version says $50 per client per month. Confirm. [web 2026-11]
- **Expected timeline:** about 1 week to contract per the integrator guide; build and approval after that (estimate 4-8 weeks total). [web 2026-11 / estimate]

### ResMan
- **Apply for:** the ResMan partner program (myresman.com "Partner with ResMan" / "Join the ResMan+ Partner Integration
  Network" application form). [web 2026-11]
- **Process:** application, review of the use case and integration scope, then API documentation and credentials; each
  customer's Account ID comes from ResMan. Access is not self-serve and is authorized per customer account. [web 2026-11]
- **Tiers / fees:** public pages describe Silver and Platinum tiers (Silver: "minimal fee" for API integration) and a
  Certified ResMan+ Partner level described as free for most service integrations, with a small co-branding requirement.
  Confirm which applies to an AI leasing/operations product. [web 2026-11]
- **Expected timeline:** about **2-4 months** from application to integration setup (integrator guide). [web 2026-11]

### Rently (self-guided tours, smart locks)
- **Apply for:** partner API credentials through Rently (no public self-serve sign-up found); start with Rently's public
  API documentation (ReadMe site: tour scheduling, lock codes, smart home), then contact Rently partnerships / a Client
  Success Manager for partner client credentials and tour webhooks. [web 2026-11]
- **Requires:** credentials and webhooks provisioned by Rently staff; some features are paid tiers; the CRM
  registration piece is an embedded iframe with postMessage callbacks, not REST. [web 2026-11]
- **Fees / timeline:** not published; expect a partner agreement. Estimate 4-8 weeks. [estimate]

## List only (not applying yet)

| Platform | What it takes | Source |
| --- | --- | --- |
| **Yardi** (Voyager, Breeze) | Yardi Standard Interface Partnership Program: application, annual partner fee (historically tens of thousands of dollars per interface type), legal agreement, certification/testing of each interface (e.g. ILS/Guest Card, Resident Data), and the customer must license the interface. Breeze has more limited API access. Long lead time (months). | [prior] |
| **RealPage** | RealPage Exchange (RPX) partner program: application, partner agreement and fees, certification of the integration; customers enable it per property. RealPage also owns Knock and other leasing tools, which affects partner approval for competing products. | [prior] |
| **Entrata** | Entrata API / Marketplace partner program: application and approval, partner agreement, per-property or per-call pricing, review of the integration before customers can enable it. | [prior] |
| **AppFolio** | AppFolio Stack partner program: application and approval, partner agreement, certification; integrations listed in the Stack marketplace; API access is through the program (no general public API for property data). | [prior] |
| **Knock** (RealPage) | Partner/API access through Knock (now part of RealPage) for CRM and lead data; partner agreement; RealPage partner policies apply. | [prior] |
| **Funnel** (Funnel Leasing) | Partner API program for leasing CRM data (prospects, appointments); partner agreement and approval; terms not published. | [prior] |

## What Deploi needs for any of them
- A partner agreement signed by the founder (Deploi cannot sign up on a customer's behalf).
- Fixed outbound IPs if the vendor allow-lists callers (Rent Manager does).
- A security questionnaire (SOC 2 is often asked for; Deploi has docs/SECURITY-REVIEW-2026-11-04.md to start from).
- One pilot customer on that platform willing to enable the integration on a test property.

Sources [web 2026-11]: docs.propexo.com (Rent Manager approval/QA process and integration credentials; ResMan approval and
setup), rentmanager.com integrations pages, myresman.com/partner-with-resman, go.myresman.com/join-resman-partner-integration-network,
supergood.ai API report cards (Rent Manager, ResMan, Rently), apitracker.io/a/rently, AppFolio-Rently integration press release (Dec 2025).
