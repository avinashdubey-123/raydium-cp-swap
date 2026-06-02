import { useNavigate } from 'react-router-dom'
import './Liquidity.css'
import usePool from '../../hooks/usePool'
import { PublicKey } from '@solana/web3.js'
import { useConnection } from '@solana/wallet-adapter-react'
import { getPoolAddress, getPoolVaultAddress } from '../../utils/pda'
import { useEffect, useMemo, useState, useRef, memo } from 'react'
import copyIcon from '../../assets/copy.svg'
import swapIcon from '../../assets/swap.svg'
import { getShortTokenName, getPoolDisplayName } from '../../utils/token'
import { useGetPoolsQuery } from '../../store/solanaApi'

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')

// Deterministic pleasing HSL color generation based on token symbol
function getTokenColor(symbol: string): string {
  let hash = 0
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  // Saturation: 65% for vibrancy, Lightness: 40% for beautiful colors on dark backgrounds
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

function PoolRow({ pool, navigate, ammConfigs }: { pool: any; navigate: any; ammConfigs: any[] }) {
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
  const poolPda = pool.poolPda ? new PublicKey(pool.poolPda) : undefined

  const { vault0Amount: hookVault0, vault1Amount: hookVault1 } = usePool({ poolPda, ammConfig, token0Mint: sortedToken0, token1Mint: sortedToken1, fetchOnMount: false })
  const { connection } = useConnection()
  const [rpcVault0, setRpcVault0] = useState<number | null>(null)
  const [rpcVault1, setRpcVault1] = useState<number | null>(null)

  useEffect(() => {
    let mounted = true
    async function fetchVaults() {
      if (pool.vault0Balance != null || pool.vault1Balance != null) {
        if (mounted) {
          setRpcVault0(pool.vault0Balance ?? null)
          setRpcVault1(pool.vault1Balance ?? null)
        }
        return
      }
      if (!token0 || !token1 || !ammConfig) return
      try {
        const [pda] = await getPoolAddress(ammConfig, sortedToken0!, sortedToken1!, PROGRAM_ID)
        const [v0] = await getPoolVaultAddress(pda, sortedToken0!, PROGRAM_ID)
        const [v1] = await getPoolVaultAddress(pda, sortedToken1!, PROGRAM_ID)
        const b0 = await connection.getTokenAccountBalance(v0).catch(() => null)
        const b1 = await connection.getTokenAccountBalance(v1).catch(() => null)
        if (!mounted) return
        setRpcVault0(b0?.value?.uiAmount ?? null)
        setRpcVault1(b1?.value?.uiAmount ?? null)
      } catch (err: any) {
        const msg = (err?.message || String(err) || '').toLowerCase()
        if (!msg.includes('429') && !msg.includes('too many requests')) {
          console.warn('Error fetching vaults:', err?.message || err)
        }
      }
    }
    fetchVaults()
    return () => { mounted = false }
  }, [token0, token1, ammConfig, connection, pool.vault0Balance, pool.vault1Balance])

  const name0 = sortedToken0 ? getShortTokenName(sortedToken0.toBase58()) : 'UNKN'
  const name1 = sortedToken1 ? getShortTokenName(sortedToken1.toBase58()) : 'UNKN'
  const displayName = getPoolDisplayName(sortedToken0?.toBase58(), sortedToken1?.toBase58())

  const getIconLabel = (symbol: string) => {
    return symbol.slice(0, 2).toUpperCase()
  }

  const color0 = getTokenColor(name0)
  const color1 = getTokenColor(name1)

  const [pairHash] = useState<string | null>(null)
  const vault0 = hookVault0 ?? rpcVault0 ?? pool.vault0Balance
  const vault1 = hookVault1 ?? rpcVault1 ?? pool.vault1Balance
  // Liquidity Display with exactly two decimals and explicit token symbols (e.g. 1023.22 SOL & 1033.64 USDC)
  const liquidityDisplay = (vault0 != null && vault1 != null)
    ? `${Number(vault0).toFixed(2)} ${name0} & ${Number(vault1).toFixed(2)} ${name1}`
    : '-'

  // Fetch Fee Tier properly from dynamic on-chain ammConfigs matching
  const getFeeTier = () => {
    if (!pool.ammConfig) return '-'
    const config = ammConfigs.find(
      (c) => {
        const cPub = c.publicKey?.toBase58 ? c.publicKey.toBase58() : String(c.publicKey)
        const pConfig = pool.ammConfig?.toBase58 ? pool.ammConfig.toBase58() : String(pool.ammConfig)
        return cPub.toLowerCase() === pConfig.toLowerCase()
      }
    )
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

  const onSwap = () => {
    navigate('/swap', { state: pool })
  }

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

  // Improved case-insensitive, partial match filtering for pool name (display symbol pair) and pool id PDA
  const filteredPools = pools.filter((p) => {
    if (!searchQuery) return true
    const q = searchQuery.trim().toLowerCase()
    const displayName = getPoolDisplayName(p.token0, p.token1).toLowerCase()
    const pda = p.poolPda ? String(p.poolPda).toLowerCase() : ''
    return displayName.includes(q) || pda.includes(q)
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
              {loadingPools ? 'Loading...' : `${pools.length} Pools`}
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

        {/* Filter pills removed per instruction */}

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
            {loadingPools ? (
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
            ) : filteredPools.length === 0 ? (
              <tr><td colSpan={4}>No pools found matching search filter.</td></tr>
            ) : (
              filteredPools.map((p, idx) => (
                <MemoPoolRow key={p.poolPda ?? p.token0 ?? idx} pool={p} navigate={navigate} ammConfigs={ammConfigs} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="lp-note">Provide liquidity to any pool to earn swap fee rewards.</p>
    </div>
  )
}

export default Liquidity;
