import { useState } from 'react'
import { Icon } from '../lib/icons'
import { LeadForm } from './LeadForm'

/** Bottom-right chat bubble. No third-party widget; posts to the lead API with source="chat". */
export function ChatBubble() {
  const [cardOpen, setCardOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)

  return (
    <div className="chat">
      {panelOpen ? (
        <div className="chat-panel" role="dialog" aria-label="Chat with us">
          <div className="chat-panel-head">
            <strong>Chat with us</strong>
            <button type="button" className="nav-mobile-close" style={{ position: 'static' }} aria-label="Close chat" onClick={() => setPanelOpen(false)}>
              <Icon.Close width={22} height={22} />
            </button>
          </div>
          <LeadForm
            source="chat"
            compact
            cta="Send"
            messageLabel="Your question"
            messagePlaceholder="How can we help?"
            confirmation={{ title: 'Sent.', body: 'We’ll reply by email within one business day.' }}
          />
        </div>
      ) : (
        cardOpen && (
          <div className="chat-card" role="status">
            <span className="initial" aria-hidden="true">d</span>
            <span>Hi there! Have a question? Chat with us.</span>
            <button type="button" className="dismiss" aria-label="Dismiss" onClick={() => setCardOpen(false)}>
              <Icon.Close width={16} height={16} />
            </button>
          </div>
        )
      )}
      <button
        type="button"
        className="chat-btn"
        aria-label={panelOpen ? 'Close chat' : 'Open chat'}
        aria-expanded={panelOpen}
        onClick={() => {
          setPanelOpen(o => !o)
          setCardOpen(false)
        }}
      >
        {panelOpen ? <Icon.Close /> : <Icon.Chat />}
      </button>
    </div>
  )
}
