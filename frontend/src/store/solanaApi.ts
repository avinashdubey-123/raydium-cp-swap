import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import { getConnection } from '../utils/SolanaProvider'
import { Connection, PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import idlJson from '../../idl/raydium_cp_swap.json'
import type { AppDispatch } from './index'

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')

export type PoolData = {
  poolPda: string | null
  name: string
  fee: string
  ammConfig: string | null
  token0: string | null
  token1: string | null
  token0Vault: string | null
  token1Vault: string | null
  vault0Balance: number | null
  vault1Balance: number | null
  lpSupply?: string
  decimals0?: number
  decimals1?: number
  raw: any
}

export type AmmConfigData = {
  publicKey: string
  [key: string]: any
}

export type PortfolioPosition = {
  poolPda: string
  token0Mint: string
  token1Mint: string
  lpMint: string
  lpTokenAccount: string
  lpTokenAmount: number
  lpTokenDecimals: number
  token0Symbol?: string
  token1Symbol?: string
  ammConfig?: string
  lpSupplyRaw?: string
  decimals0?: number
  decimals1?: number
  token0Amount: number
  token1Amount: number
}

function toPubString(v: any): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  if (v?.toBase58) return v.toBase58()
  try {
    return String(v)
  } catch {
    return null
  }
}

function toSerializableValue(v: unknown): unknown {
  if (v == null) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object' && 'toBase58' in v && typeof v.toBase58 === 'function') return v.toBase58()
  // Use anchor.BN.isBN or check for specific BN methods instead of relying on constructor.name which breaks when minified
  if (typeof v === 'object' && (anchor.BN?.isBN?.(v) || ('toArray' in v && 'toNumber' in v) || ('_isBN' in v)) && 'toString' in v && typeof v.toString === 'function') return v.toString()
  if (Array.isArray(v)) return v.map(toSerializableValue)
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Array.from(v)
  if (typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([key, value]) => [key, toSerializableValue(value)]),
    )
  }
  return String(v)
}

function toNumberValue(v: unknown): number | undefined {
  if (v == null) return undefined
  const value = Number(typeof v === 'object' && 'toString' in v && typeof v.toString === 'function' ? v.toString() : v)
  return Number.isFinite(value) ? value : undefined
}

function toStringValue(v: unknown): string | undefined {
  if (v == null) return undefined
  return String(typeof v === 'object' && 'toString' in v && typeof v.toString === 'function' ? v.toString() : v)
}

function decodeAccount(coder: anchor.BorshAccountsCoder, data: Buffer | Uint8Array) {
  const asBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data)

  let decodedPool: any = null
  try {
    decodedPool = coder.decode('PoolState', asBuffer)
  } catch {
    // no-op
  }
  if (!decodedPool) {
    try {
      decodedPool = coder.decode('poolState', asBuffer)
    } catch {
      // no-op
    }
  }
  if (!decodedPool) {
    try {
      decodedPool = coder.decode('pool_state', asBuffer)
    } catch {
      // no-op
    }
  }
  if (decodedPool) {
    return { kind: 'pool' as const, account: decodedPool }
  }

  let decodedConfig: any = null
  try {
    decodedConfig = coder.decode('AmmConfig', asBuffer)
  } catch {
    // no-op
  }
  if (!decodedConfig) {
    try {
      decodedConfig = coder.decode('ammConfig', asBuffer)
    } catch {
      // no-op
    }
  }
  if (!decodedConfig) {
    try {
      decodedConfig = coder.decode('amm_config', asBuffer)
    } catch {
      // no-op
    }
  }
  if (decodedConfig) {
    return { kind: 'config' as const, account: decodedConfig }
  }

  return null
}

async function getTokenBalance(connection: Connection, account: string | null): Promise<number | null> {
  if (!account) return null
  try {
    const balance = await connection.getTokenAccountBalance(new PublicKey(account))
    return balance?.value?.uiAmount ?? null
  } catch {
    return null
  }
}

async function getPoolStateAndVaults(
  connection: Connection,
  coder: anchor.BorshAccountsCoder,
  poolPda: string,
  token0Vault: string | null,
  token1Vault: string | null
): Promise<any> {
  const info = await connection.getAccountInfo(new PublicKey(poolPda))
  if (!info) return null

  let decodedPool: any = null
  try { decodedPool = coder.decode('PoolState', info.data) } catch {}
  if (!decodedPool) { try { decodedPool = coder.decode('poolState', info.data) } catch {} }
  if (!decodedPool) { try { decodedPool = coder.decode('pool_state', info.data) } catch {} }
  if (!decodedPool) return null

  const [vault0Balance, vault1Balance] = await Promise.all([
    getTokenBalance(connection, token0Vault),
    getTokenBalance(connection, token1Vault),
  ])

  return {
    state: toSerializableValue(decodedPool),
    vault0Balance,
    vault1Balance,
  }
}

