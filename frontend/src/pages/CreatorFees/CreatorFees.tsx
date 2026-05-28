import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, SendTransactionError, SystemProgram } from '@solana/web3.js'
import useProgram from '../../utils/useProgram'
import { getAuthAddress } from '../../utils/pda'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import { logActivity } from '../../utils/activity'
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

const CreatorFees = () => {
  const program = useProgram()
  const navigate = useNavigate()
  const { connection } = useConnection()
  const wallet = useWallet()

  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pools, setPools] = useState<PoolCandidate[]>([])
  const [collecting, setCollecting] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)

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

    const creatorToken0 = getAssociatedTokenAddressSync(
      pool.token0Mint,
      wallet.publicKey,
      false,
      pool.token0Program
    )
    const creatorToken1 = getAssociatedTokenAddressSync(
      pool.token1Mint,
      wallet.publicKey,
      false,
      pool.token1Program
    )

    setCollecting(pool.poolPda.toBase58())
    setStatus('Collecting creator fees...')
    setErrorDetails(null)
    setTxResult(null)

    try {
      const signature = await (program.methods as any)
        .collectCreatorFee()
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
    return <div className="creator-fees-page"><div className="creator-fees-empty">Connect your wallet to view creator fee pools.</div></div>
  }

  return (
    <div className="creator-fees-page">
      <div className="creator-fees-hero">
        <div>
          <div className="creator-fees-kicker">Portfolio</div>
          <h1>Collect creator fees</h1>
          <p>Pools you created with creator fees enabled are listed here, along with their pending fee balances.</p>
        </div>
        <div className="creator-fees-hero-actions">
          <button type="button" className="creator-fees-secondary" onClick={() => navigate('/portfolio')}>
            Back to portfolio
          </button>
          <button type="button" className="creator-fees-primary" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="creator-fees-stats">
        <div className="creator-fees-stat">
          <span>Eligible pools</span>
          <strong>{pools.length}</strong>
        </div>
        <div className="creator-fees-stat">
          <span>Ready to collect</span>
          <strong>{readyToCollect}</strong>
        </div>
        <div className="creator-fees-stat">
          <span>Pending fee pairs</span>
          <strong>{pools.length}</strong>
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

      <div className="creator-fees-panel">
        <div className="creator-fees-panel-head">
          <h2>Creator fee pools</h2>
          <span>{loading ? 'Loading...' : `${pools.length} pools`}</span>
        </div>

        {loading ? (
          <div className="creator-fees-empty">Loading creator fee pools...</div>
        ) : pools.length === 0 ? (
          <div className="creator-fees-empty">No creator-fee pools found for this wallet.</div>
        ) : (
          <div className="creator-fees-list">
            {pools.map((pool) => {
              const total = pool.creatorFees0 + pool.creatorFees1
              const hasFees = total > 0n
              return (
                <div className="creator-fees-row" key={pool.poolPda.toBase58()}>
                  <div className="creator-fees-row-main">
                    <div className="creator-fees-pair">
                      {pool.token0Mint.toBase58().slice(0, 4)}... / {pool.token1Mint.toBase58().slice(0, 4)}...
                    </div>
                    <div className="creator-fees-meta">
                      <span>Pool {pool.poolPda.toBase58().slice(0, 8)}...</span>
                      <span>Creator fee mode {pool.creatorFeeOn}</span>
                    </div>
                  </div>
                  <div className="creator-fees-amounts">
                    <span>{formatTokens(pool.creatorFees0, pool.decimals0)} token0</span>
                    <span>{formatTokens(pool.creatorFees1, pool.decimals1)} token1</span>
                  </div>
                  <div className="creator-fees-actions">
                    <span className={`creator-fees-pill ${hasFees ? 'live' : ''}`}>{hasFees ? 'Ready to collect' : 'No pending fees'}</span>
                    <button
                      type="button"
                      className="creator-fees-primary"
                      disabled={collecting === pool.poolPda.toBase58() || !hasFees}
                      onClick={() => void collectFees(pool)}
                    >
                      {collecting === pool.poolPda.toBase58() ? 'Collecting...' : 'Collect'}
                    </button>
                  </div>
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