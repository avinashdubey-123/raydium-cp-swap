import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import useProgram from '../../utils/useProgram'
import { getPoolVaultAddress } from '../../utils/pda'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import { RoundDirection } from '../../utils/curve/calculator'
import copyIcon from '../../assets/copy.svg'
import viewIcon from '../../assets/view.svg'
import { getActivities, ActivityItem } from '../../utils/activity'
import './Portfolio.css'

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')

interface LPPosition {
  poolPda: PublicKey
  token0Mint: PublicKey
  token1Mint: PublicKey
  lpMint: PublicKey
  lpTokenAccount: PublicKey
  lpTokenAmount: number
  lpTokenDecimals: number
  token0Symbol?: string
  token1Symbol?: string
  ammConfig?: PublicKey
  lpSupplyRaw?: string
  decimals0?: number
  decimals1?: number
}

interface ComputedPosition extends LPPosition {
  token0Amount: number
  token1Amount: number
  token0Value: number | null
  token1Value: number | null
  totalValue: number | null
}

function toPublicKey(value: unknown): PublicKey | null {
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

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) return 'Just now'
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
}

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

// ── Persistent portfolio cache (module-level, survives component unmount) ──
type PortfolioCacheEntry = {
  ts: number
  positions: ComputedPosition[]
}
const PORTFOLIO_CACHE_TTL = 300_000 // 5 minutes
const __portfolioCache: Map<string, PortfolioCacheEntry> =
  (globalThis as any).__portfolioCache ||
  ((globalThis as any).__portfolioCache = new Map<string, PortfolioCacheEntry>())

/**
 * Invalidate the portfolio cache for a specific wallet (or all wallets).
 * Call this after any state-changing transaction (deposit, withdraw, fee collect).
 */
export function invalidatePortfolioCache(walletAddress?: string) {
  if (walletAddress) {
    __portfolioCache.delete(walletAddress)
  } else {
    __portfolioCache.clear()
  }
}

