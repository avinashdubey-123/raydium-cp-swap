import { useState, useEffect } from 'react'
import './TransactionCard.css'

// Change this single value (milliseconds) to adjust how long the card stays visible
export const CARD_LIFETIME_MS = 6000
const CLOSE_ANIMATION_MS = 260

type TransactionCardProps = {
  status: 'success' | 'error' | 'info'
  title: string
  message: string
  explorerUrl?: string
  signature?: string
  details?: string | null
  onClose?: () => void
}

export default function TransactionCard({ status, title, message, explorerUrl, signature, details, onClose }: TransactionCardProps) {
  const [showDetails, setShowDetails] = useState(false)
  const statusLabel = status === 'success' ? 'OK' : status === 'error' ? 'ERR' : 'INFO'

  const [isClosing, setIsClosing] = useState(false)

  useEffect(() => {
    if (!onClose) return

    const startCloseTimer = window.setTimeout(() => {
      setIsClosing(true)
      // wait for the close animation to finish before calling parent's onClose
      window.setTimeout(() => {
        onClose()
      }, CLOSE_ANIMATION_MS)
    }, CARD_LIFETIME_MS)

    return () => {
      window.clearTimeout(startCloseTimer)
    }
  }, [onClose])

  return (
    <div
      className={`tx-card tx-card--${status} ${isClosing ? 'tx-card--closing' : ''}`}
      style={{ ['--tx-card-lifetime' as any]: `${CARD_LIFETIME_MS}ms` }}
    >
      <div
        className={`tx-card__progress-bar ${status === 'info' ? 'tx-card__progress-bar--info' : 'tx-card__progress-bar--timed'}`}
      />
      <div className="tx-card__header">
        <div className="tx-card__status">
          <span className="tx-card__badge">{statusLabel}</span>
          <div className="tx-card__text">
            <div className="tx-card__title">{title}</div>
            <div className="tx-card__message">{message}</div>
          </div>
        </div>
        {onClose && (
          <button className="tx-card__close" onClick={onClose} aria-label="Close">×</button>
        )}
      </div>

      {(explorerUrl && signature) && (
        <a className="tx-card__link" href={explorerUrl} target="_blank" rel="noreferrer">
          Open on Solana Explorer → {signature.slice(0, 8)}...{signature.slice(-6)}
        </a>
      )}

      {details && (
        <div className="tx-card__details">
          <button className="tx-card__details-btn" onClick={() => setShowDetails(s => !s)}>
            {showDetails ? 'Hide Details' : 'Details'}
          </button>
          {showDetails && (
            <pre className="tx-card__details-pre">{details}</pre>
          )}
        </div>
      )}
    </div>
  )
}
