import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import useProgram from '../../utils/useProgram'
import { getPoolVaultAddress } from '../../utils/pda'
import { formatUsd } from '../../utils/price'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import { RoundDirection } from '../../utils/curve/calculator'
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

const Portfolio = () => {
  const program = useProgram()
  const navigate = useNavigate()
  const { connection } = useConnection()
  const wallet = useWallet()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [positions, setPositions] = useState<ComputedPosition[]>([])
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})

  const getPools = async (): Promise<Map<string, any>> => {
    try {
      if (!program) throw new Error('Program not ready')

      // Fetch all PoolState accounts using a loose namespace access since Program is untyped here.
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

        // Fetch vault amounts from the blockchain
        const [vault0PDA] = await getPoolVaultAddress(lpPos.poolPda, lpPos.token0Mint, PROGRAM_ID)
        const [vault1PDA] = await getPoolVaultAddress(lpPos.poolPda, lpPos.token1Mint, PROGRAM_ID)

        const vault0Account = await connection.getTokenAccountBalance(vault0PDA)
        const vault1Account = await connection.getTokenAccountBalance(vault1PDA)

        const vault0Balance = new anchor.BN(vault0Account.value.amount || '0')
        const vault1Balance = new anchor.BN(vault1Account.value.amount || '0')

        // LP token supply
        const rawLpSupply = poolState.lpSupply ?? poolState.lp_supply ?? 0
        const lpTokenSupply = new anchor.BN(rawLpSupply)
        if (lpTokenSupply.lte(new anchor.BN(0))) continue

        // Convert to BN for calculations
        const lpAmountBN = new anchor.BN(lpPos.lpTokenAmount * Math.pow(10, lpPos.lpTokenDecimals))

        // Use ConstantProductCurve to compute underlying tokens
        const { tokenAmount0, tokenAmount1 } = ConstantProductCurve.lpTokensToTradingTokens(
          lpAmountBN,
          lpTokenSupply,
          vault0Balance,
          vault1Balance,
          RoundDirection.Floor
        )

        // Convert back to UI amounts (apply decimals)
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
        // Include position with 0 values if computation fails
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

    const loadPortfolio = async () => {
      try {
        setLoading(true)
        setError(null)

        const loadedPools = await getPools()

        const tokenAccounts = await getUserTokenAccounts()

        const lpPositions = filterLPs(tokenAccounts, loadedPools)

        const computedPositions = await computePositions(lpPositions, loadedPools)

        setPositions(computedPositions)
      } catch (err: any) {
        console.error('Portfolio load error:', err)
        setError('Failed to load portfolio data')
        setPositions([])
      } finally {
        setLoading(false)
      }
    }

    loadPortfolio()
  }, [program, wallet.publicKey, connection])

  if (!wallet.connected) {
    return <div className="portfolio-container">Please connect your wallet</div>
  }

  if (loading) {
    return <div className="portfolio-container">Loading portfolio...</div>
  }

  if (error) {
    return <div className="portfolio-container error">Error: {error}</div>
  }

  const totalPortfolioValue = positions
    .reduce((sum, pos) => sum + (pos.totalValue || 0), 0)

  const tokenSummary = (() => {
    const map = new Map<string, { symbol: string; amount: number; value: number; pools: Set<string> }>()
    for (const pos of positions) {
      const poolKey = pos.poolPda.toBase58()
      const t0 = pos.token0Symbol || 'TOKEN0'
      const t1 = pos.token1Symbol || 'TOKEN1'
      const t0Value = pos.token0Value ?? 0
      const t1Value = pos.token1Value ?? 0
      const t0Entry = map.get(t0) || { symbol: t0, amount: 0, value: 0, pools: new Set<string>() }
      t0Entry.amount += pos.token0Amount
      t0Entry.value += t0Value
      t0Entry.pools.add(poolKey)
      map.set(t0, t0Entry)
      const t1Entry = map.get(t1) || { symbol: t1, amount: 0, value: 0, pools: new Set<string>() }
      t1Entry.amount += pos.token1Amount
      t1Entry.value += t1Value
      t1Entry.pools.add(poolKey)
      map.set(t1, t1Entry)
    }
    return Array.from(map.values())
      .map((entry) => ({
        symbol: entry.symbol,
        amount: entry.amount,
        value: entry.value,
        poolCount: entry.pools.size,
      }))
      .sort((a, b) => b.value - a.value)
  })()

  const totalPoolsInvested = positions.length
  const totalTokensTracked = tokenSummary.length
  const activeRows = Object.values(expandedRows).filter(Boolean).length

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

  return (
    <div className="portfolio-container">
      <div className="portfolio-hero">
        <h1 className='portfolio-title'>My Portfolio</h1>
        <p>Wallet Overview</p>
      </div>

      <div className="portfolio-overview">
        <div className="overview-card">
          <div className="overview-header-row">
            <div>
              <div className="overview-kicker">Invested Assets</div>
              <div className="overview-header-title">By Token</div>
            </div>
            <div className="overview-header-meta">{totalTokensTracked} tokens tracked</div>
          </div>
          <div className="overview-summary-stats">
            <div>
              <span className="overview-stat-label">Total invested</span>
              <strong>{formatUsd(totalPortfolioValue)}</strong>
            </div>
            <div>
              <span className="overview-stat-label">Pools invested in</span>
              <strong>{totalPoolsInvested}</strong>
            </div>
          </div>
          <div className="overview-body">
            <div className="overview-list overview-token-list">
              {tokenSummary.length === 0 ? (
                <div className="overview-empty">No positions yet</div>
              ) : (
                tokenSummary.slice(0, 6).map((token) => (
                  <div className="overview-row token-summary-row" key={token.symbol}>
                    <div className="overview-dot" />
                    <div className="overview-label">{token.symbol}</div>
                    <div className="overview-value">{token.amount.toFixed(4)}</div>
                    <div className="overview-percent">{token.poolCount} pools</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="overview-card">
          <div className="overview-header-row">
            <div>
              <div className="overview-kicker">Invested assets</div>
              <div className="overview-header-title">By Value</div>
            </div>
            <div className="overview-header-meta">{activeRows} expanded rows</div>
          </div>
          <div className="overview-summary-stats overview-summary-stats-alt">
            <div>
              <span className="overview-stat-label">Portfolio value</span>
              <strong>{formatUsd(totalPortfolioValue)}</strong>
            </div>
            <div>
              <span className="overview-stat-label">Average per pool</span>
              <strong>{formatUsd(totalPoolsInvested > 0 ? totalPortfolioValue / totalPoolsInvested : 0)}</strong>
            </div>
          </div>
          <div className="overview-body">
            <div className="overview-list overview-token-list">
              {tokenSummary.length === 0 ? (
                <div className="overview-empty">No invested tokens yet</div>
              ) : (
                tokenSummary.slice(0, 6).map((token) => (
                  <div className="overview-row token-summary-row" key={`${token.symbol}-value`}>
                    <div className="overview-dot" />
                    <div className="overview-label">{token.symbol}</div>
                    <div className="overview-value">{formatUsd(token.value)}</div>
                    <div className="overview-percent">{token.poolCount} pools</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="portfolio-section">
        <div className="section-header">
          <h2>My positions</h2>
          <div className="section-actions">
            <button className="section-cta" type="button" onClick={() => navigate('/portfolio/creator-fees')}>
              Collect creator fees
            </button>
          </div>
        </div>

        {positions.length === 0 ? (
          <div className="positions-empty">You do not have any positions yet.</div>
        ) : (
          <div className="positions-table">
            <div className="positions-table-head">
              <span>Asset</span>
              <span>LP</span>
              <span>Token split</span>
              <span>Value</span>
              <span />
            </div>
            {positions.map((pos, idx) => (
              <div
                key={`${pos.lpMint.toBase58()}-${idx}`}
                className={`position-card ${expandedRows[`${pos.lpMint.toBase58()}-${idx}`] ? 'expanded' : ''}`}
              >
                <div className="position-header position-row-summary">
                  <div className="position-row-asset">
                    <div className="position-pair">
                      {pos.token0Symbol}/{pos.token1Symbol || 'Unknown Pair'}
                    </div>
                    <div className="position-sub">Pool {pos.poolPda.toBase58().slice(0, 8)}...</div>
                  </div>
                  <div className="position-row-lp">{pos.lpTokenAmount.toFixed(4)}</div>
                  <div className="position-row-split">
                    <span>{pos.token0Amount.toFixed(4)} {pos.token0Symbol}</span>
                    <span>{pos.token1Amount.toFixed(4)} {pos.token1Symbol}</span>
                  </div>
                  <div className="position-row-value">{formatUsd(pos.totalValue)}</div>
                  <button
                    className="position-expand"
                    type="button"
                    aria-expanded={Boolean(expandedRows[`${pos.lpMint.toBase58()}-${idx}`])}
                    aria-label="Toggle position details"
                    onClick={() => toggleRow(`${pos.lpMint.toBase58()}-${idx}`)}
                  >
                    <span className={`position-expand-icon ${expandedRows[`${pos.lpMint.toBase58()}-${idx}`] ? 'open' : ''}`} />
                  </button>
                </div>

                <div className="position-details position-details-collapsed">
                  <div className="token-row">
                    <span className="label">{pos.token0Symbol}</span>
                    <span className="amount">{pos.token0Amount.toFixed(6)}</span>
                    <span className="value">{formatUsd(pos.token0Value)}</span>
                  </div>
                  <div className="token-row">
                    <span className="label">{pos.token1Symbol}</span>
                    <span className="amount">{pos.token1Amount.toFixed(6)}</span>
                    <span className="value">{formatUsd(pos.token1Value)}</span>
                  </div>
                </div>

                {expandedRows[`${pos.lpMint.toBase58()}-${idx}`] ? (
                  <div className="position-details-expanded">
                    <div className="position-expander-grid">
                      <div className="position-expander-field">
                        <span className="field-label">Token 0</span>
                        <span className="field-value">{pos.token0Amount.toFixed(6)} {pos.token0Symbol}</span>
                      </div>
                      <div className="position-expander-field">
                        <span className="field-label">Token 1</span>
                        <span className="field-value">{pos.token1Amount.toFixed(6)} {pos.token1Symbol}</span>
                      </div>
                      <div className="position-expander-field">
                        <span className="field-label">Token value</span>
                        <span className="field-value">{formatUsd(pos.totalValue)}</span>
                      </div>
                      <div className="position-expander-actions">
                        <button className="position-action minus" onClick={() => openWithdraw(pos)} aria-label="Withdraw liquidity">-</button>
                        <button className="position-action plus" onClick={() => openDeposit(pos)} aria-label="Add liquidity">+</button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Portfolio