const Portfolio = () => {
  const program = useProgram()
  const navigate = useNavigate()
  const { connection } = useConnection()
  const wallet = useWallet()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [positions, setPositions] = useState<ComputedPosition[]>(() => {
    // Initialise from cache so the UI renders instantly
    if (wallet.publicKey) {
      const key = wallet.publicKey.toBase58()
      const cached = __portfolioCache.get(key)
      if (cached && Date.now() - cached.ts < PORTFOLIO_CACHE_TTL) {
        return cached.positions
      }
    }
    return []
  })
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  
  const [activeTab, setActiveTab] = useState<'assets' | 'liquidity' | 'activity'>(() => {
    // Restore from sessionStorage so the tab persists across SPA navigation
    try {
      const saved = sessionStorage.getItem('portfolio_activeTab')
      if (saved === 'assets' || saved === 'liquidity' || saved === 'activity') return saved
    } catch {}
    return 'assets'
  })
  const [searchQuery, setSearchQuery] = useState(() => {
    try { return sessionStorage.getItem('portfolio_searchQuery') || '' } catch { return '' }
  })
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [copiedPoolPda, setCopiedPoolPda] = useState<string | null>(null)

  const searchInputRef = useRef<HTMLInputElement>(null)
  // Track the wallet address we last loaded for so we don't re-fetch on
  // dependency changes that don't actually change the wallet.
  const lastLoadedWalletRef = useRef<string | null>(null)

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedPoolPda(text)
      setTimeout(() => setCopiedPoolPda(null), 1500)
    } catch (err) {
      console.error('Failed to copy pool address:', err)
    }
  }

  const handlePoolCountClick = (tokenSymbol: string) => {
    setActiveTab('liquidity')
    setSearchQuery(tokenSymbol)
    setTimeout(() => {
      searchInputRef.current?.focus()
    }, 100)
  }

  const getPools = async (): Promise<Map<string, any>> => {
    try {
      if (!program) throw new Error('Program not ready')

      const poolAccountNamespace = (program.account as any).poolState
      if (!poolAccountNamespace?.all) return new Map()
      const poolAccounts = await poolAccountNamespace.all()
      const poolsMap = new Map<string, any>()

      for (const { publicKey, account } of poolAccounts) {
        poolsMap.set(publicKey.toBase58(), {
          ...account,
          poolKey: publicKey,
        })
      }
      return poolsMap
    } catch (err) {
      return new Map()
    }
  }

  const getUserTokenAccounts = async (): Promise<any[]> => {
    try {
      if (!wallet.publicKey) throw new Error('Wallet not connected')

      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      )

      return tokenAccounts.value
    } catch (err) {
      console.error('Failed to fetch user tokens:', err)
      return []
    }
  }

  const filterLPs = (tokenAccounts: any[], poolsData: Map<string, any>): LPPosition[] => {
    const lpMints = new Set<string>()

    for (const poolState of poolsData.values()) {
      const lpMintPk = toPublicKey(poolState.lpMint)
      if (lpMintPk) lpMints.add(lpMintPk.toBase58())
    }

    const lpPositions: LPPosition[] = []

    for (const tokenAccount of tokenAccounts) {
      const info = tokenAccount?.account?.data?.parsed?.info
      const mint = info?.mint as string | undefined
      const tokenAmount = info?.tokenAmount
      if (!mint || !tokenAmount) continue

      if (lpMints.has(mint) && Number(tokenAmount.uiAmount || 0) > 0) {
        let correspondingPool = null
        for (const [, poolState] of poolsData.entries()) {
          const poolLpMint = toPublicKey(poolState.lpMint)
          if (poolLpMint && poolLpMint.toBase58() === mint) {
            correspondingPool = poolState
            break
          }
        }

        if (correspondingPool) {
          const token0Mint = toPublicKey(correspondingPool.token0Mint)
          const token1Mint = toPublicKey(correspondingPool.token1Mint)
          const poolPda = toPublicKey(correspondingPool.poolKey)
          if (!token0Mint || !token1Mint || !poolPda) continue

          const lpMint = toPublicKey(mint)
          if (!lpMint) continue

          const lpTokenAccount = toPublicKey(tokenAccount.pubkey)
          if (!lpTokenAccount) continue

          const ammConfig = toPublicKey(correspondingPool.ammConfig)
          const lpSupplyRaw = String(correspondingPool.lpSupply ?? correspondingPool.lp_supply ?? '0')
          const decimals0 = Number(correspondingPool.mint0Decimals ?? correspondingPool.mint_0_decimals ?? correspondingPool.mintDecimals0 ?? 6)
          const decimals1 = Number(correspondingPool.mint1Decimals ?? correspondingPool.mint_1_decimals ?? correspondingPool.mintDecimals1 ?? 6)

          lpPositions.push({
            poolPda,
            token0Mint,
            token1Mint,
            lpMint,
            lpTokenAccount,
            lpTokenAmount: Number(tokenAmount.uiAmount || 0),
            lpTokenDecimals: Number(tokenAmount.decimals || 0),
            token0Symbol: correspondingPool.token0Symbol || token0Mint.toBase58().slice(0, 4),
            token1Symbol: correspondingPool.token1Symbol || token1Mint.toBase58().slice(0, 4),
            ammConfig: ammConfig ?? undefined,
            lpSupplyRaw,
            decimals0,
            decimals1,
          })
        }
      }
    }

    return lpPositions
  }

  const computePositions = async (lpPositions: LPPosition[], poolsData: Map<string, any>): Promise<ComputedPosition[]> => {
    const computed: ComputedPosition[] = []

    for (const lpPos of lpPositions) {
      try {
        let poolState = null
        for (const [, ps] of poolsData.entries()) {
          const psLpMintStr = typeof ps.lpMint === 'string' ? ps.lpMint : ps.lpMint.toBase58()
          if (psLpMintStr === lpPos.lpMint.toBase58()) {
            poolState = ps
            break
          }
        }

        if (!poolState) continue

        const [vault0PDA] = await getPoolVaultAddress(lpPos.poolPda, lpPos.token0Mint, PROGRAM_ID)
        const [vault1PDA] = await getPoolVaultAddress(lpPos.poolPda, lpPos.token1Mint, PROGRAM_ID)

        const vault0Account = await connection.getTokenAccountBalance(vault0PDA)
        const vault1Account = await connection.getTokenAccountBalance(vault1PDA)

        const vault0Balance = new anchor.BN(vault0Account.value.amount || '0')
        const vault1Balance = new anchor.BN(vault1Account.value.amount || '0')

        const rawLpSupply = poolState.lpSupply ?? poolState.lp_supply ?? 0
        const lpTokenSupply = new anchor.BN(rawLpSupply)
        if (lpTokenSupply.lte(new anchor.BN(0))) continue

        const lpAmountBN = new anchor.BN(lpPos.lpTokenAmount * Math.pow(10, lpPos.lpTokenDecimals))

        const { tokenAmount0, tokenAmount1 } = ConstantProductCurve.lpTokensToTradingTokens(
          lpAmountBN,
          lpTokenSupply,
          vault0Balance,
          vault1Balance,
          RoundDirection.Floor
        )

        const token0Decimals = poolState.mint0Decimals ?? poolState.mint_0_decimals ?? poolState.mintDecimals0 ?? 6
        const token1Decimals = poolState.mint1Decimals ?? poolState.mint_1_decimals ?? poolState.mintDecimals1 ?? 6

        const token0Amount = tokenAmount0.toNumber() / Math.pow(10, token0Decimals)
        const token1Amount = tokenAmount1.toNumber() / Math.pow(10, token1Decimals)

        const token0Value = 0
        const token1Value = 0
        const totalValue = 0

        computed.push({
          ...lpPos,
          token0Amount,
          token1Amount,
          token0Value,
          token1Value,
          totalValue,
        })
      } catch (err) {
        console.error('Failed to compute position:', err)
        computed.push({
          ...lpPos,
          token0Amount: 0,
          token1Amount: 0,
          token0Value: 0,
          token1Value: 0,
          totalValue: 0,
        })
      }
    }

    return computed
  }

  useEffect(() => {
    if (!program || !wallet.publicKey || !connection) return

    const walletKey = wallet.publicKey.toBase58()

    // ── Check persistent cache first ──
    const cached = __portfolioCache.get(walletKey)
    if (cached && Date.now() - cached.ts < PORTFOLIO_CACHE_TTL) {
      // Data is still fresh – render immediately, skip network calls
      setPositions(cached.positions)
      lastLoadedWalletRef.current = walletKey
      return // do NOT enter loading state
    }

    // ── Avoid redundant fetches if we already loaded for this wallet ──
    // (e.g. program reference changed but wallet didn't)
    if (lastLoadedWalletRef.current === walletKey && positions.length > 0) {
      return
    }

    const loadPortfolio = async () => {
      try {
        setLoading(true)
        setError(null)

        const loadedPools = await getPools()
        const tokenAccounts = await getUserTokenAccounts()
        const lpPositions = filterLPs(tokenAccounts, loadedPools)
        const computedPositions = await computePositions(lpPositions, loadedPools)

        // Store in persistent cache
        __portfolioCache.set(walletKey, { ts: Date.now(), positions: computedPositions })
        lastLoadedWalletRef.current = walletKey
        setPositions(computedPositions)
      } catch (err: any) {
        console.error('Portfolio load error:', err)
        setError('Failed to load portfolio data')
        // Don't clear positions if we had cached data – keep showing stale data
        // rather than flashing an empty state
      } finally {
        setLoading(false)
      }
    }

    loadPortfolio()
  }, [program, wallet.publicKey, connection])

  useEffect(() => {
    // Persist the active tab to sessionStorage
    try { sessionStorage.setItem('portfolio_activeTab', activeTab) } catch {}
    // Persist search query for liquidity tab
    try { sessionStorage.setItem('portfolio_searchQuery', searchQuery) } catch {}
    if (activeTab === 'activity') {
      setActivities(getActivities())
    }
  }, [activeTab])

  if (!wallet.connected) {
    return <div className="portfolio-container-empty">Please connect your wallet</div>
  }

  if (loading) {
    return (
      <div className="portfolio-container-loading">
        <div className="loading-spinner"></div>
        <p>Loading portfolio...</p>
      </div>
    )
  }

  if (error) {
    return <div className="portfolio-container error-state">Error: {error}</div>
  }

  const tokenSummary = (() => {
    const map = new Map<string, { symbol: string; amount: number; pools: Set<string> }>()
    for (const pos of positions) {
      const poolKey = pos.poolPda.toBase58()
      const t0 = pos.token0Symbol || 'TOKEN0'
      const t1 = pos.token1Symbol || 'TOKEN1'
      const t0Entry = map.get(t0) || { symbol: t0, amount: 0, pools: new Set<string>() }
      t0Entry.amount += pos.token0Amount
      t0Entry.pools.add(poolKey)
      map.set(t0, t0Entry)
      const t1Entry = map.get(t1) || { symbol: t1, amount: 0, pools: new Set<string>() }
      t1Entry.amount += pos.token1Amount
      t1Entry.pools.add(poolKey)
      map.set(t1, t1Entry)
    }
    return Array.from(map.values())
      .map((entry) => ({
        symbol: entry.symbol,
        amount: entry.amount,
        poolCount: entry.pools.size,
      }))
      .sort((a, b) => b.amount - a.amount)
  })()

  const toggleRow = (rowKey: string) => {
    setExpandedRows((current) => ({
      ...current,
      [rowKey]: !current[rowKey],
    }))
  }

  const openDeposit = (pos: ComputedPosition) => {
    navigate('/liquidity/deposit', {
      state: {
        name: `${pos.token0Symbol || 'TOKEN0'}/${pos.token1Symbol || 'TOKEN1'}`,
        poolPda: pos.poolPda.toBase58(),
        ammConfig: pos.ammConfig?.toBase58(),
        token0: pos.token0Mint.toBase58(),
        token1: pos.token1Mint.toBase58(),
        token0Mint: pos.token0Mint.toBase58(),
        token1Mint: pos.token1Mint.toBase58(),
        lpSupply: pos.lpSupplyRaw,
        decimals0: pos.decimals0,
        decimals1: pos.decimals1,
        from: '/portfolio', // Pass back-navigation context
      },
    })
  }

  const openWithdraw = (pos: ComputedPosition) => {
    navigate('/liquidity/withdraw', {
      state: {
        poolPda: pos.poolPda.toBase58(),
        token0: pos.token0Mint.toBase58(),
        token1: pos.token1Mint.toBase58(),
        token0Symbol: pos.token0Symbol,
        token1Symbol: pos.token1Symbol,
        lpAmount: pos.lpTokenAmount,
        token0Amount: pos.token0Amount,
        token1Amount: pos.token1Amount,
        token0Value: pos.token0Value,
        token1Value: pos.token1Value,
        totalValue: pos.totalValue,
      }
    })
  }

  const filteredPositions = positions.filter((pos) => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase().trim()
    const pair = `${pos.token0Symbol}/${pos.token1Symbol}`.toLowerCase()
    const poolAddr = pos.poolPda.toBase58().toLowerCase()
    const sym0 = (pos.token0Symbol || '').toLowerCase()
    const sym1 = (pos.token1Symbol || '').toLowerCase()
    return (
      pair.includes(query) ||
      poolAddr.includes(query) ||
      sym0.includes(query) ||
      sym1.includes(query)
    )
  })

  return (
    <div className="portfolio-wrapper">
      <div className="portfolio-header-section">
        <h1 className="portfolio-title-new">Portfolio</h1>
        <p className="portfolio-subtitle">Manage and track your liquidity pools, tokens, and recent activities.</p>
      </div>

      {/* Navigation Tabs */}
      <div className="portfolio-navigation-panel">
        <div className="portfolio-tab-buttons">
          <button
            className={`portfolio-tab-btn ${activeTab === 'assets' ? 'active' : ''}`}
            onClick={() => setActiveTab('assets')}
          >
            Invested Assets
          </button>
          <button
            className={`portfolio-tab-btn ${activeTab === 'liquidity' ? 'active' : ''}`}
            onClick={() => setActiveTab('liquidity')}
          >
            My Liquidity
          </button>
          <button
            className={`portfolio-tab-btn ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >
            Activity
          </button>
        </div>

        {activeTab === 'liquidity' && (
          <button
            className="collect-fees-btn"
            type="button"
            onClick={() => navigate('/portfolio/creator-fees')}
          >
            Collect creator fees
          </button>
        )}
      </div>

      {/* Invested Assets Tab */}
      {activeTab === 'assets' && (
        <div className="invested-assets-tab-content">
          {tokenSummary.length === 0 ? (
            <div className="invested-assets-empty-new">No active investments found.</div>
          ) : (
            <div className="assets-horizontal-rows">
              {tokenSummary.map((token) => {
                const avatar = token.symbol.slice(0, 2).toUpperCase()
                return (
                  <div className="asset-row-card" key={token.symbol}>
                    <div className="asset-row-left-details">
                      <div className="asset-row-avatar-badge" style={{ backgroundColor: getTokenColor(token.symbol), color: '#ffffff', borderColor: 'transparent' }}>{avatar}</div>
                      <div className="asset-row-token-meta">
                        <span className="asset-row-token-symbol">{token.symbol}</span>
                        <span className="asset-row-token-amount">{token.amount.toFixed(4)} tokens</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="asset-row-pool-count-btn"
                      onClick={() => handlePoolCountClick(token.symbol)}
                      title={`Filter positions by ${token.symbol}`}
                    >
                      {token.poolCount} pool{token.poolCount > 1 ? 's' : ''} <span className="arrow-indicator-inline">→</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* My Liquidity Tab */}
      {activeTab === 'liquidity' && (
        <div className="liquidity-tab-content">
          <div className="liquidity-search-wrapper">
            <input
              ref={searchInputRef}
              type="text"
              className="liquidity-search-input"
              placeholder="Search by token symbol, pair name, or pool address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setSearchQuery('')}
              >
                ×
              </button>
            )}
          </div>

          <div className="positions-list-container">
            {filteredPositions.length === 0 ? (
              <div className="positions-empty-card">
                {searchQuery ? 'No liquidity positions matched your search.' : 'You do not have any active liquidity positions yet.'}
              </div>
            ) : (
              <div className="positions-cards-list">
                {filteredPositions.map((pos, idx) => {
                  const poolAddrStr = pos.poolPda.toBase58()
                  const shortAddr = `${poolAddrStr.slice(0, 6)}...${poolAddrStr.slice(-6)}`
                  const isExpanded = !!expandedRows[`${pos.lpMint.toBase58()}-${idx}`]
                  const avatar0 = pos.token0Symbol ? pos.token0Symbol.slice(0, 2).toUpperCase() : 'T0'
                  const avatar1 = pos.token1Symbol ? pos.token1Symbol.slice(0, 2).toUpperCase() : 'T1'

                  return (
                    <div
                      key={`${pos.lpMint.toBase58()}-${idx}`}
                      className={`liquidity-card-v2 ${isExpanded ? 'expanded' : ''}`}
                    >
                      <div className="liquidity-card-header-v2">
                        <div className="liquidity-card-pair-row">
                          <div className="avatar-badges-group">
                            <span className="token-avatar-badge badge-0" style={{ backgroundColor: getTokenColor(pos.token0Symbol || 'T0'), color: '#ffffff', borderColor: 'transparent' }}>{avatar0}</span>
                            <span className="token-avatar-badge badge-1" style={{ backgroundColor: getTokenColor(pos.token1Symbol || 'T1'), color: '#ffffff', borderColor: 'transparent' }}>{avatar1}</span>
                          </div>
                          <span className="pair-title-v2">
                            {pos.token0Symbol} / {pos.token1Symbol || 'Unknown'}
                          </span>
                        </div>

                        <div className="liquidity-card-composition">
                          <div className="composition-item-v2">
                            <span className="comp-amount">{pos.token0Amount.toFixed(4)}</span>
                            <span className="comp-symbol">{pos.token0Symbol}</span>
                          </div>
                          <div className="composition-item-v2">
                            <span className="comp-amount">{pos.token1Amount.toFixed(4)}</span>
                            <span className="comp-symbol">{pos.token1Symbol}</span>
                          </div>
                        </div>
                      </div>

                      <div className="liquidity-card-actions-v2">
                        <div className="card-buttons-left">
                          <button
                            className="liquidity-action-btn-v2 deposit-btn"
                            onClick={() => openDeposit(pos)}
                          >
                            Deposit
                          </button>
                          <button
                            className="liquidity-action-btn-v2 withdraw-btn"
                            onClick={() => openWithdraw(pos)}
                          >
                            Withdraw
                          </button>
                        </div>

                        <button
                          type="button"
                          className={`view-details-toggle-btn ${isExpanded ? 'active' : ''}`}
                          onClick={() => toggleRow(`${pos.lpMint.toBase58()}-${idx}`)}
                        >
                          {isExpanded ? 'Hide Details ▲' : 'View Details ▼'}
                        </button>
                      </div>

                      {/* Collapsible View Details Section */}
                      {isExpanded && (
                        <div className="liquidity-card-details-panel-v2">
                          <div className="details-section-grid-v2">
                            <div className="details-info-row-v2">
                              <span className="details-label">Pool Address</span>
                              <div className="details-value-with-actions">
                                <span className="details-val-mono" title={poolAddrStr}>{shortAddr}</span>
                                <button
                                  type="button"
                                  className="details-icon-btn copy-btn"
                                  onClick={() => void copyToClipboard(poolAddrStr)}
                                  title="Copy Pool Address"
                                >
                                  {copiedPoolPda === poolAddrStr ? (
                                    <span className="copy-status-inline">Copied!</span>
                                  ) : (
                                    <img src={copyIcon} alt="Copy" className="btn-icon-tiny" />
                                  )}
                                </button>
                                <a
                                  href={`https://explorer.solana.com/address/${poolAddrStr}?cluster=devnet`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="details-icon-btn explorer-btn"
                                  title="Open in Solana Explorer"
                                >
                                  <img src={viewIcon} alt="View" className="btn-icon-tiny" />
                                </a>
                              </div>
                            </div>

                            <div className="details-info-row-v2">
                              <span className="details-label">{pos.token0Symbol} Mint</span>
                              <div className="details-value-with-actions">
                                <span className="details-val-mono" title={pos.token0Mint.toBase58()}>
                                  {pos.token0Mint.toBase58().slice(0, 6)}...{pos.token0Mint.toBase58().slice(-6)}
                                </span>
                                <button
                                  type="button"
                                  className="details-icon-btn copy-btn"
                                  onClick={() => void copyToClipboard(pos.token0Mint.toBase58())}
                                  title={`Copy ${pos.token0Symbol} Mint`}
                                >
                                  {copiedPoolPda === pos.token0Mint.toBase58() ? (
                                    <span className="copy-status-inline">Copied!</span>
                                  ) : (
                                    <img src={copyIcon} alt="Copy" className="btn-icon-tiny" />
                                  )}
                                </button>
                              </div>
                            </div>

                            <div className="details-info-row-v2">
                              <span className="details-label">{pos.token1Symbol} Mint</span>
                              <div className="details-value-with-actions">
                                <span className="details-val-mono" title={pos.token1Mint.toBase58()}>
                                  {pos.token1Mint.toBase58().slice(0, 6)}...{pos.token1Mint.toBase58().slice(-6)}
                                </span>
                                <button
                                  type="button"
                                  className="details-icon-btn copy-btn"
                                  onClick={() => void copyToClipboard(pos.token1Mint.toBase58())}
                                  title={`Copy ${pos.token1Symbol} Mint`}
                                >
                                  {copiedPoolPda === pos.token1Mint.toBase58() ? (
                                    <span className="copy-status-inline">Copied!</span>
                                  ) : (
                                    <img src={copyIcon} alt="Copy" className="btn-icon-tiny" />
                                  )}
                                </button>
                              </div>
                            </div>

                            <div className="details-info-row-v2">
                              <span className="details-label">LP Token Account</span>
                              <span className="details-val-mono" title={pos.lpTokenAccount.toBase58()}>
                                {pos.lpTokenAccount.toBase58().slice(0, 6)}...{pos.lpTokenAccount.toBase58().slice(-6)}
                              </span>
                            </div>

                            <div className="details-info-row-v2">
                              <span className="details-label">LP Token Balance</span>
                              <span className="details-val-mono">{pos.lpTokenAmount.toFixed(6)}</span>
                            </div>

                            <div className="details-info-row-v2">
                              <span className="details-label">Exact {pos.token0Symbol} Balance</span>
                              <span className="details-val-mono">{pos.token0Amount.toFixed(6)}</span>
                            </div>

                            <div className="details-info-row-v2">
                              <span className="details-label">Exact {pos.token1Symbol} Balance</span>
                              <span className="details-val-mono">{pos.token1Amount.toFixed(6)}</span>
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
      )}

      {/* Activity Tab */}
      {activeTab === 'activity' && (
        <div className="activity-list-container">
          {activities.length === 0 ? (
            <div className="activity-empty-card">No session history tracked in this session yet.</div>
          ) : (
            <div className="activity-timeline-list">
              {activities.map((act) => {
                const timeStr = formatTimeAgo(act.timestamp)
                const txSig = act.signature
                const shortSig = txSig ? `${txSig.slice(0, 8)}...${txSig.slice(-8)}` : ''
                return (
                  <div key={act.id} className="activity-timeline-card">
                    <div className="activity-main-info">
                      <div className="activity-icon-container">
                        {act.actionType === 'Swap' && '🔄'}
                        {act.actionType === 'Deposit' && '📥'}
                        {act.actionType === 'Withdraw' && '📤'}
                        {act.actionType === 'Pool Creation' && '➕'}
                        {act.actionType === 'Fee Collection' && '🪙'}
                      </div>
                      <div className="activity-details-col">
                        <div className="activity-action-title">
                          <span className="action-type-bold">{act.actionType}</span>
                          <span className="action-pair-lbl">{act.tokenPair}</span>
                        </div>
                        <div className="activity-meta-details">
                          <span className="activity-timestamp">{timeStr}</span>
                          {act.poolAddress && (
                            <span className="activity-pool-pda-short" title={act.poolAddress}>
                              Pool: {act.poolAddress.slice(0, 6)}...{act.poolAddress.slice(-6)}
                            </span>
                          )}
                          {txSig && (
                            <span className="activity-sig-short" title={txSig}>
                              Sig: {shortSig}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="activity-status-col">
                      <span className={`status-badge-pill ${act.status}`}>
                        {act.status}
                      </span>
                      {txSig && (
                        <a
                          href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                          target="_blank"
                          rel="noreferrer"
                          className="activity-explorer-link-btn"
                        >
                          Open in Explorer
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default Portfolio