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

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')


function PoolRow({ pool, navigate }: { pool: any; navigate: any }) {
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
        console.log(err)
      }
    }
    fetchVaults()
    return () => { mounted = false }
  }, [token0, token1, ammConfig, connection, pool.vault0Balance, pool.vault1Balance])

  const shortPoolId = pool.poolPda ? `${String(pool.poolPda).slice(0, 4)}...${String(pool.poolPda).slice(-4)}` : null
  const displayName = shortPoolId ? shortPoolId : (sortedToken0 && sortedToken1 ? `${sortedToken0.toBase58().slice(0,6)} / ${sortedToken1.toBase58().slice(0,6)}` : 'Unknown')
  const [pairHash] = useState<string | null>(null)
  const vault0 = hookVault0 ?? rpcVault0 ?? pool.vault0Balance
  const vault1 = hookVault1 ?? rpcVault1 ?? pool.vault1Balance
  const volume24h = pool.volume24h ?? '-'
  const liquidityDisplay = (vault0 != null && vault1 != null) ? `${vault0} / ${vault1}` : volume24h
  const fees24h = pool.fees24h ?? '-'
  const apr = pool.apr ?? '-'

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
    try { await navigator.clipboard.writeText(value) } catch (e) {}
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

  return (
    <tr key={displayName} className="lp-row">
      <td className="lp-td lp-td-pool lp-col-pool">
        <div className="lp-td-pool-inner">
          <div className="lp-hover-wrapper" onMouseEnter={() => { void handleIconHover() }} onMouseLeave={handleIconLeave} style={{ display: 'inline-block' }}>
            <div className="lp-pool-icons" style={{ cursor: 'pointer' }} title="Hover to view pool info">
              <span className="lp-icon lp-icon-a" />
              <span className="lp-icon lp-icon-b" />
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
      <td className="lp-td lp-col-volume">{volume24h}</td>
      <td className="lp-td lp-col-fees">{fees24h}</td>
      <td className="lp-td lp-col-apr">
        <span className="lp-apr-value">{apr}</span>
      </td>
      <td className="lp-td lp-td-actions lp-col-actions">
        <button className="lp-deposit-btn" onClick={onDeposit}>Deposit</button>
      </td>
    </tr>
  )

}

const Liquidity = () => {
  const navigate = useNavigate()
  const program = useProgram()
  const { connection } = useConnection()
  const [pools, setPools] = useState<any[]>([])
  const [loadingPools, setLoadingPools] = useState(false)
  const [poolsError, setPoolsError] = useState<string | null>(null)

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

        while (attempt < maxAttempts) {
          attempt++
          try {
            if (program) {
              const all = await (program.account as any).poolState.all()
              accounts = all.map((a: any) => ({ pubkey: a.publicKey, account: a.account }))
            } else {
              const raw = await connection.getProgramAccounts(PROGRAM_ID)
              const coder = new anchor.BorshAccountsCoder(idlJson as any)
              accounts = []
              for (const r of raw) {
                const data = r.account.data
                let decoded: any = null
                try {
                  const buf = Buffer.from((data as any)[0], 'base64')
                  try { decoded = coder.decode('poolState', buf) } catch (e) {}
                  if (!decoded) try { decoded = coder.decode('pool_state', buf) } catch (e) {}
                  if (!decoded) {
                    accounts.push({ pubkey: r.pubkey, account: r.account })
                    continue
                  }
                  accounts.push({ pubkey: r.pubkey, account: decoded })
                } catch (err) {
                  accounts.push({ pubkey: r.pubkey, account: r.account })
                }
              }
            }
            lastErr = null
            break
          } catch (err: any) {
            lastErr = err
            const msg = (err?.message || String(err) || '').toLowerCase()
            console.error('Error loading pools (attempt', attempt, '):', err)
            if (msg.includes('429') || msg.includes('too many requests')) {
              const backoff = Math.min(500 * Math.pow(2, attempt - 1), 4000) + Math.round(Math.random() * 200)
              await sleep(backoff)
              continue
            }
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
              name: acc.name ?? (mint0 ? String(mint0).slice(0,6) : 'Pool'),
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
    } catch (e) {}

    return () => {
      mounted = false
      if (subId != null) connection.removeProgramAccountChangeListener(subId)
    }
  }, [program, connection])

  return (
    <div className="lp-page">
      <div className="lp-top">
        <div className="lp-top-left">
          <h1 className="lp-title">Liquidity Pools</h1>
          <p className="lp-subtitle">Provide liquidity, earn yield.</p>
        </div>

        <div className="lp-stats">
          <div className="lp-stat-card">
            <span className="lp-stat-label">TVL</span>
            <span className="lp-stat-value">$1,297,859,870.95</span>
          </div>
          <div className="lp-stat-card">
            <span className="lp-stat-label">24h Volume</span>
            <span className="lp-stat-value">$225,550,051.98</span>
          </div>
        </div>
      </div>

      <div className="lp-filter-bar">
        <div className="lp-filter-left">
          <input className="lp-search" placeholder="Search pool" />
        </div>
        
        <div className="lp-filters">
          <button className="lp-filter active">All</button>
          <button className="lp-filter">Standard</button>
          <button className="lp-filter">Stables</button>
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
              <th className="lp-th lp-col-liquidity">Liquidity (token0/token1)</th>
              <th className="lp-th lp-col-volume">Volume 24H</th>
              <th className="lp-th lp-col-fees">Fees 24H</th>
              <th className="lp-th lp-col-apr">APR 24H</th>
              <th className="lp-th lp-col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {loadingPools ? (
              <tr><td colSpan={7}>Loading pools…</td></tr>
            ) : poolsError ? (
              <tr><td colSpan={7}>Error: {poolsError}</td></tr>
            ) : pools.length === 0 ? (
              <tr><td colSpan={7}>No pools found on-chain.</td></tr>
            ) : (
              pools.map((p, idx) => (
                <PoolRow key={p.poolPda ?? p.token0 ?? idx} pool={p} navigate={navigate} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="lp-note">Deposit to any of the pools as you wish.</p>
    </div>
  )
}

export default Liquidity;
