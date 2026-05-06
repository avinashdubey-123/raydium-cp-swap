import { useCallback, useEffect, useState, useRef } from 'react'
import useProgram from '../utils/useProgram'
import { PublicKey } from '@solana/web3.js'
import { getPoolAddress } from '../utils/pda'
import { useConnection } from '@solana/wallet-adapter-react'

type UsePoolParams = {
  poolPda?: PublicKey
  ammConfig?: PublicKey
  token0Mint?: PublicKey
  token1Mint?: PublicKey
  fetchOnMount?: boolean
}

type FetchOptions = {
  force?: boolean
}

export default function usePool(params: UsePoolParams) {
  const { poolPda, ammConfig, token0Mint, token1Mint } = params
  const program = useProgram()
  const { connection } = useConnection()
  const isMounted = useRef(true)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [poolState, setPoolState] = useState<any | null>(null)
  const [vault0Amount, setVault0Amount] = useState<number | null>(null)
  const [vault1Amount, setVault1Amount] = useState<number | null>(null)
  const [decimals0, setDecimals0] = useState<number>(0)
  const [decimals1, setDecimals1] = useState<number>(0)

  const fetchPool = useCallback(async (options?: FetchOptions) => {
    setError(null)
    setLoading(true)
    try {
      const force = options?.force === true
      // compute a stable pool key (prefer explicit poolPda)
      if (!program) throw new Error('program not ready')
      let poolAddress = poolPda
      if (!poolAddress) {
        if (!ammConfig || !token0Mint || !token1Mint) {
          // nothing to fetch
          return
        }
        const [p] = await getPoolAddress(ammConfig, token0Mint, token1Mint, program.programId)
        poolAddress = p
      }

      const key = poolAddress.toBase58()

      // simple in-memory cache + in-flight dedupe to avoid spamming RPC
      // cache TTL in ms
      const TTL = 10_000
      type CacheEntry = { ts: number; state: any; v0: number | null; v1: number | null; dec0: number; dec1: number }
      // module-level cache maps
      ;(globalThis as any).__usePool_cache = (globalThis as any).__usePool_cache || new Map<string, CacheEntry>()
      ;(globalThis as any).__usePool_inflight = (globalThis as any).__usePool_inflight || new Map<string, Promise<CacheEntry | null>>()
      const cache: Map<string, CacheEntry> = (globalThis as any).__usePool_cache
      const inflight: Map<string, Promise<CacheEntry | null>> = (globalThis as any).__usePool_inflight

      const now = Date.now()
      const cached = cache.get(key)
      if (!force && cached && (now - cached.ts) < TTL) {
        console.log('[usePool] Cache hit for pool:', key, 'age:', now - cached.ts, 'ms')
        if (isMounted.current) {
          setPoolState(cached.state)
          setVault0Amount(cached.v0)
          setVault1Amount(cached.v1)
        }
        return
      }

      if (!force && inflight.has(key)) {
        console.log('[usePool] In-flight fetch in progress for pool:', key)
        const p = inflight.get(key)!
        const res = await p
        if (res && isMounted.current) {
          console.log('[usePool] In-flight result received:', { v0: res.v0, v1: res.v1 })
          setPoolState(res.state)
          setVault0Amount(res.v0)
          setVault1Amount(res.v1)
        }
        return
      }

      const promise = (async (): Promise<CacheEntry | null> => {
        try {
          console.log('[usePool] Fetching pool from RPC:', key)
          const state = await (program.account as any).poolState.fetch(poolAddress)
          console.log('[usePool] Pool state structure keys:', Object.keys(state))
          console.log('[usePool] Pool state vault fields:', { token_0_vault: state.token_0_vault, token_1_vault: state.token_1_vault, vault0: state.vault0, vault1: state.vault1, vaultA: state.vaultA, vaultB: state.vaultB })
          console.log('[usePool] Pool state fetched, vault addresses:', { v0: state.token_0_vault?.toBase58?.(), v1: state.token_1_vault?.toBase58?.() })

          let v0: number | null = null
          let v1: number | null = null
          
          const vault0Key = state.token0Vault || state.token_0_vault || state.vault0
          const vault1Key = state.token1Vault || state.token_1_vault || state.vault1

          if (vault0Key) {
            try {
              const balance0 = await connection.getTokenAccountBalance(vault0Key)
              v0 = balance0.value.uiAmount ?? (Number(balance0.value.amount) / Math.pow(10, balance0.value.decimals ?? 0))
              console.log('[usePool] Vault0 balance fetched:', v0)
            } catch (e) {
              console.error('[usePool] Error fetching vault0 balance:', e)
            }
          }
          if (vault1Key) {
            try {
              const balance1 = await connection.getTokenAccountBalance(vault1Key)
              v1 = balance1.value.uiAmount ?? (Number(balance1.value.amount) / Math.pow(10, balance1.value.decimals ?? 0))
              console.log('[usePool] Vault1 balance fetched:', v1)
            } catch (e) {
              console.error('[usePool] Error fetching vault1 balance:', e)
            }
          }

          const dec0 = Number(state.mint_0_decimals ?? state.mint0Decimals ?? 0)
          const dec1 = Number(state.mint_1_decimals ?? state.mint1Decimals ?? 0)
          console.log('[usePool] Decimals extracted:', { dec0, dec1 })

          const entry: CacheEntry = { ts: Date.now(), state, v0, v1, dec0, dec1 }
          cache.set(key, entry)
          console.log('[usePool] Cached entry stored for pool:', key)
          return entry
        } catch (e) {
          console.error('[usePool] Error fetching pool:', e)
          return null
        } finally {
          // cleanup inflight will be done by caller
        }
      })()

      inflight.set(key, promise)
      const result = await promise
      inflight.delete(key)
      if (result && isMounted.current) {
        console.log('[usePool] Fetched pool data:', { v0: result.v0, v1: result.v1, dec0: result.dec0, dec1: result.dec1, state: result.state ? 'exists' : 'null' })
        setPoolState(result.state)
        setVault0Amount(result.v0)
        setVault1Amount(result.v1)
        setDecimals0(result.dec0)
        setDecimals1(result.dec1)
      } else if (!result) {
        console.log('[usePool] Fetch returned null result')
      }

    } catch (err: any) {
      if (isMounted.current) setError(err?.message || String(err))
    } finally {
      if (isMounted.current) setLoading(false)
    }
  }, [program, connection, poolPda, ammConfig, token0Mint, token1Mint])

  useEffect(() => {
    isMounted.current = true
    const shouldFetch = (params as UsePoolParams)?.fetchOnMount ?? true
    console.log('[usePool] Effect mount, shouldFetch:', shouldFetch, 'poolPda:', params.poolPda?.toBase58?.(), 'ammConfig:', params.ammConfig?.toBase58?.())
    if (shouldFetch) fetchPool()
    return () => {
      isMounted.current = false
    }
  }, [fetchPool, params])

  const refresh = useCallback(async () => {
    await fetchPool({ force: true })
  }, [fetchPool])

  return { poolState, vault0Amount, vault1Amount, decimals0, decimals1, loading, error, refresh }
}