async function fetchPoolsAndConfigs() {
  const connection = getConnection()
  const coder = new anchor.BorshAccountsCoder(idlJson as any)

  const raw = await connection.getProgramAccounts(PROGRAM_ID)
  const pools: Array<{ pubkey: PublicKey; account: any }> = []
  const ammConfigs: AmmConfigData[] = []

  for (const item of raw) {
    try {
      const decoded = decodeAccount(coder, item.account.data)
      if (!decoded) continue
      if (decoded.kind === 'pool') {
        pools.push({ pubkey: item.pubkey, account: decoded.account })
      } else {
        ammConfigs.push({ ...(toSerializableValue(decoded.account) as Record<string, unknown>), publicKey: item.pubkey.toBase58() })
      }
    } catch {
      // skip invalid account
    }
  }

  const mapped: PoolData[] = pools.map(({ pubkey, account }) => {
    const token0Vault = toPubString(account.token_0_vault ?? account.token0Vault ?? account.token0_vault)
    const token1Vault = toPubString(account.token_1_vault ?? account.token1Vault ?? account.token1_vault)
    const mint0 = toPubString(account.token_0_mint ?? account.token0Mint ?? account.mint_0 ?? account.mint0 ?? account.mint_0_mint ?? account.mint_0_pubkey)
    const mint1 = toPubString(account.token_1_mint ?? account.token1Mint ?? account.mint_1 ?? account.mint1 ?? account.mint_1_mint ?? account.mint_1_pubkey)
    const ammConfig = toPubString(account.amm_config ?? account.ammConfig ?? account.amm)
    const raw = toSerializableValue(account)

    return {
      poolPda: pubkey.toBase58(),
      name: toStringValue(account.name) ?? (mint0 ? String(mint0).slice(0, 6) : 'Pool'),
      fee: toStringValue(account.fee) ?? '-',
      ammConfig,
      token0: mint0 ?? null,
      token1: mint1 ?? null,
      token0Vault,
      token1Vault,
      vault0Balance: null,
      vault1Balance: null,
      lpSupply: toStringValue(account.lpSupply ?? account.lp_supply),
      decimals0: toNumberValue(account.mint_0_decimals ?? account.mint0Decimals ?? account.decimals0),
      decimals1: toNumberValue(account.mint_1_decimals ?? account.mint1Decimals ?? account.decimals1),
      raw,
    }
  })

  // Return pools immediately without vault balances — the UI will fetch them in batches
  return { pools: mapped, ammConfigs }
}

/**
 * Fetches vault balances for a single batch of pools (up to 10).
 * Returns a map of poolPda -> { vault0Balance, vault1Balance }.
 * All requests in the batch are fired in parallel (within the batch) but
 * the caller is expected to await each batch before requesting the next one.
 */
export async function fetchVaultBalancesBatch(
  batch: Array<{ poolPda: string | null; token0Vault: string | null; token1Vault: string | null }>
): Promise<Record<string, { vault0Balance: number | null; vault1Balance: number | null }>> {
  const connection = getConnection()
  const results: Record<string, { vault0Balance: number | null; vault1Balance: number | null }> = {}

  await Promise.all(
    batch.map(async (pool) => {
      if (!pool.poolPda) return
      const [v0, v1] = await Promise.all([
        getTokenBalance(connection, pool.token0Vault),
        getTokenBalance(connection, pool.token1Vault),
      ])
      results[pool.poolPda] = { vault0Balance: v0, vault1Balance: v1 }
    })
  )

  return results
}

