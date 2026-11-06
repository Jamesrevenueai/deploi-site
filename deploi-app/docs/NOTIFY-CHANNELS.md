# Owner and crew updates: channels and going live

Deploi's agents act on their own and tell the owner after. Every update and every crew message goes through
`lib/notify` (`notifyOwner`, `notifyCrew`). This page says what each channel does today and exactly what is
needed before text messages and voice notes reach real phones.

## One crew roster

The crew is `crew_members` (**Settings → Crew**). Everything that messages a crew member uses it: notifyCrew, the
crew jobs and their "Mark done" links, the home-services and office dispatcher, and the commerce Order Tracker (its
packers are crew members with the role Packer). "Add a crew member" on a pack page writes the same roster.
`pack_crew_members` is **deprecated** (migration `20261107000062_pack_crew_roster.sql` copied its rows into
`crew_members` and repointed jobs); nothing reads or writes it, and it keeps its privacy export/erase entry until a
later release drops it.

## What runs today

| Channel | Today | What decides it |
| --- | --- | --- |
| Email to owners and admins | Real, through the system mailer (Resend) | `EMAIL_LIVE_SENDS`: `off` (default) holds every message; `allowlist` sends only to `EMAIL_TEST_RECIPIENTS`; `all` sends. No `RESEND_API_KEY` holds everything. |
| Email to crew | Real, same mailer and same gate | as above |
| Text message (owner and crew) | **Simulated**: stored in `notify_outbox`, nothing leaves | `NOTIFY_SMS_PROVIDER=simulated` (the default) |
| Voice note (owner) | **Simulated**: the transcript is stored in `notify_outbox`, nothing leaves | `NOTIFY_SMS_PROVIDER=simulated` |
| Inbound "DONE" reply by text | Parsed by `handleCrewReply` (tested), **not wired** to a provider webhook | needs the provider's inbound webhook (below) |
| "Mark done" link | Real: `/crew/done/<token>`, signed, single-use, expires after `CREW_LINK_TTL_HOURS` (36) | `APP_SECRET` (or `CREW_LINK_SECRET`, 16+ characters) |

Any other value of `NOTIFY_SMS_PROVIDER` (for example `twilio`) records each text and voice note as **held** with
the reason "not set up in this build": no live sender is built in yet, so nothing can leave by accident.

Owners choose their channels in **Settings → Updates from your team**: email on by default, text and voice off,
a phone number in international form (+15551234567), and a daily digest (routine updates wait for the morning
report; anything that needs a decision still goes at once).

## Going live with text messages (United States, Twilio as the example)

1. **Account.** Create a Twilio account for the business entity that sends (Deploi), upgrade from trial (trial
   accounts only text verified numbers and prefix every message).
2. **A2P 10DLC registration** (required for any application-to-person text to US numbers from a local number):
   - Register the **Brand** (Deploi's legal name, EIN, address, website, contact) in Twilio's Trust Hub.
     Secondary vetting is recommended for higher throughput.
   - Register a **Campaign** with use case "Account notifications" (owner updates) and, separately or as a
     mixed campaign, "Delivery notifications"/"Customer care" for crew job messages. Give real sample messages
     (copy them from `notify_outbox`), the opt-in description (below), and the opt-out/help keywords.
   - Approval usually takes days to a few weeks; unregistered traffic is blocked or heavily filtered by carriers.
   - Alternative: a **toll-free number** with toll-free verification (often faster; similar information).
3. **Phone number.** Buy a local 10DLC number (or the verified toll-free number) and attach it to a Messaging
   Service linked to the approved campaign.
4. **Environment** (set in Vercel for the environment that should send; never in the repository):
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (or an API key pair `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`)
   - `TWILIO_MESSAGING_SERVICE_SID` (preferred) or `TWILIO_FROM_NUMBER`
   - `NOTIFY_SMS_PROVIDER=twilio`
5. **Code to add** (one module, behind the existing interface): a `ChannelAdapter` in `lib/notify/` whose
   `sendText` POSTs to `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` (`To`, `MessagingServiceSid`,
   `Body`, `StatusCallback`), records the provider message id in `notify_outbox.provider_message_id`, and is
   selected in `channelAdapter()` for `twilio`. Keep the same gate idea as email: a `SMS_LIVE_SENDS` switch with an
   allowlist of test numbers before `all`.
6. **Webhooks to add** (classified in `tests/security/routes.test.ts`, signature verified with
   `X-Twilio-Signature` before anything else):
   - inbound messages → `handleCrewReply({ channel: 'text', from, text, messageId: MessageSid })` and STOP/HELP;
   - status callbacks → update `notify_outbox.status` (`sent`, `failed`, `undelivered`).

## Going live with voice notes

Today the voice note is its transcript (`voiceTranscript()`): what the voice would say, word for word, with links
spoken as "the link in your messages". To make it real:

1. **Text to speech**: Twilio `<Say>` with an Amazon Polly or Google voice (no extra account), or a separate TTS
   provider (ElevenLabs, Google Cloud TTS, Amazon Polly direct) producing an audio file Deploi hosts.
2. **Delivery**: an outbound call (`Calls.json` with TwiML `<Say>` or `<Play>`), or an MMS with the audio file.
   Outbound calls to US numbers need the number's voice capability, and **STIR/SHAKEN** attestation (A level for
   a number you own through Twilio). Calls that play recorded or synthetic voice are robocalls under the TCPA:
   prior **express written consent** is required.
