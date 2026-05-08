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
      if (!program) throw new Error('program not ready')
      let poolAddress = poolPda
      if (!poolAddress) {
        if (!ammConfig || !token0Mint || !token1Mint) {
          return
        }
        const [p] = await getPoolAddress(ammConfig, token0Mint, token1Mint, program.programId)
        poolAddress = p
      }

      const key = poolAddress.toBase58()

      const TTL = 10_000
      type CacheEntry = { ts: number; state: any; v0: number | null; v1: number | null; dec0: number; dec1: number }
      ;(globalThis as any).__usePool_cache = (globalThis as any).__usePool_cache || new Map<string, CacheEntry>()
      ;(globalThis as any).__usePool_inflight = (globalThis as any).__usePool_inflight || new Map<string, Promise<CacheEntry | null>>()
      const cache: Map<string, CacheEntry> = (globalThis as any).__usePool_cache
      const inflight: Map<string, Promise<CacheEntry | null>> = (globalThis as any).__usePool_inflight

      const now = Date.now()
      const cached = cache.get(key)
      if (!force && cached && (now - cached.ts) < TTL) {
        if (isMounted.current) {
          setPoolState(cached.state)
          setVault0Amount(cached.v0)
          setVault1Amount(cached.v1)
        }
        return
      }

      if (!force && inflight.has(key)) {
        const p = inflight.get(key)!
        const res = await p
        if (res && isMounted.current) {
          setPoolState(res.state)
          setVault0Amount(res.v0)
          setVault1Amount(res.v1)
        }
        return
      }

      const promise = (async (): Promise<CacheEntry | null> => {
        try {
          const state = await (program.account as any).poolState.fetch(poolAddress)
          
          let v0: number | null = null
          let v1: number | null = null
          
          const vault0Key = state.token0Vault || state.token_0_vault || state.vault0
          const vault1Key = state.token1Vault || state.token_1_vault || state.vault1

          if (vault0Key) {
            try {
              const balance0 = await connection.getTokenAccountBalance(vault0Key)
              v0 = balance0.value.uiAmount ?? (Number(balance0.value.amount) / Math.pow(10, balance0.value.decimals ?? 0))
            } catch (e) {
              console.error('[usePool] Error fetching vault0 balance:', e)
            }
          }
          if (vault1Key) {
            try {
              const balance1 = await connection.getTokenAccountBalance(vault1Key)
              v1 = balance1.value.uiAmount ?? (Number(balance1.value.amount) / Math.pow(10, balance1.value.decimals ?? 0))
            } catch (e) {
              console.error('[usePool] Error fetching vault1 balance:', e)
            }
          }

          const dec0 = Number(state.mint_0_decimals ?? state.mint0Decimals ?? 0)
          const dec1 = Number(state.mint_1_decimals ?? state.mint1Decimals ?? 0)

          const entry: CacheEntry = { ts: Date.now(), state, v0, v1, dec0, dec1 }
          cache.set(key, entry)
          return entry
        } catch (e) {
          console.error('[usePool] Error fetching pool:', e)
          return null
        }
      })()

      inflight.set(key, promise)
      const result = await promise
      inflight.delete(key)
      if (result && isMounted.current) {
        setPoolState(result.state)
        setVault0Amount(result.v0)
        setVault1Amount(result.v1)
        setDecimals0(result.dec0)
        setDecimals1(result.dec1)
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
