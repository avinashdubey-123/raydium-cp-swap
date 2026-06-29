import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SendTransactionError, SystemProgram } from '@solana/web3.js'
import useProgram from '../../utils/useProgram'
import { getAuthAddress } from '../../utils/pda'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import { logActivity } from '../../utils/activity'
import useTokenProgramAta from '../../hooks/useTokenProgramAta'
import './CreatorFees.css'


type PoolCandidate = {
  poolPda: PublicKey
  poolCreator: PublicKey
  ammConfig: PublicKey
  token0Mint: PublicKey
  token1Mint: PublicKey
  token0Program: PublicKey
  token1Program: PublicKey
  token0Vault: PublicKey
  token1Vault: PublicKey
  decimals0: number
  decimals1: number
  creatorFeeOn: number
  creatorFees0: bigint
  creatorFees1: bigint
  token0Symbol?: string
  token1Symbol?: string
}

const toPublicKey = (value: unknown): PublicKey | null => {
  try {
    if (value instanceof PublicKey) return value
    if (typeof value === 'string') return new PublicKey(value)
    if (value && typeof (value as { toBase58?: () => string }).toBase58 === 'function') {
      return new PublicKey((value as { toBase58: () => string }).toBase58())
    }
    return null
  } catch {
    return null
  }
}

const toBigIntSafe = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && value.length > 0) return BigInt(value)
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    const text = (value as { toString: () => string }).toString()
    if (text.length > 0) return BigInt(text)
  }
  return 0n
}

const getField = (account: any, ...keys: string[]) => {
  for (const key of keys) {
    if (account?.[key] !== undefined) return account[key]
  }
  return undefined
}

const formatTokens = (amount: bigint, decimals: number) => {
  const value = amount.toString()
  if (decimals <= 0) return value
  const padded = value.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction.length ? `${whole}.${fraction}` : whole
}