3. Environment: the Twilio values above plus `NOTIFY_VOICE_PROVIDER` / the TTS provider's key if separate.

## Consent, STOP and compliance

- **Opt-in.** Text and voice are off by default. An owner turns them on for themselves in Settings and types their
  own number. For crew, the owner adds the number; before going live, add a confirmation text ("Reply YES to get
  job messages from <business> via Deploi") and send nothing else until YES arrives. Record when and how consent
  was given (a column on `crew_members` / `notify_preferences` with the timestamp and the message).
- **Identification.** Every text names the sender ("Deploi: ...") and the business.
- **STOP / HELP.** Honour STOP, UNSUBSCRIBE, CANCEL, END, QUIT (and START to resume) at once and for good, on
  every channel; answer HELP with who is sending and how to reach support. Twilio Advanced Opt-Out can answer for
  you, but Deploi must also turn `text_on`/`channels` off so nothing is queued again.
- **Quiet hours.** Do not text or call between 9 pm and 8 am in the recipient's time zone (several states
  restrict hours; Florida, Oklahoma and others have mini-TCPA rules). Hold until morning.
- **Content.** No shortened public URLs from shared shorteners (carriers filter them); use the app's own domain.
  No customer card or health data in texts.
- **Records.** Keep consent and opt-out records for at least four years (the TCPA statute of limitations).
- **Outside the US**: Canada (CASL), UK/EU (PECR/GDPR: consent, purpose, data processing terms with the
  provider), Australia (Spam Act). Each needs its own sender registration rules (alphanumeric sender IDs, etc.).

## Costs to check before turning it on (prices change; confirm on the provider's pricing pages)

- Phone number rental (monthly, local vs toll-free).
- A2P 10DLC: one-time brand registration and vetting fees, campaign vetting fee, and a monthly campaign fee;
  carrier pass-through fees per message segment (vary by carrier, higher for unregistered traffic).
- Per-segment outbound and inbound SMS price (a segment is 160 GSM characters or 70 with emoji/Unicode; a crew job
  list with links is often 3 to 6 segments; owner updates are capped at 480 characters, about 3 segments).
- MMS price if voice notes are sent as audio.
- Outbound voice per minute, plus TTS cost (per character for premium voices).
- Toll-free verification (free at present, but message pricing differs).
- Budget guard: add a daily per-organization cap before `all`, like the email daily cap.

## Checklist for the founder

1. Twilio account upgraded, A2P 10DLC brand and campaign approved (or toll-free verified), number bought and
   attached to a Messaging Service.
2. Twilio values in Vercel (preview first), `NOTIFY_SMS_PROVIDER=twilio`, a test-number allowlist.
3. The Twilio adapter and the two signed webhooks merged (with tests), consent confirmation and STOP handling in.
4. Send to your own phone from preview; read `notify_outbox` and the Twilio log; then widen.
