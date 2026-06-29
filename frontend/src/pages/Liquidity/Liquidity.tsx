import { useNavigate } from 'react-router-dom'
import './Liquidity.css'
import { PublicKey } from '@solana/web3.js'
import { useEffect, useMemo, useState, useRef, memo } from 'react'
import copyIcon from '../../assets/copy.svg'
import swapIcon from '../../assets/swap.svg'
import { getShortTokenName, getPoolDisplayName } from '../../utils/token'
import { useGetPoolsQuery, fetchVaultBalancesBatch } from '../../store/solanaApi'
import { getPoolAddress } from '../../utils/pda'

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')
const BATCH_SIZE = 10

// Deterministic pleasing HSL color generation based on token symbol
function getTokenColor(symbol: string): string {
  let hash = 0
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 40%)`
}

function toFiniteNumber(value: any): number | null {
  const raw = typeof value === 'number'
    ? value
    : value?.toNumber
      ? value.toNumber()
      : Number(value?.toString?.() ?? value)
  return Number.isFinite(raw) ? raw : null
}

// Inline three-dot loader component
function InlineLoader() {
  return (
    <div className="inline-loader">
      <div></div>
      <div></div>
      <div></div>
      <div></div>
    </div>
  )
}

function PoolRow({ pool, navigate, ammConfigs, vaultBalances }: {
  pool: any
  navigate: any
  ammConfigs: any[]
  vaultBalances: { vault0Balance: number | null; vault1Balance: number | null } | null | undefined
}) {
  const token0 = pool.token0 ? new PublicKey(pool.token0) : undefined
  const token1 = pool.token1 ? new PublicKey(pool.token1) : undefined
  let sortedToken0 = token0
  let sortedToken1 = token1
  if (token0 && token1) {
    const cmp = Buffer.compare(token0.toBuffer(), token1.toBuffer())
    if (cmp > 0) {
      sortedToken0 = token1
      sortedToken1 = token0
    }
  }
  const ammConfig = pool.ammConfig ? new PublicKey(pool.ammConfig) : undefined

  const name0 = sortedToken0 ? getShortTokenName(sortedToken0.toBase58()) : 'UNKN'
  const name1 = sortedToken1 ? getShortTokenName(sortedToken1.toBase58()) : 'UNKN'
  const displayName = getPoolDisplayName(sortedToken0?.toBase58(), sortedToken1?.toBase58())

  const getIconLabel = (symbol: string) => symbol.slice(0, 2).toUpperCase()
  const color0 = getTokenColor(name0)
  const color1 = getTokenColor(name1)

  const [pairHash] = useState<string | null>(null)
  
  // Use batched vault balance data
  const vault0 = vaultBalances?.vault0Balance ?? pool.vault0Balance
  const vault1 = vaultBalances?.vault1Balance ?? pool.vault1Balance
  const liquidityDisplay = (vault0 != null && vault1 != null)
    ? `${Number(vault0).toFixed(2)} ${name0} & ${Number(vault1).toFixed(2)} ${name1}`
    : '-'

  const getFeeTier = () => {
    if (!pool.ammConfig) return '-'
    const config = ammConfigs.find((c) => {
      const cPub = c.publicKey?.toBase58 ? c.publicKey.toBase58() : String(c.publicKey)
      const pConfig = pool.ammConfig?.toBase58 ? pool.ammConfig.toBase58() : String(pool.ammConfig)
      return cPub.toLowerCase() === pConfig.toLowerCase()
    })
    if (!config) {
      return pool.fee ? (String(pool.fee).includes('%') ? pool.fee : `${pool.fee}%`) : '-'
    }
    const feeRate = config.tradeFeeRate ?? config.trade_fee_rate
    const feeRateNum = toFiniteNumber(feeRate)
    return feeRateNum == null ? '-' : `${(feeRateNum / 10000).toFixed(2)}%`
  }
  const feeDisplay = getFeeTier()

  const [hoverInfo, setHoverInfo] = useState<{ poolId?: string | null; token0?: string | null; token1?: string | null } | null>(null)
  const hoverTimeout = useRef<number | null>(null)
  const clearHoverTimeout = () => {
    if (hoverTimeout.current != null) {
      clearTimeout(hoverTimeout.current)
      hoverTimeout.current = null
    }
  }
  const handleIconHover = async () => {
    clearHoverTimeout()
    try {
      let poolId: string | null = pool.poolPda ?? null
      if (!poolId && ammConfig && sortedToken0 && sortedToken1) {
        try {
          const [pda] = await getPoolAddress(ammConfig, sortedToken0, sortedToken1, PROGRAM_ID)
          poolId = pda.toBase58()
        } catch (e) {
          poolId = null
        }
      }
      const t0 = sortedToken0 ? sortedToken0.toBase58() : null
      const t1 = sortedToken1 ? sortedToken1.toBase58() : null
      setHoverInfo({ poolId, token0: t0, token1: t1 })
    } catch (e) {
      setHoverInfo({ poolId: null, token0: null, token1: null })
    }
  }
  const handleIconLeave = () => {
    clearHoverTimeout()
    hoverTimeout.current = window.setTimeout(() => setHoverInfo(null), 150)
  }

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyText = async (value?: string | null, key = value ?? '') => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    } catch (e) { }
  }

  const onDeposit = () => {
    const state = {
      name: pool.name,
      fee: pool.fee,
      token0: pool.token0,
      token1: pool.token1,
      ammConfig: pool.ammConfig,
      poolPda: pool.poolPda,
      lpSupply: pool.lpSupply,
      decimals0: pool.raw?.mint_0_decimals ?? pool.raw?.mint0Decimals ?? pool.decimals0,
      decimals1: pool.raw?.mint_1_decimals ?? pool.raw?.mint1Decimals ?? pool.decimals1,
      vault0Amount: (pool.vault0Balance ?? pool.vault0Balance === 0) ? pool.vault0Balance : undefined,
      vault1Amount: (pool.vault1Balance ?? pool.vault1Balance === 0) ? pool.vault1Balance : undefined,
    }
    try { navigate('/liquidity/deposit', { state }) } catch (e) { navigate('/liquidity/deposit') }
  }

  const onSwap = () => navigate('/swap', { state: pool })

  return (
    <tr key={displayName} className="lp-row">
      <td className="lp-td lp-td-pool lp-col-pool">
        <div className="lp-td-pool-inner">
          <div className="lp-hover-wrapper" onMouseEnter={() => { void handleIconHover() }} onMouseLeave={handleIconLeave} style={{ display: 'inline-block' }}>
            <div className="lp-pool-badges" style={{ cursor: 'pointer' }} title="Hover to view pool info">
              <div className="lp-pool-badge lp-pool-badge-a" style={{ backgroundColor: color0 }}>
                {getIconLabel(name0)}
              </div>
              <div className="lp-pool-badge lp-pool-badge-b" style={{ backgroundColor: color1 }}>
                {getIconLabel(name1)}
              </div>
            </div>
            {hoverInfo && (
              <div className="lp-hover-card">
                <div className="lp-hover-row">
                  <span><strong>Pool id:</strong> {hoverInfo.poolId ?? 'unknown'}</span>
                  <button className="lp-copy-btn" onClick={() => copyText(hoverInfo.poolId, 'pool')} title="Copy pool id" aria-label="Copy pool id">
                    {copiedKey === 'pool' ? <span className="copy-status-inline">Copied!</span> : <img src={copyIcon} alt="Copy" />}
                  </button>
                </div>
                <div className="lp-hover-row">
                  <span><strong>token0:</strong> {hoverInfo.token0 ?? '-'}</span>
                  <button className="lp-copy-btn" onClick={() => copyText(hoverInfo.token0, 'token0')} title="Copy token0" aria-label="Copy token0">
                    {copiedKey === 'token0' ? <span className="copy-status-inline">Copied!</span> : <img src={copyIcon} alt="Copy" />}
                  </button>
                </div>
                <div className="lp-hover-row">
                  <span><strong>token1:</strong> {hoverInfo.token1 ?? '-'}</span>
                  <button className="lp-copy-btn" onClick={() => copyText(hoverInfo.token1, 'token1')} title="Copy token1" aria-label="Copy token1">
                    {copiedKey === 'token1' ? <span className="copy-status-inline">Copied!</span> : <img src={copyIcon} alt="Copy" />}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="lp-pool-info">
            <span className="lp-pool-name">{displayName}</span>
            {pairHash && <div className="lp-pair-hash">Pair: {pairHash}</div>}
          </div>
        </div>
      </td>
      <td className="lp-td lp-col-liquidity">{liquidityDisplay}</td>
      <td className="lp-td lp-col-fee-tier">{feeDisplay}</td>
      <td className="lp-td lp-td-actions lp-col-actions">
        <div className="lp-actions-cell">
          <div className="lp-swap-tooltip-wrapper">
            <button className="lp-action-swap-btn" onClick={onSwap} aria-label={`Swap ${displayName}`}>
              <img src={swapIcon} alt="Swap" />
            </button>
            <span className="lp-swap-tooltip-text">Swap</span>
          </div>
          <button className="lp-deposit-btn" onClick={onDeposit}>Deposit</button>
        </div>
      </td>
    </tr>
  )
}

const MemoPoolRow = memo(PoolRow)

const Liquidity = () => {
  const navigate = useNavigate()
  const { data, isLoading: loadingPools, error } = useGetPoolsQuery()
  const [searchQuery, setSearchQuery] = useState('')
  const pools = useMemo(() => data?.pools ?? [], [data])
  const ammConfigs = useMemo(() => data?.ammConfigs ?? [], [data])
  const poolsError = useMemo(() => {
    if (!error) return null
    const raw = (error as any).error ?? (error as any).data ?? error
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  }, [error])

  // --- Sequential batch loading: Only show pools that have complete data ---
  const [vaultBalancesMap, setVaultBalancesMap] = useState<Record<string, { vault0Balance: number | null; vault1Balance: number | null }>>({})
  const [currentBatchIndex, setCurrentBatchIndex] = useState(0)
  const [isLoadingBatch, setIsLoadingBatch] = useState(false)
  const [allLoaded, setAllLoaded] = useState(false)
  const loadingRef = useRef(false)

  // Reset when pools change
  useEffect(() => {
    setVaultBalancesMap({})
    setCurrentBatchIndex(0)
    setAllLoaded(false)
    loadingRef.current = false
  }, [pools])

  // Calculate total batches needed
  const totalBatches = Math.ceil(pools.length / BATCH_SIZE)

  // Fetch a single batch
  useEffect(() => {
    if (loadingPools) return
    if (pools.length === 0) return
    if (allLoaded) return
    if (isLoadingBatch) return
    if (loadingRef.current) return
    if (currentBatchIndex >= totalBatches) {
      setAllLoaded(true)
      return
    }

    const fetchBatch = async () => {
      loadingRef.current = true
      setIsLoadingBatch(true)

      const start = currentBatchIndex * BATCH_SIZE
      const end = Math.min(start + BATCH_SIZE, pools.length)
      const batch = pools.slice(start, end)

      const batchItems = batch
        .filter(p => p.poolPda)
        .map(p => ({
          poolPda: p.poolPda!,
          token0Vault: p.token0Vault,
          token1Vault: p.token1Vault,
        }))

      if (batchItems.length > 0) {
        try {
          const results = await fetchVaultBalancesBatch(batchItems)
          setVaultBalancesMap(prev => ({ ...prev, ...results }))
        } catch (err) {
          console.warn('[Liquidity] batch fetch error:', err)
        }
      }

      const nextBatchIndex = currentBatchIndex + 1
      setCurrentBatchIndex(nextBatchIndex)
      setIsLoadingBatch(false)
      loadingRef.current = false

      if (nextBatchIndex >= totalBatches) {
        setAllLoaded(true)
      }
    }

    fetchBatch()
  }, [pools, loadingPools, currentBatchIndex, totalBatches, allLoaded, isLoadingBatch])

  // Only show pools that have vault balance data (complete pool rows)
  const visiblePools = useMemo(() => {
    return pools.filter(p => {
      if (!p.poolPda) return false
      const vaultData = vaultBalancesMap[p.poolPda]
      return vaultData && vaultData.vault0Balance !== null && vaultData.vault1Balance !== null && Number(p.lpSupply) > 100
    })
  }, [pools, vaultBalancesMap])

  // Filtering (apply to visible pools only)
  const filteredPools = visiblePools.filter((p) => {
    if (!searchQuery) return true
    const q = searchQuery.trim().toLowerCase()
    const pda = p.poolPda ? String(p.poolPda).toLowerCase() : ''
    
    // Check if it's a valid address search
    const isValidAddress = q.length >= 32 && q.length <= 44;
    
    if (isValidAddress) {
      return pda === q;
    }
    
    // Otherwise it's a token search - show if either token starts with the string
    const displayName = getPoolDisplayName(p.token0, p.token1).toLowerCase()
    const parts = displayName.split('-')
    const token0Match = parts[0] && parts[0].startsWith(q)
    const token1Match = parts[1] && parts[1].startsWith(q)
    
    return displayName.startsWith(q) || token0Match || token1Match
  })

  return (
    <div className="lp-page">
      <div className="lp-top">
        <div className="lp-top-left">
          <h1 className="lp-title">Liquidity Pools</h1>
          <p className="lp-subtitle">Provide liquidity, earn yield.</p>
        </div>

        <div className="lp-stats">
          <div className="lp-stat-card">
            <span className="lp-stat-label">Total Number of Pools</span>
            <span className="lp-stat-value">
              {loadingPools || !allLoaded ? 'Loading...' : `${filteredPools.length} Pools`}
            </span>
          </div>
        </div>
      </div>

      <div className="lp-filter-bar">
        <div className="lp-filter-left">
          <input
            className="lp-search"
            placeholder="Search pool name or id..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="lp-filter-right">
          <button className="lp-create-btn" onClick={() => navigate('/liquidity/create')}>
            + Create
          </button>
          <button className="lp-create-btn lp-create-fees-btn" onClick={() => navigate('/liquidity/create', { state: { mode: 'permissioned' } })}>
            + Create (with creator fees)
          </button>
        </div>
      </div>

      <div className="lp-table-wrap">
        <table className="lp-table">
          <thead>
            <tr>
              <th className="lp-th lp-th-pool lp-col-pool">Pool</th>
              <th className="lp-th lp-col-liquidity">Liquidity</th>
              <th className="lp-th lp-col-fee-tier">Fee Tier</th>
              <th className="lp-th lp-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loadingPools || (!allLoaded && filteredPools.length === 0 ) ? (
              <tr>
                <td colSpan={4}>
                  <div className="portfolio-container-loading">
                    <div className="loading-spinner"></div>
                    <p>Loading pools...</p>
                  </div>
                </td>
              </tr>

            ) : poolsError ? (
              <tr><td colSpan={4}>Error: {poolsError}</td></tr>
            ) : allLoaded && filteredPools.length === 0 ? (
              <tr><td colSpan={4}>No pools found matching search filter.</td></tr>
            ) : (
              <>
                {filteredPools.map((p, idx) => (
                  <MemoPoolRow
                    key={p.poolPda ?? p.token0 ?? idx}
                    pool={p}
                    navigate={navigate}
                    ammConfigs={ammConfigs}
                    vaultBalances={p.poolPda ? vaultBalancesMap[p.poolPda] : undefined}
                  />
                ))}
                {/* Show loading more until all batches are complete */}
                {!allLoaded && (
                  <tr className="lp-row lp-loading-more-row">
                    <td colSpan={4}>
                      <div className="lp-loading-more lp-loading-more-centered">
                        <span className="lp-loading-more-text">Loading more</span>
                        <InlineLoader />
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
      <p className="lp-note">Provide liquidity to any pool to earn swap fee rewards.</p>
    </div>
  )
}

export default Liquidity