const getTokenColor = (symbol: string): string => {
  let hash = 0
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 40%)`
}

const CreatorFees = () => {
  const program = useProgram()
  const navigate = useNavigate()
  const { connection } = useConnection()
  const wallet = useWallet()
  const { deriveAta, buildEnsureAtaInstruction } = useTokenProgramAta()

  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pools, setPools] = useState<PoolCandidate[]>([])
  const [collecting, setCollecting] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})

  const toggleRow = (rowKey: string) => {
    setExpandedRows((current) => ({
      ...current,
      [rowKey]: !current[rowKey],
    }))
  }

  const loadPools = async () => {
    if (!program || !wallet.publicKey) {
      setPools([])
      return
    }

    const poolNamespace = (program.account as any).poolState
    if (!poolNamespace?.all) {
      setPools([])
      return
    }

    const allPools = await poolNamespace.all()
    const creator = wallet.publicKey.toBase58()
    const filtered: PoolCandidate[] = []

    for (const { publicKey, account } of allPools) {
      const poolCreator = toPublicKey(getField(account, 'poolCreator', 'pool_creator'))
      if (!poolCreator || poolCreator.toBase58() !== creator) continue

      const enableCreatorFee = Boolean(getField(account, 'enableCreatorFee', 'enable_creator_fee'))
      if (!enableCreatorFee) continue

      const poolPda = toPublicKey(publicKey)
      const ammConfig = toPublicKey(getField(account, 'ammConfig', 'amm_config'))
      const token0Mint = toPublicKey(getField(account, 'token0Mint', 'token_0_mint', 'token0_mint'))
      const token1Mint = toPublicKey(getField(account, 'token1Mint', 'token_1_mint', 'token1_mint'))
      const token0Program = toPublicKey(getField(account, 'token0Program', 'token_0_program', 'token0_program'))
      const token1Program = toPublicKey(getField(account, 'token1Program', 'token_1_program', 'token1_program'))
      const token0Vault = toPublicKey(getField(account, 'token0Vault', 'token_0_vault', 'token0_vault'))
      const token1Vault = toPublicKey(getField(account, 'token1Vault', 'token_1_vault', 'token1_vault'))

      if (!poolPda || !ammConfig || !token0Mint || !token1Mint || !token0Program || !token1Program || !token0Vault || !token1Vault) continue

      filtered.push({
        poolPda,
        poolCreator,
        ammConfig,
        token0Mint,
        token1Mint,
        token0Program,
        token1Program,
        token0Vault,
        token1Vault,
        decimals0: Number(getField(account, 'mint0Decimals', 'mint_0_decimals', 'mintDecimals0') ?? 6),
        decimals1: Number(getField(account, 'mint1Decimals', 'mint_1_decimals', 'mintDecimals1') ?? 6),
        creatorFeeOn: Number(getField(account, 'creatorFeeOn', 'creator_fee_on') ?? 0),
        creatorFees0: toBigIntSafe(getField(account, 'creatorFeesToken0', 'creator_fees_token_0')),
        creatorFees1: toBigIntSafe(getField(account, 'creatorFeesToken1', 'creator_fees_token_1')),
        token0Symbol: getField(account, 'token0Symbol', 'token_0_symbol'),
        token1Symbol: getField(account, 'token1Symbol', 'token_1_symbol'),
      })
    }

    filtered.sort((left, right) => {
      const leftTotal = left.creatorFees0 + left.creatorFees1
      const rightTotal = right.creatorFees0 + right.creatorFees1
      if (leftTotal === rightTotal) return left.poolPda.toBase58().localeCompare(right.poolPda.toBase58())
      return rightTotal > leftTotal ? 1 : -1
    })

    setPools(filtered)
  }

  useEffect(() => {
    let mounted = true

    const run = async () => {
      try {
        setLoading(true)
        setStatus(null)
        await loadPools()
      } catch (err: any) {
        if (mounted) {
          setStatus(err?.message || String(err))
          setPools([])
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }

    run()

    return () => {
      mounted = false
    }
  }, [program, wallet.publicKey, connection])

  const readyToCollect = useMemo(() => pools.filter((pool) => pool.creatorFees0 + pool.creatorFees1 > 0n).length, [pools])

  const refresh = async () => {
    setRefreshing(true)
    setStatus(null)
    setErrorDetails(null)
    setTxResult(null)
    try {
      await loadPools()
    } catch (err: any) {
      setStatus(err?.message || String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const collectFees = async (pool: PoolCandidate) => {
    if (!program || !wallet.publicKey) return

    const programId = (program as any).programId as PublicKey
    const [authority] = await getAuthAddress(programId)

    const creatorToken0 = deriveAta(wallet.publicKey, pool.token0Mint, pool.token0Program)
    const creatorToken1 = deriveAta(wallet.publicKey, pool.token1Mint, pool.token1Program)

    setCollecting(pool.poolPda.toBase58())
    setStatus('Collecting creator fees...')
    setErrorDetails(null)
    setTxResult(null)

    try {
      const creatorToken0AtaCtx = await buildEnsureAtaInstruction({
        payer: wallet.publicKey,
        owner: wallet.publicKey,
        mint: pool.token0Mint,
        tokenProgram: pool.token0Program,
      })
      const creatorToken1AtaCtx = await buildEnsureAtaInstruction({
        payer: wallet.publicKey,
        owner: wallet.publicKey,
        mint: pool.token1Mint,
        tokenProgram: pool.token1Program,
      })
      const preIxs = [
        ...(creatorToken0AtaCtx.instruction ? [creatorToken0AtaCtx.instruction] : []),
        ...(creatorToken1AtaCtx.instruction ? [creatorToken1AtaCtx.instruction] : []),
      ]

      const signature = await (program.methods as any)
        .collectCreatorFee()
        .preInstructions(preIxs)
        .accounts({
          creator: wallet.publicKey,
          authority,
          poolState: pool.poolPda,
          ammConfig: pool.ammConfig,
          token0Vault: pool.token0Vault,
          token1Vault: pool.token1Vault,
          vault0Mint: pool.token0Mint,
          vault1Mint: pool.token1Mint,
          creatorToken0,
          creatorToken1,
          token0Program: pool.token0Program,
          token1Program: pool.token1Program,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed' })

      setTxResult({ sig: signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` })
      logActivity({
        actionType: 'Fee Collection',
        poolAddress: pool.poolPda.toBase58(),
        tokenPair: `${pool.token0Mint.toBase58().slice(0, 4)}.../${pool.token1Mint.toBase58().slice(0, 4)}...`,
        signature,
        status: 'success',
      })
      setStatus(null)
      await loadPools()
    } catch (err: any) {
      console.error('Collect fees error:', err)
      logActivity({
        actionType: 'Fee Collection',
        poolAddress: pool.poolPda.toBase58(),
        tokenPair: `${pool.token0Mint.toBase58().slice(0, 4)}.../${pool.token1Mint.toBase58().slice(0, 4)}...`,
        status: 'failed',
      })
      if (err instanceof SendTransactionError) {
        const logs = await err.getLogs(connection).catch(() => null)
        setErrorDetails(logs?.length ? logs.join('\n') : err.message || String(err))
        setStatus('Transaction failed. View details for logs.')
      } else {
        setStatus(`Error: ${err?.message || String(err)}`)
      }
    } finally {
      setCollecting(null)
    }
  }

  if (!wallet.connected) {
    return (
      <div className="cf-wrapper">
        <div className="cf-empty-card">Please connect your wallet to view creator fee pools.</div>
      </div>
    )
  }

  return (
    <div className="cf-wrapper">
      <div className="cf-header-section">
        <h1 className="cf-title">Collect creator fees</h1>
        <p className="cf-subtitle">Pools you created with creator fees enabled are listed here, along with their pending fee balances.</p>
      </div>

      <div className="cf-navigation-panel">
        <div className="cf-tab-buttons">
          <button className="cf-tab-btn active">Creator Pools</button>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="cf-btn-secondary" onClick={() => navigate('/portfolio')}>
            Back to portfolio
          </button>
          <button type="button" className="cf-btn-primary" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="cf-stats-row">
        <div className="cf-stat-card">
          <span className="cf-stat-label">Eligible pools</span>
          <strong className="cf-stat-value">{pools.length}</strong>
        </div>
        <div className="cf-stat-card">
          <span className="cf-stat-label">Ready to collect</span>
          <strong className="cf-stat-value">{readyToCollect}</strong>
        </div>
        <div className="cf-stat-card">
          <span className="cf-stat-label">Pending fee pairs</span>
          <strong className="cf-stat-value">{pools.length}</strong>
        </div>
      </div>

      {txResult && (
        <TransactionCard
          status="success"
          title="Fees Collected"
          message="Your creator fees have been successfully collected"
          explorerUrl={txResult.explorer}
          signature={txResult.sig}
          onClose={() => setTxResult(null)}
        />
      )}

      {status && !txResult && (
        <TransactionCard
          status={errorDetails ? 'error' : 'info'}
          title={errorDetails ? 'Collection Failed' : 'Status'}
          message={status}
          details={errorDetails}
          onClose={() => {
            setStatus(null)
            setErrorDetails(null)
          }}
        />
      )}

      <div className="cf-list-container">
        {loading ? (
          <div className="cf-empty-card">Loading creator fee pools...</div>
        ) : pools.length === 0 ? (
          <div className="cf-empty-card">No creator-fee pools found for this wallet.</div>
        ) : (
          <div className="cf-cards-list">
            {pools.map((pool) => {
              const total = pool.creatorFees0 + pool.creatorFees1
              const hasFees = total > 0n
              const sym0 = (pool.token0Symbol || pool.token0Mint.toBase58().slice(0, 4)).toUpperCase()
              const sym1 = (pool.token1Symbol || pool.token1Mint.toBase58().slice(0, 4)).toUpperCase()
              const avatar0 = sym0.slice(0, 2).toUpperCase()
              const avatar1 = sym1.slice(0, 2).toUpperCase()
              const poolKey = pool.poolPda.toBase58()
              const isExpanded = !!expandedRows[poolKey]

              return (
                <div className={`cf-card ${isExpanded ? 'expanded' : ''}`} key={poolKey}>
                  <div className="cf-card-header">
                    <div className="cf-card-pair-row">
                      <div className="cf-avatar-group">
                        <span className="cf-avatar-badge b0" style={{ backgroundColor: getTokenColor(sym0), color: '#ffffff', borderColor: 'transparent' }}>{avatar0}</span>
                        <span className="cf-avatar-badge b1" style={{ backgroundColor: getTokenColor(sym1), color: '#ffffff', borderColor: 'transparent' }}>{avatar1}</span>
                      </div>
                      <span className="cf-pair-title">
                        {sym0} / {sym1}
                      </span>
                    </div>

                    <div className="cf-card-composition">
                      <div className="cf-comp-item">
                        <span className="cf-comp-amount">{formatTokens(pool.creatorFees0, pool.decimals0)}</span>
                        <span className="cf-comp-symbol">{sym0}</span>
                      </div>
                      <div className="cf-comp-item">
                        <span className="cf-comp-amount">{formatTokens(pool.creatorFees1, pool.decimals1)}</span>
                        <span className="cf-comp-symbol">{sym1}</span>
                      </div>
                    </div>
                  </div>

                  <div className="cf-card-actions" style={{ justifyContent: 'space-between' }}>
                    <div className="cf-card-buttons">
                      <button
                        type="button"
                        className="cf-btn-primary"
                        disabled={collecting === poolKey || !hasFees}
                        onClick={() => void collectFees(pool)}
                      >
                        {collecting === poolKey ? 'Collecting...' : 'Collect'}
                      </button>
                      <span className={`cf-status-pill ${hasFees ? 'success' : 'empty'}`}>
                        {hasFees ? 'Ready to collect' : 'No pending fees'}
                      </span>
                    </div>

                    <button
                      type="button"
                      className={`cf-view-details-btn ${isExpanded ? 'active' : ''}`}
                      onClick={() => toggleRow(poolKey)}
                    >
                      {isExpanded ? 'Hide Details ▲' : 'View Details ▼'}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="cf-details-panel">
                      <div className="cf-details-grid">
                        <div className="cf-details-row">
                          <span className="cf-details-label">Pool Address</span>
                          <span className="cf-details-val-mono">{poolKey}</span>
                        </div>
                        <div className="cf-details-row">
                          <span className="cf-details-label">AMM Config</span>
                          <span className="cf-details-val-mono">{pool.ammConfig.toBase58()}</span>
                        </div>
                        <div className="cf-details-row">
                          <span className="cf-details-label">Creator Fee Mode</span>
                          <span className="cf-details-val-mono">{pool.creatorFeeOn}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default CreatorFees