export async function refreshPoolCache(dispatch: AppDispatch, poolPda: string) {
  try {
    const connection = getConnection()

    let vault0Addr: string | null = null
    let vault1Addr: string | null = null

    dispatch(
      solanaApi.util.updateQueryData('getPools', undefined, (draft: any) => {
        if (!draft?.pools) return
        const pool = draft.pools.find((p: PoolData) => p.poolPda === poolPda)
        if (pool) {
          vault0Addr = pool.token0Vault
          vault1Addr = pool.token1Vault
        }
      })
    )

    if (!vault0Addr || !vault1Addr) return

    const [newVault0, newVault1] = await Promise.all([
      getTokenBalance(connection, vault0Addr),
      getTokenBalance(connection, vault1Addr),
    ])

    dispatch(
      solanaApi.util.updateQueryData('getPools', undefined, (draft: any) => {
        if (!draft?.pools) return
        const pool = draft.pools.find((p: PoolData) => p.poolPda === poolPda)
        if (pool) {
          pool.vault0Balance = newVault0
          pool.vault1Balance = newVault1
        }
      })
    )
  } catch (err) {
    console.error('[refreshPoolCache] Error refreshing pool:', poolPda, err)
  }
}

export function invalidatePoolsList(dispatch: AppDispatch) {
  dispatch(solanaApi.util.invalidateTags([{ type: 'Pools', id: 'LIST' }]))
}

export function invalidatePortfolio(dispatch: AppDispatch) {
  dispatch(solanaApi.util.invalidateTags([{ type: 'Portfolio', id: 'LIST' }]))
}

export async function refreshAfterPoolTx(dispatch: AppDispatch, poolPda: string) {
  await refreshPoolCache(dispatch, poolPda)
  invalidatePortfolio(dispatch)
}

export const solanaApi = createApi({
  reducerPath: 'solanaApi',
  baseQuery: fakeBaseQuery(),
  tagTypes: ['Pools', 'Portfolio'],
  endpoints: (builder) => ({
    getPools: builder.query<{ pools: PoolData[]; ammConfigs: AmmConfigData[] }, void>({
      queryFn: async () => {
        try {
          const data = await fetchPoolsAndConfigs()
          return { data }
        } catch (error) {
          return {
            error: {
              status: 'CUSTOM_ERROR',
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      },
      providesTags: [{ type: 'Pools', id: 'LIST' }],
      keepUnusedDataFor: 60 * 30,
    }),
    getPoolState: builder.query<any, string>({
      queryFn: async (poolPda) => {
        try {
          const coder = new anchor.BorshAccountsCoder(idlJson as any)
          const connection = getConnection()
          const info = await connection.getAccountInfo(new PublicKey(poolPda))
          if (!info) throw new Error('Pool state account not found')
          
          let decodedPool: any = null
          try { decodedPool = coder.decode('PoolState', info.data) } catch {}
          if (!decodedPool) { try { decodedPool = coder.decode('poolState', info.data) } catch {} }
          if (!decodedPool) { try { decodedPool = coder.decode('pool_state', info.data) } catch {} }
          
          if (!decodedPool) throw new Error('Failed to decode pool state')

          const vault0Key = decodedPool.token0Vault || decodedPool.token_0_vault || decodedPool.vault0
          const vault1Key = decodedPool.token1Vault || decodedPool.token_1_vault || decodedPool.vault1

          let vault0Balance: number | null = null
          let vault1Balance: number | null = null

          if (vault0Key) vault0Balance = await getTokenBalance(connection, toPubString(vault0Key))
          if (vault1Key) vault1Balance = await getTokenBalance(connection, toPubString(vault1Key))

          return { data: { state: toSerializableValue(decodedPool), vault0Balance, vault1Balance } }
        } catch (error) {
          return {
            error: {
              status: 'CUSTOM_ERROR',
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      },
      providesTags: (_result, _error, poolPda) => [{ type: 'Pools', id: poolPda }],
      keepUnusedDataFor: 60, // Cache for 60 seconds
    }),
    getPoolStatesBatch: builder.query<
      Record<string, { state: any; vault0Balance: number | null; vault1Balance: number | null }>,
      Array<{ poolPda: string; token0Vault: string | null; token1Vault: string | null }>
    >({
      queryFn: async (batch) => {
        try {
          const connection = getConnection()
          const coder = new anchor.BorshAccountsCoder(idlJson as any)
          const results: Record<string, { state: any; vault0Balance: number | null; vault1Balance: number | null }> = {}

          await Promise.all(
            batch.map(async (pool) => {
              const result = await getPoolStateAndVaults(connection, coder, pool.poolPda, pool.token0Vault, pool.token1Vault)
              if (result) {
                results[pool.poolPda] = result
              }
            })
          )

          return { data: results }
        } catch (error) {
          return {
            error: {
              status: 'CUSTOM_ERROR',
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      },
      keepUnusedDataFor: 60,
    }),
  }),
})

export const { useGetPoolsQuery, useGetPoolStateQuery, useGetPoolStatesBatchQuery } = solanaApi
