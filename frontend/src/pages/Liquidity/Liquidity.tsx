import { useNavigate } from 'react-router-dom'
import './Liquidity.css'
import usePool from '../../hooks/usePool'
import useProgram from '../../utils/useProgram'
import { PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import idlJson from '../../../idl/raydium_cp_swap.json'
import { useConnection } from '@solana/wallet-adapter-react'
import { getPoolAddress, getPoolVaultAddress } from '../../utils/pda'
import { useEffect, useState, useRef } from 'react'
import copyIcon from '../../assets/copy.svg'
import swapIcon from '../../assets/swap.svg'
import { getShortTokenName, getPoolDisplayName } from '../../utils/token'

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
    const feeRate = config.tradeFeeRate ?? config.trade_fee_rate ?? 0
    return `${(Number(feeRate) / 10000).toFixed(2)}%`
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

  const copyText = async (value?: string | null) => {
    if (!value) return
    try { await navigator.clipboard.writeText(value) } catch (e) { }
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
                  <button className="lp-copy-btn" onClick={() => copyText(hoverInfo.poolId)} title="Copy pool id" aria-label="Copy pool id">
                    <img src={copyIcon} alt="Copy" />
                  </button>
                </div>
                <div className="lp-hover-row">
                  <span><strong>token0:</strong> {hoverInfo.token0 ?? '-'}</span>
                  <button className="lp-copy-btn" onClick={() => copyText(hoverInfo.token0)} title="Copy token0" aria-label="Copy token0">
                    <img src={copyIcon} alt="Copy" />
                  </button>
                </div>
                <div className="lp-hover-row">
                  <span><strong>token1:</strong> {hoverInfo.token1 ?? '-'}</span>
                  <button className="lp-copy-btn" onClick={() => copyText(hoverInfo.token1)} title="Copy token1" aria-label="Copy token1">
                    <img src={copyIcon} alt="Copy" />
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

const Liquidity = () => {
  const navigate = useNavigate()
  const program = useProgram()
  const { connection } = useConnection()
  const [pools, setPools] = useState<any[]>([])
  const [ammConfigs, setAmmConfigs] = useState<any[]>([])
  const [loadingPools, setLoadingPools] = useState(true)
  const [poolsError, setPoolsError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    let mounted = true
    async function loadPools() {
      setLoadingPools(true)
      setPoolsError(null)
      try {
        let accounts: Array<any> = []
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
        const maxAttempts = 5
        let attempt = 0
        let lastErr: any = null

        // Fetch AMM Configs dynamically to map correct Fee Tiers
        let fetchedConfigs: any[] = []

        while (attempt < maxAttempts) {
          attempt++
          try {
            if (program) {
              const [allPoolsRes, allConfigsRes] = await Promise.all([
                (program.account as any).poolState.all(),
                (program.account as any).ammConfig.all()
              ])
              accounts = allPoolsRes.map((a: any) => ({ pubkey: a.publicKey, account: a.account }))
              fetchedConfigs = allConfigsRes.map((c: any) => ({
                ...c.account,
                publicKey: c.publicKey,
              }))
            } else {
              const raw = await connection.getProgramAccounts(PROGRAM_ID)
              const coder = new anchor.BorshAccountsCoder(idlJson as any)
              accounts = []
              for (const r of raw) {
                try {
                  const data = r.account.data as any
                  let buf: Buffer

                  if (Buffer.isBuffer(data)) {
                    buf = data
                  } else if (data instanceof Uint8Array) {
                    buf = Buffer.from(data)
                  } else if (typeof data === 'string') {
                    buf = Buffer.from(data, 'base64')
                  } else if (Array.isArray(data) && data.length > 0) {
                    buf = Buffer.from(data[0], 'base64')
                  } else {
                    continue
                  }

                  // Try to decode as PoolState
                  let decodedPool: any = null
                  try { decodedPool = coder.decode('PoolState', buf) } catch (e) { }
                  if (!decodedPool) try { decodedPool = coder.decode('poolState', buf) } catch (e) { }
                  if (!decodedPool) try { decodedPool = coder.decode('pool_state', buf) } catch (e) { }

                  if (decodedPool) {
                    accounts.push({ pubkey: r.pubkey, account: decodedPool })
                    continue
                  }

                  // Try to decode as AmmConfig
                  let decodedConfig: any = null
                  try { decodedConfig = coder.decode('AmmConfig', buf) } catch (e) { }
                  if (!decodedConfig) try { decodedConfig = coder.decode('ammConfig', buf) } catch (e) { }
                  if (!decodedConfig) try { decodedConfig = coder.decode('amm_config', buf) } catch (e) { }

                  if (decodedConfig) {
                    fetchedConfigs.push({
                      ...decodedConfig,
                      publicKey: r.pubkey,
                    })
                  }
                } catch (err) {
                  // skip decoding errors
                }
              }
            }
            if (mounted) {
              setAmmConfigs(fetchedConfigs)
            }
            lastErr = null
            break
          } catch (err: any) {
            lastErr = err
            const msg = (err?.message || String(err) || '').toLowerCase()
            if (msg.includes('429') || msg.includes('too many requests')) {
              // Log a single clean warning notification once instead of spamming full stack traces
              if (attempt === 1) {
                console.warn('Solana Devnet RPC Rate Limit hit (HTTP 429). Retrying requests in background with backoff...')
              }
              const backoff = Math.min(500 * Math.pow(2, attempt - 1), 4000) + Math.round(Math.random() * 200)
              await sleep(backoff)
              continue
            }
            console.warn(`Error loading pools on attempt ${attempt}: ${err?.message || err}`)
            break
          }
        }
        if (lastErr) throw lastErr

        const mapped: any[] = []
        const vaultPubkeys: string[] = []

        const toPubString = (v: any) => {
          if (!v) return null
          if (typeof v === 'string') return v
          if (v?.toBase58) return v.toBase58()
          try { return String(v) } catch { return null }
        }

        for (const a of accounts) {
          try {
            const acc = a.account
            const poolPubkey = a.pubkey ? (a.pubkey.toBase58 ? a.pubkey.toBase58() : String(a.pubkey)) : null
            const token0Vault = toPubString(acc.token_0_vault ?? acc.token0Vault ?? acc.token0_vault)
            const token1Vault = toPubString(acc.token_1_vault ?? acc.token1Vault ?? acc.token1_vault)
            const mint0 = toPubString(acc.token_0_mint ?? acc.token0Mint ?? acc.mint_0 ?? acc.mint0 ?? acc.mint_0_mint ?? acc.mint_0_pubkey)
            const mint1 = toPubString(acc.token_1_mint ?? acc.token1Mint ?? acc.mint_1 ?? acc.mint1 ?? acc.mint_1_mint ?? acc.mint_1_pubkey)
            const ammConfig = toPubString(acc.amm_config ?? acc.ammConfig ?? acc.amm)

            if (token0Vault) vaultPubkeys.push(token0Vault)
            if (token1Vault) vaultPubkeys.push(token1Vault)

            mapped.push({
              poolPda: poolPubkey,
              name: acc.name ?? (mint0 ? String(mint0).slice(0, 6) : 'Pool'),
              fee: acc.fee ?? '-',
              ammConfig,
              token0: mint0 ?? null,
              token1: mint1 ?? null,
              token0Vault,
              token1Vault,
              vault0Balance: null,
              vault1Balance: null,
              lpSupply: acc.lpSupply ?? acc.lp_supply ?? undefined,
              raw: acc,
            })
          } catch (err) {
            // ignore per-account errors
          }
        }

        const uniqueVaults = Array.from(new Set(vaultPubkeys))
        const fetchBalancesBatched = async (pubs: string[], concurrency = 2) => {
          const results = new Map<string, number | null>()
          const queue = pubs.slice()
          const worker = async () => {
            while (queue.length) {
              const p = queue.shift()!
              await new Promise((r) => setTimeout(r, 120 + Math.round(Math.random() * 80)))
              let attempts = 0
              while (attempts < 8) {
                try {
                  const b = await connection.getTokenAccountBalance(new PublicKey(p))
                  results.set(p, b?.value?.uiAmount ?? null)
                  break
                } catch (err: any) {
                  attempts++
                  const is429 = String(err?.message || '').toLowerCase().includes('429') || String(err?.message || '').toLowerCase().includes('too many requests')
                  const base = is429 ? 1000 : 300
                  const wait = Math.min(base * Math.pow(2, attempts), 6000) + Math.round(Math.random() * 300)
                  await new Promise((r) => setTimeout(r, wait))
                  if (attempts >= 8) results.set(p, null)
                }
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(concurrency, pubs.length) }, () => worker()))
          return results
        }

        const balances = await fetchBalancesBatched(uniqueVaults, 5)
        for (const m of mapped) {
          if (m.token0Vault) m.vault0Balance = balances.get(m.token0Vault) ?? null
          if (m.token1Vault) m.vault1Balance = balances.get(m.token1Vault) ?? null
        }

        if (mounted) setPools(mapped)
      } catch (err: any) {
        if (mounted) setPoolsError(err?.message || String(err))
      } finally {
        if (mounted) setLoadingPools(false)
      }
    }
    loadPools()

    let subId: number | null = null
    try {
      subId = connection.onProgramAccountChange(PROGRAM_ID, async () => {
        if (mounted) await loadPools()
      })
    } catch (e) { }

    return () => {
      mounted = false
      if (subId != null) connection.removeProgramAccountChangeListener(subId)
    }
  }, [program, connection])

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
                <PoolRow key={p.poolPda ?? p.token0 ?? idx} pool={p} navigate={navigate} ammConfigs={ammConfigs} />
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
