import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js'
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

let cachedConnection: Connection | null = null
let cachedEndpoint = ''

function getEndpoint(): string {
  const endpointFromWindow = typeof window !== 'undefined' ? (window as any).__SOLANA_ENDPOINT : null
  if (typeof endpointFromWindow === 'string' && endpointFromWindow.length > 0) {
    return endpointFromWindow
  }
  return clusterApiUrl('devnet')
}

function getConnection(): Connection {
  const endpoint = getEndpoint()
  if (!cachedConnection || cachedEndpoint !== endpoint) {
    cachedConnection = new Connection(endpoint, 'confirmed')
    cachedEndpoint = endpoint
  }
  return cachedConnection
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

  await Promise.all(
    mapped.map(async (pool) => {
      const [v0, v1] = await Promise.all([
        getTokenBalance(connection, pool.token0Vault),
        getTokenBalance(connection, pool.token1Vault),
      ])
      pool.vault0Balance = v0
      pool.vault1Balance = v1
    }),
  )

  return { pools: mapped, ammConfigs }
}

/**
 * Fetch fresh vault balances for a single pool and surgically update the
 * getPools cache. This avoids refetching ALL pools when only one changed.
 */
export async function refreshPoolCache(dispatch: AppDispatch, poolPda: string) {
  try {
    const connection = getConnection()

    // Step 1: Read vault addresses from the cached pool entry.
    // updateQueryData is synchronous, so we capture values via closure.
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

    // Step 2: Fetch only this pool's vault balances (2 RPC calls total)
    const [newVault0, newVault1] = await Promise.all([
      getTokenBalance(connection, vault0Addr),
      getTokenBalance(connection, vault1Addr),
    ])

    // Step 3: Surgically update only this pool's balances in the cache
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

/**
 * Invalidate the full pools list (e.g. after creating a new pool).
 */
export function invalidatePoolsList(dispatch: AppDispatch) {
  dispatch(solanaApi.util.invalidateTags([{ type: 'Pools', id: 'LIST' }]))
}

/**
 * Invalidate portfolio data (e.g. after deposit/withdraw that changes LP positions).
 */
export function invalidatePortfolio(dispatch: AppDispatch) {
  dispatch(solanaApi.util.invalidateTags([{ type: 'Portfolio', id: 'LIST' }]))
}

/**
 * Combined refresh for pool + portfolio after a transaction that affects
 * both pool reserves and user LP positions (deposit / withdraw).
 */
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
      // Keep cached for 30 minutes – no more websocket-triggered refetches.
      // Data is only invalidated explicitly after transactions.
      keepUnusedDataFor: 60 * 30,
      // NO onCacheEntryAdded websocket listener – refetches are now
      // driven exclusively by transactions via the helper functions above.
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

          return { data: { state: decodedPool, vault0Balance, vault1Balance } }
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
  }),
})

export const { useGetPoolsQuery, useGetPoolStateQuery } = solanaApi
