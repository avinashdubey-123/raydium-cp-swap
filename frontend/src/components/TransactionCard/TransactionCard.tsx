import { useState } from 'react'
import './TransactionCard.css'

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

  return (
    <div className={`tx-card tx-card--${status}`}>
      <div className="tx-card__header">
        <div className="tx-card__status">
          <span className="tx-card__badge">{statusLabel}</span>
          <div>
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
