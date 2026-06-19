import { useMemo, useRef, useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './Swap.css'
import useProgram from '../../utils/useProgram'
import { getShortTokenName, getPoolDisplayName } from '../../utils/token'
import { formatAmount } from '../../utils/format'
import { PublicKey, SendTransactionError } from '@solana/web3.js'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import * as anchor from '@coral-xyz/anchor'
import { getAuthAddress, getPoolAddress, getPoolVaultAddress, getOrcleAccountAddress } from '../../utils/pda'
import {
  TOKEN_PROGRAM_ID,
  getMint,
  getAccount,
} from '@solana/spl-token'
import copyIcon from '../../assets/copy.svg'
import straightArrowIcon from '../../assets/straight-arrow.svg'
import swapIcon from '../../assets/swap.svg'
import walletIcon from '../../assets/wallet.svg'
import BN from 'bn.js'
import { computeTransferFeeForPre, computeInverseTransferFee, CpmmFee } from '../../utils/curve/fee'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import idlJson from '../../../idl/raydium_cp_swap.json'
import { logActivity } from '../../utils/activity'
import { useGetPoolsQuery, refreshPoolCache } from '../../store/solanaApi'
import useTokenProgramAta from '../../hooks/useTokenProgramAta'
import { useDispatch } from 'react-redux'

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')

type SwapDirection = 'token0-to-token1' | 'token1-to-token0'

type Pool = {
  name?: string
  fee?: string
  poolPda?: string
  ammConfig?: string
  token0?: string
  token1?: string
  token0Mint?: string
  token1Mint?: string
  vault0Amount?: string
  vault1Amount?: string
  lpSupply?: string
  decimals0?: number
  decimals1?: number
}

type PoolData = {
  poolPda: string
  token0: string | null
  token1: string | null
  ammConfig: string | null
  raw: any
  price?: string
}

// Deterministic pleasing HSL color generation based on token symbol
function getTokenColor(symbol: string): string {
  let hash = 0
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 40%)`
}

export default function Swap() {
  const location = useLocation()
  const navigate = useNavigate()
  const rawState = (location.state as any) || {}
  const poolFromRoute = rawState?.poolPda ? (rawState as Pool) : null
  const program = useProgram()
  const wallet = useWallet()
  const { connection } = useConnection()
  const { detectTokenProgram, deriveAta, buildEnsureAtaInstruction } = useTokenProgramAta()
  const { data: poolsData, isLoading: loadingPools, error: poolsQueryError, refetch: refetchPools } = useGetPoolsQuery()
  const dispatch = useDispatch()

  const allPools = useMemo<PoolData[]>(() => (poolsData?.pools as PoolData[] | undefined) ?? [], [poolsData])
  const ammConfigs = useMemo<any[]>(() => poolsData?.ammConfigs ?? [], [poolsData])
  const poolsError = useMemo(() => {
    if (!poolsQueryError) return null
    const raw = (poolsQueryError as any).error ?? (poolsQueryError as any).data ?? poolsQueryError
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  }, [poolsQueryError])

  const [selectedPool, setSelectedPool] = useState<PoolData | null>(null)
  const [showPoolSelector, setShowPoolSelector] = useState(false)
  const [swapDirection, setSwapDirection] = useState<SwapDirection>('token0-to-token1')
  const [poolHoverInfo, setPoolHoverInfo] = useState<{ poolId?: string | null; token0?: string | null; token1?: string | null } | null>(null)
  const poolHoverTimeout = useRef<number | null>(null)

  const routePoolPda = poolFromRoute?.poolPda
  const routeMatchedPool = useMemo<PoolData | null>(() => {
    if (!routePoolPda) return null
    return allPools.find((pool) => pool.poolPda === routePoolPda) ?? null
  }, [allPools, routePoolPda])

  useEffect(() => {
    if (poolFromRoute) {
      setSelectedPool(poolFromRoute as PoolData)
      return
    }
    if (selectedPool || allPools.length === 0) return

    if (routeMatchedPool) {
      setSelectedPool(routeMatchedPool)
      return
    }
    if (!poolFromRoute) {
      setSelectedPool(allPools[0])
    }
  }, [selectedPool, allPools, routeMatchedPool, poolFromRoute])

  const clearPoolHoverTimeout = () => {
    if (poolHoverTimeout.current != null) {
      clearTimeout(poolHoverTimeout.current)
      poolHoverTimeout.current = null
    }
  }

  const showPoolHover = () => {
    clearPoolHoverTimeout()
    setPoolHoverInfo({
      poolId: poolIdStr ?? null,
      token0: token0Str ?? null,
      token1: token1Str ?? null,
    })
  }

  const hidePoolHover = () => {
    clearPoolHoverTimeout()
    poolHoverTimeout.current = window.setTimeout(() => setPoolHoverInfo(null), 150)
  }

  const getFeeTier = (pool: any) => {
    if (!pool || !pool.ammConfig) return '-'
    const poolConfigStr = typeof pool.ammConfig === 'string'
      ? pool.ammConfig
      : pool.ammConfig?.toBase58
        ? pool.ammConfig.toBase58()
        : String(pool.ammConfig)

    // 1. Try local configs cache first
    const cached = localAmmConfigsCache.get(poolConfigStr)
    if (cached) return cached

    // 2. Try the general ammConfigs list
    const config = ammConfigs.find((c) => {
      const cPubStr = typeof c.publicKey === 'string'
        ? c.publicKey
        : c.publicKey?.toBase58
          ? c.publicKey.toBase58()
          : String(c.publicKey)
      return cPubStr.toLowerCase() === poolConfigStr.toLowerCase()
    })

    if (!config) {
      if (pool.fee) {
        return String(pool.fee).includes('%') ? pool.fee : `${pool.fee}%`
      }
      return '-'
    }
    const feeRate = config.tradeFeeRate ?? config.trade_fee_rate ?? 0
    const feeRateNum = typeof feeRate === 'number'
      ? feeRate
      : feeRate?.toNumber
        ? feeRate.toNumber()
        : Number(feeRate?.toString?.()) || 0
    return `${(feeRateNum / 10000).toFixed(2)}%`
  }

  const activePool = useMemo(() => {
    if (selectedPool) return selectedPool
    if (routeMatchedPool) {
      return {
        ...poolFromRoute,
        ...routeMatchedPool,
      }
    }
    return poolFromRoute
  }, [selectedPool, routeMatchedPool, poolFromRoute])

  const poolPdaParam = useMemo(() => {
    if (!activePool?.poolPda) return undefined
    try {
      return new PublicKey(activePool.poolPda)
    } catch (e) {
      return undefined
    }
  }, [activePool?.poolPda])

  const token0MintParam = useMemo(() => {
    const mint0 = (activePool as any)?.token0 ?? (activePool as any)?.token0Mint
    if (!mint0) return undefined
    try {
      return new PublicKey(mint0)
    } catch (e) {
      return undefined
    }
  }, [activePool])

  const token1MintParam = useMemo(() => {
    const mint1 = (activePool as any)?.token1 ?? (activePool as any)?.token1Mint
    if (!mint1) return undefined
    try {
      return new PublicKey(mint1)
    } catch (e) {
      return undefined
    }
  }, [activePool])

  const ammConfigParam = useMemo(() => {
    if (!activePool?.ammConfig) return undefined
    try {
      return new PublicKey(activePool.ammConfig)
    } catch (e) {
      return undefined
    }
  }, [activePool?.ammConfig])


  const [amountIn, setAmountIn] = useState('')
  const [amountOut, setAmountOut] = useState('')
  const [lastEditedField, setLastEditedField] = useState<'input' | 'output'>('input')
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInversePrice, setShowInversePrice] = useState(false)
  const [priceDetails, setPriceDetails] = useState<{ token0ToToken1: string; token1ToToken0: string } | null>(null)
  const [priceLoading, setPriceLoading] = useState(false)
  const [slippage, setSlippage] = useState<number>(0.5)
  const [showSlippageSelector, setShowSlippageSelector] = useState(false)
  const [showSwapDetails, setShowSwapDetails] = useState(false)

  useEffect(() => {
    setShowSwapDetails(false)
    const timeoutId = setTimeout(() => setShowSwapDetails(true), 200)
    return () => clearTimeout(timeoutId)
  }, [amountIn, amountOut])

  const parseHumanAmountToBaseUnits = (value: string, decimals: number) => {
    const normalized = value.trim()
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new Error('Invalid mint decimals')
    }
    if (!/^(?:\d+)?(?:\.\d*)?$/.test(normalized)) {
      throw new Error('Invalid character')
    }

    const [wholePartRaw = '0', fractionRaw = ''] = normalized.split('.')
    const wholePart = wholePartRaw.length > 0 ? wholePartRaw : '0'
    const fractionPart = (fractionRaw + '0'.repeat(decimals)).slice(0, decimals)
    const baseUnits = `${wholePart}${fractionPart}`.replace(/^0+(?=\d)/, '')
    return new BN(baseUnits || '0')
  }

  const formatBaseUnitsToHuman = (value: BN, decimals: number) => {
    if (decimals <= 0) return value.toString()

    const raw = value.toString().padStart(decimals + 1, '0')
    const wholePart = raw.slice(0, -decimals) || '0'
    const fractionPart = raw.slice(-decimals).replace(/0+$/, '')
    return fractionPart ? `${wholePart}.${fractionPart}` : wholePart
  }

  const isAlreadyProcessedError = (err: any) => {
    const rawMsg = [err?.message, err?.transactionMessage, String(err || '')].filter(Boolean).join(' ').toLowerCase()
    return rawMsg.includes('already') && rawMsg.includes('processed')
  }

  const shorten = (v?: string | null) => {
    if (!v) return '-'
    return `${v.slice(0, 4)}...${v.slice(-4)}`
  }

  const poolIdStr = activePool?.poolPda
  const token0Str = activePool?.token0
  const token1Str = activePool?.token1
  const isToken0ToToken1 = swapDirection === 'token0-to-token1'
  const inputTokenLabel = 'Input Token Amount'
  const outputTokenLabel = 'Output Token Amount'
  const inputTokenAddress = isToken0ToToken1 ? token0Str : token1Str
  const outputTokenAddress = isToken0ToToken1 ? token1Str : token0Str
  const inputTokenShort = getShortTokenName(inputTokenAddress)
  const outputTokenShort = getShortTokenName(outputTokenAddress)
  const inputQuoteLabel = getShortTokenName(inputTokenAddress)
  const outputQuoteLabel = getShortTokenName(outputTokenAddress)

  const getPoolLabel = () => {
    if (!activePool) return 'Select Pool'
    if (token0Str && token1Str) {
      return getPoolDisplayName(token0Str, token1Str)
    }
    return poolIdStr ? shorten(poolIdStr) : 'Select Pool'
  }

  const getPoolSelectorLabel = () => {
    if (loadingPools) return 'Loading pools...'
    return getPoolLabel()
  }

  const [userBalances, setUserBalances] = useState<{ token0: string; token1: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [poolReserves, setPoolReserves] = useState<{ reserve0: string; reserve1: string } | null>(null)
  const [activePoolFeeTier, setActivePoolFeeTier] = useState<string>('-')
  const [localAmmConfigsCache, setLocalAmmConfigsCache] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (allPools.length === 0) return

    let mounted = true
    const fetchAllUniqueAmmConfigs = async () => {
      try {
        const uniqueConfigs = Array.from(new Set(allPools.map(p => p.ammConfig).filter(Boolean))) as string[]
        if (uniqueConfigs.length === 0) return

        const publicKeys = uniqueConfigs.map(addr => new PublicKey(addr))
        const accountsInfo = await connection.getMultipleAccountsInfo(publicKeys)

        const newCache = new Map<string, string>()
        const coder = new anchor.BorshAccountsCoder(idlJson as any)

        accountsInfo.forEach((info, idx) => {
          if (info) {
            let decoded: any = null
            try { decoded = coder.decode('AmmConfig', info.data) } catch (e) { }
            if (!decoded) try { decoded = coder.decode('ammConfig', info.data) } catch (e) { }
            if (!decoded) try { decoded = coder.decode('amm_config', info.data) } catch (e) { }

            if (decoded) {
              const feeRate = decoded.tradeFeeRate ?? decoded.trade_fee_rate ?? 0
              const feeRateNum = typeof feeRate === 'number'
                ? feeRate
                : feeRate?.toNumber
                  ? feeRate.toNumber()
                  : Number(feeRate?.toString?.()) || 0
              const tier = `${(feeRateNum / 10000).toFixed(2)}%`
              newCache.set(uniqueConfigs[idx], tier)
            }
          }
        })

        if (mounted) {
          setLocalAmmConfigsCache(newCache)
        }
      } catch (err) {
        console.error('Error fetching all unique AMM configs:', err)
      }
    }

    fetchAllUniqueAmmConfigs()
    return () => {
      mounted = false
    }
  }, [allPools, connection])

  const parseBalanceValue = (bal: string | null | undefined): number => {
    if (!bal || bal === '-') return 0
    const parsed = Number(bal.replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }

  useEffect(() => {
    const configStr = activePool?.ammConfig
    if (!configStr) {
      setActivePoolFeeTier('-')
      return
    }

    let mounted = true
    const fetchSpecificAmmConfig = async () => {
      try {
        const configPubkey = new PublicKey(configStr)
        let configAcct: any = null

        if (program) {
          try {
            configAcct = await (program.account as any).ammConfig.fetch(configPubkey)
          } catch (e) {
            console.warn('Failed to fetch via program, trying connection getAccountInfo:', e)
          }
        }

        if (!configAcct) {
          const info = await connection.getAccountInfo(configPubkey)
          if (info) {
            const coder = new anchor.BorshAccountsCoder(idlJson as any)
            try { configAcct = coder.decode('AmmConfig', info.data) } catch (e) { }
            if (!configAcct) try { configAcct = coder.decode('ammConfig', info.data) } catch (e) { }
            if (!configAcct) try { configAcct = coder.decode('amm_config', info.data) } catch (e) { }
          }
        }

        if (!mounted) return

        const poolAny = activePool as any
        if (configAcct) {
          const feeRate = configAcct.tradeFeeRate ?? configAcct.trade_fee_rate ?? 0
          const feeRateNum = typeof feeRate === 'number'
            ? feeRate
            : feeRate?.toNumber
              ? feeRate.toNumber()
              : Number(feeRate?.toString?.()) || 0
          setActivePoolFeeTier(`${(feeRateNum / 10000).toFixed(2)}%`)
        } else if (poolAny.fee) {
          const feeStr = String(poolAny.fee)
          setActivePoolFeeTier(feeStr.includes('%') ? feeStr : `${feeStr}%`)
        } else {
          setActivePoolFeeTier('-')
        }
      } catch (err) {
        console.error('Error fetching specific AMM config:', err)
        if (mounted) {
          const poolAny = activePool as any
          if (poolAny.fee) {
            const feeStr = String(poolAny.fee)
            setActivePoolFeeTier(feeStr.includes('%') ? feeStr : `${feeStr}%`)
          } else {
            setActivePoolFeeTier('-')
          }
        }
      }
    }

    fetchSpecificAmmConfig()
    return () => {
      mounted = false
    }
  }, [activePool?.ammConfig, program, connection])

  const inputTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const outputTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const updateInputAmount = (value: string) => {
    setLastEditedField('input')
    setAmountIn(value)
    
    if (inputTimeoutRef.current) clearTimeout(inputTimeoutRef.current)

    if (!value || Number(value) <= 0) {
      setAmountOut('')
      return
    }
    
    setAmountOut('0')
    
    inputTimeoutRef.current = setTimeout(async () => {
      try {
        const quote = await quoteExactIn(value)
        setAmountOut(formatBaseUnitsToHuman(quote.receiveAmount, quote.outputDecimals))
      } catch (err) {
        setAmountOut('')
      }
    }, 200)
  }

  const updateOutputAmount = (value: string) => {
    setLastEditedField('output')
    setAmountOut(value)
    
    if (outputTimeoutRef.current) clearTimeout(outputTimeoutRef.current)

    if (!value || Number(value) <= 0) {
      setAmountIn('')
      return
    }

    setAmountIn('0')

    outputTimeoutRef.current = setTimeout(async () => {
      try {
        const quote = await quoteExactOut(value)
        setAmountIn(formatBaseUnitsToHuman(quote.maxInputPreFee, quote.inputDecimals))
      } catch (err) {
        setAmountIn('')
      }
    }, 200)
  }

  const [showWalletConnectedToast, setShowWalletConnectedToast] = useState(false)
  const previousConnectedRef = useRef<boolean | null>(null)

  useEffect(() => {
    if (previousConnectedRef.current === null) {
      previousConnectedRef.current = wallet.connected
      return
    }

    if (!previousConnectedRef.current && wallet.connected) {
      setShowWalletConnectedToast(true)
    } else if (!wallet.connected) {
      setShowWalletConnectedToast(false)
    }

    previousConnectedRef.current = wallet.connected
  }, [wallet.connected])

  useEffect(() => {
    if (!wallet.publicKey || !activePool) {
      setUserBalances(null)
      return
    }

    let mounted = true
    const fetchUserBalances = async () => {
      try {
        const owner = wallet.publicKey!
        const poolAny = activePool as any
        const mint0Str = poolAny.token0 || poolAny.token0Mint
        const mint1Str = poolAny.token1 || poolAny.token1Mint

        if (!mint0Str || !mint1Str) return

        const mint0 = new PublicKey(mint0Str)
        const mint1 = new PublicKey(mint1Str)

        let dec0 = Number(poolAny.raw?.mint_0_decimals ?? poolAny.raw?.mint0Decimals ?? poolAny.raw?.decimals0 ?? poolAny.decimals0 ?? 0)
        let dec1 = Number(poolAny.raw?.mint_1_decimals ?? poolAny.raw?.mint1Decimals ?? poolAny.raw?.decimals1 ?? poolAny.decimals1 ?? 0)

        const isSol0 = mint0Str.toLowerCase() === 'so11111111111111111111111111111111111111112'
        const isSol1 = mint1Str.toLowerCase() === 'so11111111111111111111111111111111111111112'

        const fmt = (val: number) => formatAmount(val)

        const callWithRetry = async <T extends unknown>(fn: () => Promise<T>, maxRetries = 5): Promise<T> => {
          let attempt = 0
          while (attempt < maxRetries) {
            attempt++
            try {
              return await fn()
            } catch (err: any) {
              const msg = String(err?.message || '').toLowerCase()
              if (attempt < maxRetries && (msg.includes('429') || msg.includes('too many requests'))) {
                const wait = Math.min(200 * Math.pow(2, attempt), 2000) + Math.round(Math.random() * 100)
                await new Promise((r) => setTimeout(r, wait))
                continue
              }
              throw err
            }
          }
          throw new Error('Max retries reached')
        }

        const tokenProgram0 = isSol0 ? TOKEN_PROGRAM_ID : await callWithRetry(() => detectTokenProgram(mint0)).catch(() => TOKEN_PROGRAM_ID)
        const tokenProgram1 = isSol1 ? TOKEN_PROGRAM_ID : await callWithRetry(() => detectTokenProgram(mint1)).catch(() => TOKEN_PROGRAM_ID)

        if (dec0 === 0 && !isSol0) {
          try {
            const mInfo = await callWithRetry(() => getMint(connection, mint0, 'confirmed', tokenProgram0))
            dec0 = mInfo.decimals
          } catch (e) { }
        }
        if (dec1 === 0 && !isSol1) {
          try {
            const mInfo = await callWithRetry(() => getMint(connection, mint1, 'confirmed', tokenProgram1))
            dec1 = mInfo.decimals
          } catch (e) { }
        }

        let bal0 = '0'
        let bal1 = '0'

        if (isSol0) {
          const solBal = await callWithRetry(() => connection.getBalance(owner))
          bal0 = fmt(solBal / 1e9)
        } else {
          const ata0 = deriveAta(owner, mint0, tokenProgram0, true)
          const b0 = await callWithRetry(() => connection.getTokenAccountBalance(ata0)).catch(() => null)
          if (b0) {
            bal0 = b0.value.uiAmount != null ? fmt(b0.value.uiAmount) : fmt(Number(b0.value.amount) / Math.pow(10, dec0))
          }
        }

        if (isSol1) {
          const solBal = await callWithRetry(() => connection.getBalance(owner))
          bal1 = fmt(solBal / 1e9)
        } else {
          const ata1 = deriveAta(owner, mint1, tokenProgram1, true)
          const b1 = await callWithRetry(() => connection.getTokenAccountBalance(ata1)).catch(() => null)
          if (b1) {
            bal1 = b1.value.uiAmount != null ? fmt(b1.value.uiAmount) : fmt(Number(b1.value.amount) / Math.pow(10, dec1))
          }
        }

        if (mounted) {
          setUserBalances({ token0: bal0, token1: bal1 })
        }
      } catch (e) {
        console.error('Error fetching user balances:', e)
      }
    }

    fetchUserBalances()
    return () => {
      mounted = false
    }
  }, [wallet.publicKey, activePool, connection])

  const toggleSwapDirection = () => {
    setSwapDirection((current) => (current === 'token0-to-token1' ? 'token1-to-token0' : 'token0-to-token1'))
    setAmountIn('')
    setAmountOut('')
    setLastEditedField('input')
    setStatus(null)
    setErrorDetails(null)
    setTxResult(null)
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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleSwap()
  }

  const loadSwapContext = async (ownerPublicKey?: PublicKey) => {
    const programId = program ? (program as any).programId as PublicKey : PROGRAM_ID
    let t0 = token0MintParam as PublicKey | undefined
    let t1 = token1MintParam as PublicKey | undefined
    if (!t0 || !t1) {
      throw new Error('Selected pool is missing token mint addresses')
    }
    if (t0 && t1) {
      const cmp = Buffer.compare(t0.toBuffer(), t1.toBuffer())
      if (cmp > 0) {
        const tmp = t0
        t0 = t1
        t1 = tmp
      }
    }

    let poolAddr = poolPdaParam
    if (!poolAddr) {
      if (!ammConfigParam) throw new Error('Selected pool is missing amm config')
      const [p] = await getPoolAddress(ammConfigParam as PublicKey, t0!, t1!, programId)
      poolAddr = p
    }

    const [observationState] = await getOrcleAccountAddress(poolAddr, programId)
    const [token0Vault] = await getPoolVaultAddress(poolAddr, t0 as PublicKey, programId)
    const [token1Vault] = await getPoolVaultAddress(poolAddr, t1 as PublicKey, programId)
    const inputTokenProgram = await detectTokenProgram(t0 as PublicKey)
    const outputTokenProgram = await detectTokenProgram(t1 as PublicKey)
    const inputTokenAccount = ownerPublicKey ? deriveAta(ownerPublicKey, t0!, inputTokenProgram) : null
    const outputTokenAccount = ownerPublicKey ? deriveAta(ownerPublicKey, t1!, outputTokenProgram) : null

    let mint0: any = { decimals: 9 }
    let mint1: any = { decimals: 9 }
    try { mint0 = await getMint(connection, t0!, 'confirmed', inputTokenProgram) } catch (e) { }
    try { mint1 = await getMint(connection, t1!, 'confirmed', outputTokenProgram) } catch (e) { }

    let vault0Amount = new BN(0)
    let vault1Amount = new BN(0)
    try {
      const vault0Acct = await getAccount(connection, token0Vault, 'confirmed', inputTokenProgram)
      vault0Amount = new BN(vault0Acct.amount.toString())
    } catch (e) {
      try {
        const bal0 = await connection.getTokenAccountBalance(token0Vault)
        vault0Amount = new BN(bal0.value.amount)
      } catch (err) { }
    }

    try {
      const vault1Acct = await getAccount(connection, token1Vault, 'confirmed', outputTokenProgram)
      vault1Amount = new BN(vault1Acct.amount.toString())
    } catch (e) {
      try {
        const bal1 = await connection.getTokenAccountBalance(token1Vault)
        vault1Amount = new BN(bal1.value.amount)
      } catch (err) { }
    }

    let poolStateAcct: any = null
    if (program) {
      poolStateAcct = await (program.account as any).poolState.fetch(poolAddr)
    } else {
      const info = await connection.getAccountInfo(poolAddr)
      if (!info) throw new Error('Pool account not found')
      const coder = new anchor.BorshAccountsCoder(idlJson as any)
      try { poolStateAcct = coder.decode('poolState', info.data) } catch (e) { }
      if (!poolStateAcct) try { poolStateAcct = coder.decode('pool_state', info.data) } catch (e) { }
      if (!poolStateAcct) try { poolStateAcct = coder.decode('PoolState', info.data) } catch (e) { }
      if (!poolStateAcct) throw new Error('Failed to decode pool state')
    }

    const proto0 = new BN(poolStateAcct.protocolFeesToken0?.toString?.() ?? poolStateAcct.protocolFeesToken0 ?? 0)
    const fund0 = new BN(poolStateAcct.fundFeesToken0?.toString?.() ?? poolStateAcct.fundFeesToken0 ?? 0)
    const creator0 = new BN(poolStateAcct.creatorFeesToken0?.toString?.() ?? poolStateAcct.creatorFeesToken0 ?? 0)
    const feesToken0 = proto0.add(fund0).add(creator0)

    const proto1 = new BN(poolStateAcct.protocolFeesToken1?.toString?.() ?? poolStateAcct.protocolFeesToken1 ?? 0)
    const fund1 = new BN(poolStateAcct.fundFeesToken1?.toString?.() ?? poolStateAcct.fundFeesToken1 ?? 0)
    const creator1 = new BN(poolStateAcct.creatorFeesToken1?.toString?.() ?? poolStateAcct.creatorFeesToken1 ?? 0)
    const feesToken1 = proto1.add(fund1).add(creator1)

    const totalVault0 = vault0Amount.sub(feesToken0)
    const totalVault1 = vault1Amount.sub(feesToken1)

    const targetAmmConfig = ammConfigParam?.toBase58()
    const matchedConfig = ammConfigs.find((c) => {
      const key = typeof c.publicKey === 'string'
        ? c.publicKey
        : c.publicKey?.toBase58
          ? c.publicKey.toBase58()
          : String(c.publicKey)
      return key === targetAmmConfig
    })

    let ammConfigAcct: any = matchedConfig
    if (!ammConfigAcct) {
      if (program) {
        try {
          ammConfigAcct = await (program.account as any).ammConfig.fetch(ammConfigParam as PublicKey)
        } catch (e) { }
      } else if (ammConfigParam) {
        try {
          const configInfo = await connection.getAccountInfo(ammConfigParam)
          if (configInfo) {
            const coder = new anchor.BorshAccountsCoder(idlJson as any)
            try { ammConfigAcct = coder.decode('AmmConfig', configInfo.data) } catch (e) { }
            if (!ammConfigAcct) try { ammConfigAcct = coder.decode('ammConfig', configInfo.data) } catch (e) { }
            if (!ammConfigAcct) try { ammConfigAcct = coder.decode('amm_config', configInfo.data) } catch (e) { }
          }
        } catch (e) { }
      }
    }

    const tradeFeeRate = new BN(ammConfigAcct?.tradeFeeRate?.toString?.() ?? ammConfigAcct?.trade_fee_rate ?? 0)
    const creatorFeeRate = new BN(ammConfigAcct?.creatorFeeRate?.toString?.() ?? ammConfigAcct?.creator_fee_rate ?? 0)
    const protocolFeeRate = new BN(ammConfigAcct?.protocolFeeRate?.toString?.() ?? ammConfigAcct?.protocol_fee_rate ?? 0)
    const fundFeeRate = new BN(ammConfigAcct?.fundFeeRate?.toString?.() ?? ammConfigAcct?.fund_fee_rate ?? 0)

    const creatorFeeOn = Number(poolStateAcct?.creatorFeeOn ?? poolStateAcct?.creator_fee_on ?? 0)

    return {
      t0: t0!,
      t1: t1!,
      mint0,
      mint1,
      totalVault0,
      totalVault1,
      tradeFeeRate,
      creatorFeeRate,
      protocolFeeRate,
      fundFeeRate,
      creatorFeeOn,
      observationState,
      poolAddr,
      token0Vault,
      token1Vault,
      inputTokenProgram,
      outputTokenProgram,
      inputTokenAccount,
      outputTokenAccount,
      poolStateAcct
    }
  }

  const getDirectionalContext = async (
    ctx: Awaited<ReturnType<typeof loadSwapContext>>,
    ownerPublicKey?: PublicKey,
    direction: SwapDirection = swapDirection,
  ) => {
    const inputIsToken0 = direction === 'token0-to-token1'
    const inputMint = inputIsToken0 ? ctx.t0 : ctx.t1
    const outputMint = inputIsToken0 ? ctx.t1 : ctx.t0
    const inputDecimals = Number(inputIsToken0 ? ctx.mint0.decimals ?? 0 : ctx.mint1.decimals ?? 0)
    const outputDecimals = Number(inputIsToken0 ? ctx.mint1.decimals ?? 0 : ctx.mint0.decimals ?? 0)
    const inputVault = inputIsToken0 ? ctx.token0Vault : ctx.token1Vault
    const outputVault = inputIsToken0 ? ctx.token1Vault : ctx.token0Vault
    const inputTokenProgram = await detectTokenProgram(inputMint)
    const outputTokenProgram = await detectTokenProgram(outputMint)
    const inputTokenAccount = ownerPublicKey ? deriveAta(ownerPublicKey, inputMint, inputTokenProgram) : null
    const outputTokenAccount = ownerPublicKey ? deriveAta(ownerPublicKey, outputMint, outputTokenProgram) : null
    const totalInputAmount = inputIsToken0 ? ctx.totalVault0 : ctx.totalVault1
    const totalOutputAmount = inputIsToken0 ? ctx.totalVault1 : ctx.totalVault0
    const creatorFeeOnInput = ctx.creatorFeeOn === 0 || (ctx.creatorFeeOn === 1 && inputIsToken0) || (ctx.creatorFeeOn === 2 && !inputIsToken0)

    return {
      inputIsToken0,
      inputMint,
      outputMint,
      inputDecimals,
      outputDecimals,
      inputVault,
      outputVault,
      inputTokenProgram,
      outputTokenProgram,
      inputTokenAccount,
      outputTokenAccount,
      totalInputAmount,
      totalOutputAmount,
      creatorFeeOnInput,
    }
  }

  const quoteExactIn = async (humanAmount: string, direction: SwapDirection = swapDirection) => {
    const ctx = await loadSwapContext()
    const resolved = await getDirectionalContext(ctx, undefined, direction)
    const inputBase = parseHumanAmountToBaseUnits(humanAmount, resolved.inputDecimals)
    const inputTransferFee = await computeTransferFeeForPre(connection, resolved.inputMint, inputBase)
    const actualAmountIn = inputBase.sub(inputTransferFee)

    if (actualAmountIn.lte(new BN(0))) {
      throw new Error('Input amount after transfer fee is zero')
    }

    let creatorFee = new BN(0)
    let tradeFee: BN
    let inputAmountLessFees: BN

    if (resolved.creatorFeeOnInput) {
      const totalFee = CpmmFee.tradingFee(actualAmountIn, ctx.tradeFeeRate.add(ctx.creatorFeeRate))
      creatorFee = CpmmFee.splitCreatorFee(totalFee, ctx.tradeFeeRate, ctx.creatorFeeRate)
      tradeFee = totalFee.sub(creatorFee)
      inputAmountLessFees = actualAmountIn.sub(totalFee)
    } else {
      tradeFee = CpmmFee.tradingFee(actualAmountIn, ctx.tradeFeeRate)
      inputAmountLessFees = actualAmountIn.sub(tradeFee)
    }

    const outputAmountSwapped = ConstantProductCurve.swapBaseInputWithoutFees(
      inputAmountLessFees,
      resolved.totalInputAmount,
      resolved.totalOutputAmount,
    )

    let outputAmount = outputAmountSwapped
    if (!resolved.creatorFeeOnInput) {
      const creatorFeeOnOutput = CpmmFee.creatorFee(outputAmountSwapped, ctx.creatorFeeRate)
      creatorFee = creatorFeeOnOutput
      outputAmount = outputAmountSwapped.sub(creatorFeeOnOutput)
    }

    const outputTransferFee = await computeTransferFeeForPre(connection, resolved.outputMint, outputAmount)
    const receiveAmount = outputAmount.sub(outputTransferFee)

    return {
      inputBase,
      actualAmountIn,
      inputAmountLessFees,
      tradeFee,
      creatorFee,
      outputAmount,
      receiveAmount,
      inputTransferFee,
      outputTransferFee,
      inputDecimals: resolved.inputDecimals,
      outputDecimals: resolved.outputDecimals,
    }
  }

  const quoteExactOut = async (humanAmount: string, direction: SwapDirection = swapDirection) => {
    const ctx = await loadSwapContext()
    const resolved = await getDirectionalContext(ctx, undefined, direction)
    const desiredOutputBase = parseHumanAmountToBaseUnits(humanAmount, resolved.outputDecimals)

    const invOut = await computeInverseTransferFee(connection, resolved.outputMint, desiredOutputBase)
    const preTransferOutput = invOut.transferAmount
    const outputTransferFee = invOut.transferFee

    let outputAmountSwapped = preTransferOutput
    let creatorFee = new BN(0)
    if (!resolved.creatorFeeOnInput) {
      outputAmountSwapped = CpmmFee.calculatePreFeeAmount(preTransferOutput, ctx.creatorFeeRate)
      creatorFee = outputAmountSwapped.sub(preTransferOutput)
    }

    if (outputAmountSwapped.gte(resolved.totalOutputAmount)) {
      throw new Error("Insufficient liquidity in pool")
    }

    const inputAmountLessFees = ConstantProductCurve.swapBaseOutputWithoutFees(
      outputAmountSwapped,
      resolved.totalInputAmount,
      resolved.totalOutputAmount,
    )

    let actualAmountIn = new BN(0)
    let tradeFee = new BN(0)
    if (resolved.creatorFeeOnInput) {
      actualAmountIn = CpmmFee.calculatePreFeeAmount(inputAmountLessFees, ctx.tradeFeeRate.add(ctx.creatorFeeRate))
      const totalFee = actualAmountIn.sub(inputAmountLessFees)
      creatorFee = CpmmFee.splitCreatorFee(totalFee, ctx.tradeFeeRate, ctx.creatorFeeRate)
      tradeFee = totalFee.sub(creatorFee)
    } else {
      actualAmountIn = CpmmFee.calculatePreFeeAmount(inputAmountLessFees, ctx.tradeFeeRate)
      tradeFee = actualAmountIn.sub(inputAmountLessFees)
    }

    const invIn = await computeInverseTransferFee(connection, resolved.inputMint, actualAmountIn)

    return {
      desiredOutputBase,
      preTransferOutput,
      outputAmountSwapped,
      inputAmountLessFees,
      actualAmountIn,
      tradeFee,
      creatorFee,
      inputTransferFee: invIn.transferFee,
      maxInputPreFee: invIn.transferAmount,
      outputTransferFee,
      inputDecimals: resolved.inputDecimals,
      outputDecimals: resolved.outputDecimals,
    }
  }

  const loadPrices = async () => {
    if (!activePool?.poolPda || !token0MintParam || !token1MintParam) {
      setPriceDetails(null)
      setPoolReserves(null)
      return
    }

    setPriceLoading(true)
    try {
      const ctx = await loadSwapContext()
      const r0 = formatBaseUnitsToHuman(ctx.totalVault0, ctx.mint0.decimals)
      const r1 = formatBaseUnitsToHuman(ctx.totalVault1, ctx.mint1.decimals)
      setPoolReserves({
        reserve0: r0,
        reserve1: r1
      })

      try {
        const r0Num = Number(r0)
        const r1Num = Number(r1)
        if (r0Num > 0 && r1Num > 0) {
          const p0 = r1Num / r0Num
          const p1 = r0Num / r1Num
          setPriceDetails({
            token0ToToken1: formatAmount(p0),
            token1ToToken0: formatAmount(p1),
          })
        } else {
          setPriceDetails(null)
        }
      } catch (err) {
        console.warn('Failed to calculate price details:', err)
        setPriceDetails(null)
      }
    } catch (err) {
      setPriceDetails(null)
      setPoolReserves(null)
    } finally {
      setPriceLoading(false)
    }
  }

  useEffect(() => {
    loadPrices()
  }, [activePool?.poolPda, token0MintParam, token1MintParam])

  async function handleSwap() {
    if (!program) {
      alert('Program not ready')
      return
    }
    if (!wallet || !wallet.publicKey) {
      alert('Connect wallet to swap')
      return
    }
    if (activeBalanceExceeded) {
      setStatus('Insufficient balance')
      return
    }

    setBusy(true)
    setStatus('Preparing swap transaction...')

    try {
      const ammConfigAccount = ammConfigParam
      if (!ammConfigAccount) {
        throw new Error('Selected pool is missing amm config')
      }
      const [authority] = await getAuthAddress((program as any).programId as PublicKey)
      const payer = wallet.publicKey!
      const ctx = await loadSwapContext(payer)
      const direction = await getDirectionalContext(ctx, payer)
      const inputAtaCtx = await buildEnsureAtaInstruction({
        payer,
        owner: payer,
        mint: direction.inputMint,
        tokenProgram: direction.inputTokenProgram,
      })
      const outputAtaCtx = await buildEnsureAtaInstruction({
        payer,
        owner: payer,
        mint: direction.outputMint,
        tokenProgram: direction.outputTokenProgram,
      })

      const preIxs = [
        ...(inputAtaCtx.instruction ? [inputAtaCtx.instruction] : []),
        ...(outputAtaCtx.instruction ? [outputAtaCtx.instruction] : []),
      ]

      if (lastEditedField === 'input') {
        if (Number(amountIn || '0') <= 0) {
          alert(`Enter valid ${inputTokenLabel} for swap`)
          return
        }

        const quote = await quoteExactIn(amountIn)
        const slippageBps = Math.floor(slippage * 100)
        const minimumAmountOut = quote.receiveAmount.mul(new BN(10000 - slippageBps)).div(new BN(10000))

        setStatus('Sending swap transaction...')
        try {
          const tx = await (program as any).methods
            .swapBaseInput(new anchor.BN(quote.inputBase.toString()), new anchor.BN(minimumAmountOut.toString()))
            .preInstructions(preIxs)
            .accounts({
              payer: wallet.publicKey,
              authority,
              ammConfig: ammConfigAccount,
              poolState: ctx.poolAddr,
              inputTokenAccount: direction.inputTokenAccount,
              outputTokenAccount: direction.outputTokenAccount,
              inputVault: direction.inputVault,
              outputVault: direction.outputVault,
              inputTokenProgram: direction.inputTokenProgram,
              outputTokenProgram: direction.outputTokenProgram,
              inputTokenMint: direction.inputMint,
              outputTokenMint: direction.outputMint,
              observationState: ctx.observationState,
            })
            .rpc()

          setTxResult({ sig: tx, explorer: 'https://explorer.solana.com/tx/' + tx + '?cluster=devnet' })
          logActivity({
            actionType: 'Swap',
            poolAddress: ctx.poolAddr.toBase58(),
            tokenPair: `${inputTokenShort}/${outputTokenShort}`,
            signature: tx,
            status: 'success',
          })

          await connection.confirmTransaction(tx, 'confirmed').catch(() => null)
          // Surgically refresh only this pool's vault balances in the cache
          void refreshPoolCache(dispatch, ctx.poolAddr.toBase58())
          await loadPrices()
          setStatus(null)
          setBusy(false)
          return
        } catch (err: any) {
          if (!isAlreadyProcessedError(err)) {
            console.error('Swap transaction failed:', err)
          }
          logActivity({
            actionType: 'Swap',
            poolAddress: ctx.poolAddr?.toBase58?.(),
            tokenPair: `${inputTokenShort}/${outputTokenShort}`,
            status: 'failed',
          })
          await showSendErrorDetails(err, wallet.publicKey ?? undefined)
          setBusy(false)
        }
      } else {
        if (Number(amountOut || '0') <= 0) {
          alert(`Enter valid ${outputTokenLabel} to receive`)
          return
        }

        const quote = await quoteExactOut(amountOut)
        const slippageBps = Math.floor(slippage * 100)
        const maximumInputPreFee = quote.maxInputPreFee.mul(new BN(10000 + slippageBps)).div(new BN(10000))

        setStatus('Sending swap transaction...')
        try {
          const tx = await (program as any).methods
            .swapBaseOutput(new anchor.BN(maximumInputPreFee.toString()), new anchor.BN(quote.desiredOutputBase.toString()))
            .preInstructions(preIxs)
            .accounts({
              payer: wallet.publicKey,
              authority,
              ammConfig: ammConfigAccount,
              poolState: ctx.poolAddr,
              inputTokenAccount: direction.inputTokenAccount,
              outputTokenAccount: direction.outputTokenAccount,
              inputVault: direction.inputVault,
              outputVault: direction.outputVault,
              inputTokenProgram: direction.inputTokenProgram,
              outputTokenProgram: direction.outputTokenProgram,
              inputTokenMint: direction.inputMint,
              outputTokenMint: direction.outputMint,
              observationState: ctx.observationState,
            })
            .rpc()

          setTxResult({ sig: tx, explorer: 'https://explorer.solana.com/tx/' + tx + '?cluster=devnet' })
          logActivity({
            actionType: 'Swap',
            poolAddress: ctx.poolAddr.toBase58(),
            tokenPair: `${inputTokenShort}/${outputTokenShort}`,
            signature: tx,
            status: 'success',
          })

          await connection.confirmTransaction(tx, 'confirmed').catch(() => null)
          // Surgically refresh only this pool's vault balances in the cache
          void refreshPoolCache(dispatch, ctx.poolAddr.toBase58())
          await loadPrices()
          setStatus(null)
          setBusy(false)
        } catch (err: any) {
          if (!isAlreadyProcessedError(err)) {
            console.error('Swap transaction failed:', err)
          }
          logActivity({
            actionType: 'Swap',
            poolAddress: ctx.poolAddr?.toBase58?.(),
            tokenPair: `${inputTokenShort}/${outputTokenShort}`,
            status: 'failed',
          })
          await showSendErrorDetails(err, wallet.publicKey ?? undefined)
          setBusy(false)
        }
      }
    } catch (err: any) {
      logActivity({
        actionType: 'Swap',
        tokenPair: `${inputTokenShort}/${outputTokenShort}`,
        status: 'failed',
      })
      await showSendErrorDetails(err, wallet.publicKey ?? undefined)
      setBusy(false)
    }
  }

  async function showSendErrorDetails(err: any, hintAddress?: PublicKey) {
    try {
      if (isAlreadyProcessedError(err)) {
        if (hintAddress) {
          try {
            const sigs = await connection.getSignaturesForAddress(hintAddress, { limit: 1 })
            if (sigs && sigs.length > 0) {
              const latestSig = sigs[0].signature
              setTxResult({ sig: latestSig, explorer: 'https://explorer.solana.com/tx/' + latestSig + '?cluster=devnet' })
              setStatus('Transaction executed successfully.')
              setErrorDetails(null)
              return
            }
          } catch (e) { }
        }
        setStatus('Transaction appears already processed; it likely executed successfully.')
        setErrorDetails(null)
        return
      }
    } catch (e) { }
    if (err instanceof SendTransactionError || err?.name === 'SendTransactionError') {
      try {
        const logs = await err.getLogs(connection).catch(() => null)
        if (logs && logs.length) {
          setErrorDetails(logs.join('\n'))
          setStatus('Simulation failed. Click "Details" to view logs.')
          return
        }
        const sig = err?.signature || err?.txSignature || (typeof err.message === 'string' && (err.message.match(/[A-Za-z0-9]{60,88}/)?.[0])) || null
        if (sig) {
          const tx = await (connection as any).getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null)
          const txLogs = (tx as any)?.meta?.logMessages
          if (txLogs && txLogs.length) {
            setErrorDetails(txLogs.join('\n'))
            setStatus('Transaction processed. Click "Details" to view RPC logs.')
            return
          }
        }
        setStatus('Simulation failed: ' + (err.message || String(err)))
      } catch (inner) {
        setStatus('Simulation failed: ' + (err.message || String(err)))
      }
    } else {
      setStatus('Error: ' + (err.message || String(err)))
    }
  }

  const inputBalance = isToken0ToToken1 ? userBalances?.token0 : userBalances?.token1
  const outputBalance = isToken0ToToken1 ? userBalances?.token1 : userBalances?.token0
  const isInputBalanceExceeded = inputBalance != null && Number(amountIn || '0') > parseBalanceValue(inputBalance)
  const activeBalanceExceeded = isInputBalanceExceeded
  const hasValidSwapAmount = Number(amountIn || '0') > 0 || Number(amountOut || '0') > 0
  const colorIn = getTokenColor(inputTokenShort)
  const colorOut = getTokenColor(outputTokenShort)
  const getIconLabel = (symbol: string) => symbol.slice(0, 2).toUpperCase()

  const outputReserve = isToken0ToToken1 ? poolReserves?.reserve1 : poolReserves?.reserve0
  const isLiquidityExceeded = amountOut && outputReserve ? (Number(amountOut) >= Number(outputReserve)) : false
  const canSubmitSwap = !busy && !!wallet.publicKey && hasValidSwapAmount && !activeBalanceExceeded && !isLiquidityExceeded

  const priceToken0 = getShortTokenName(token0Str)
  const priceToken1 = getShortTokenName(token1Str)
  const firstTokenSymbol = showInversePrice ? `${priceToken1}` : `${priceToken0}`
  const secondTokenSymbol = showInversePrice ? `${priceToken0}` : `${priceToken1}`
  const priceValue = showInversePrice ? priceDetails?.token1ToToken0 : priceDetails?.token0ToToken1
  const priceText = priceLoading
    ? 'Loading price...'
    : priceValue
      ? `1 ${firstTokenSymbol} ≈ ${priceValue} ${secondTokenSymbol}`
      : 'Price unavailable'

  const slippageDecimal = slippage / 100
  const estimatedReceived = Number(amountOut || '0')
  const estimatedInput = Number(amountIn || '0')
  const minReceived = estimatedReceived * (1 - slippageDecimal)
  const maxInput = estimatedInput * (1 + slippageDecimal)

  const currentSpotPrice = isToken0ToToken1 
    ? Number(priceDetails?.token1ToToken0 || '0') 
    : Number(priceDetails?.token0ToToken1 || '0')
  
  let priceImpact = 0
  if (estimatedInput > 0 && estimatedReceived > 0 && currentSpotPrice > 0) {
    const executionPrice = estimatedInput / estimatedReceived
    priceImpact = (1 - (currentSpotPrice / executionPrice)) * 100
  }

  const filteredPools = allPools.filter((pool) => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase().trim()
    const name0 = getShortTokenName(pool.token0).toLowerCase()
    const name1 = getShortTokenName(pool.token1).toLowerCase()
    const poolName = `${name0}-${name1}`
    const token0Mint = (pool.token0 || '').toLowerCase()
    const token1Mint = (pool.token1 || '').toLowerCase()
    const poolPda = (pool.poolPda || '').toLowerCase()

    return (
      name0.includes(q) ||
      name1.includes(q) ||
      poolName.includes(q) ||
      token0Mint.includes(q) ||
      token1Mint.includes(q) ||
      poolPda.includes(q)
    )
  })

  return (
    <div className="swap-page">
      <div className="swap-layout">
        <div className="swap-main">
          <button className="swap-page__back" onClick={() => navigate('/liquidity')}>&lt; Back</button>
          <div className="swap-page__content">
            <div className="swap-page__form">
              {txResult && (
                <TransactionCard
                  status="success"
                  title="Swap Successful"
                  message="Your swap transaction has been confirmed"
                  explorerUrl={txResult.explorer}
                  signature={txResult.sig}
                  onClose={() => setTxResult(null)}
                />
              )}

              {status && !txResult && (
                <TransactionCard
                  status={errorDetails ? 'error' : 'info'}
                  title={errorDetails ? 'Transaction Failed' : 'Status'}
                  message={status}
                  details={errorDetails}
                  // No onClose while status is 'info' — card stays until tx settles
                  onClose={errorDetails ? () => {
                    setStatus(null)
                    setErrorDetails(null)
                  } : undefined}
                />
              )}

              <div className="swap-card">
                <div className="swap-header">
                  <div className="swap-title">
                    <h2>Swap</h2>
                    <div className="swap-pool-name-container">
                      <div
                        className="swap-pool-name-hover-wrapper"
                        onMouseEnter={showPoolHover}
                        onMouseLeave={hidePoolHover}
                      >
                        <span className="swap-pool-name-display">
                          {getPoolDisplayName(token0Str, token1Str)}
                        </span>
                        {poolHoverInfo && (
                          <div className="swap-pool-hover-card" onMouseEnter={showPoolHover} onMouseLeave={hidePoolHover}>
                            <div className="swap-hover-row">
                              <span><strong>Pool ID:</strong> {poolHoverInfo.poolId ?? 'unknown'}</span>
                              <button className="swap-copy-btn" onClick={() => copyText(poolHoverInfo.poolId, 'pool')} title="Copy pool id" aria-label="Copy pool id">
                                {copiedKey === 'pool' ? <span className="copy-status-inline">Copied!</span> : <img src={copyIcon} alt="Copy" />}
                              </button>
                            </div>
                            <div className="swap-hover-row">
                              <span><strong>Token0 Mint:</strong> {poolHoverInfo.token0 ?? '-'}</span>
                              <button className="swap-copy-btn" onClick={() => copyText(poolHoverInfo.token0, 'token0')} title="Copy token0" aria-label="Copy token0">
                                {copiedKey === 'token0' ? <span className="copy-status-inline">Copied!</span> : <img src={copyIcon} alt="Copy" />}
                              </button>
                            </div>
                            <div className="swap-hover-row">
                              <span><strong>Token1 Mint:</strong> {poolHoverInfo.token1 ?? '-'}</span>
                              <button className="swap-copy-btn" onClick={() => copyText(poolHoverInfo.token1, 'token1')} title="Copy token1" aria-label="Copy token1">
                                {copiedKey === 'token1' ? <span className="copy-status-inline">Copied!</span> : <img src={copyIcon} alt="Copy" />}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="swap-pool-selector-wrapper">
                  <label className="swap-pool-label">Select Pool:</label>
                  <div className="swap-pool-selector-container">
                    <button
                      className="swap-pool-selector-btn"
                      onClick={() => setShowPoolSelector(!showPoolSelector)}
                    >
                      <span className="swap-pool-selected">{getPoolSelectorLabel()}</span>
                      <span className="swap-pool-selector-arrow">{showPoolSelector ? '▲' : '▼'}</span>
                    </button>

                    {showPoolSelector && (
                      <div className="swap-pool-dropdown">
                        {/* Search Bar */}
                        <div className="swap-pool-search-container">
                          <input
                            type="text"
                            className="swap-pool-search-input"
                            placeholder="Search by token symbol or mint address..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            autoFocus
                          />
                          {searchQuery && (
                            <button type="button" className="swap-pool-search-clear" onClick={() => setSearchQuery('')}>×</button>
                          )}
                        </div>

                        {loadingPools ? (
                          <div className="swap-pool-item swap-pool-empty">Loading pools...</div>
                        ) : poolsError ? (
                          <div className="swap-pool-item swap-pool-empty">
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span>Error loading pools</span>
                              <button className="swap-pool-retry" onClick={() => { void refetchPools() }}>Retry</button>
                            </div>
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--if-text-secondary)' }}>{poolsError}</div>
                          </div>
                        ) : filteredPools.length === 0 ? (
                          <div className="swap-pool-item swap-pool-empty">No pools found</div>
                        ) : (
                          filteredPools.map((pool) => {
                            const name0 = getShortTokenName(pool.token0)
                            const name1 = getShortTokenName(pool.token1)
                            const poolName = `${name0}-${name1}`
                            const feeTier = getFeeTier(pool)
                            const price = pool.price ?? '-'
                            return (
                              <button
                                key={pool.poolPda}
                                className={`swap-pool-item ${selectedPool?.poolPda === pool.poolPda ? 'active' : ''}`}
                                onClick={() => {
                                  setSelectedPool(pool)
                                  setShowPoolSelector(false)
                                  setAmountIn('')
                                  setAmountOut('')
                                }}
                              >
                                <div className="swap-pool-item__info">
                                  <div className="swap-pool-item__name">{poolName}</div>
                                  <div className="swap-pool-item__meta">
                                    {feeTier} • {price} {name0}/{name1}
                                  </div>
                                </div>
                              </button>
                            )
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="swap-body">
                  <div className="swap-panel pool-details-panel">
                    <h3>Pool Details</h3>
                    {activePool ? (
                      <div className="pool-details-content">
                        <div className="pool-details-header">
                          <div className="pool-details-header__badge">
                            {getPoolDisplayName(token0Str, token1Str)}
                          </div>
                          <div className="pool-details-header__fee">
                            {activePoolFeeTier} Fee
                          </div>
                        </div>

                        <div className="pool-details-grid">
                          <div className="pool-details-card">
                            <span className="pool-details-card__label">Current Price</span>
                            <span className="pool-details-card__value">{priceText}</span>
                          </div>

                          <div className="pool-details-card">
                            <span className="pool-details-card__label">Your Balances</span>
                            <div className="pool-details-balances">
                              <div className="pool-balance-row">
                                <span className="pool-balance-token">{getShortTokenName(token0Str)}</span>
                                <span className="pool-balance-amount">{userBalances ? formatAmount(userBalances.token0) : '-'}</span>
                              </div>
                              <div className="pool-balance-row">
                                <span className="pool-balance-token">{getShortTokenName(token1Str)}</span>
                                <span className="pool-balance-amount">{userBalances ? formatAmount(userBalances.token1) : '-'}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="pool-details-empty">Select a pool to view details</div>
                    )}
                  </div>

                  <div className="swap-panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                      <h3 style={{ margin: 0 }}>Swap Amount</h3>
                      <div className="swap-slippage-container">
                        <button 
                          type="button"
                          className="swap-slippage-toggle"
                          onClick={() => setShowSlippageSelector(!showSlippageSelector)}
                          title="Slippage tolerance"
                        >
                          <span>{slippage}%</span>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                        </button>

                        {showSlippageSelector && (
                          <div className="swap-slippage-overlay">
                            <div className="swap-slippage-overlay-title">Max Slippage</div>
                            <div className="swap-slippage-options">
                              {[0.1, 0.5, 1].map((val) => (
                                <button
                                  key={val}
                                  type="button"
                                  className={`swap-slippage-option ${slippage === val ? 'active' : ''}`}
                                  onClick={() => {
                                    setSlippage(val);
                                    setShowSlippageSelector(false);
                                  }}
                                >
                                  {val}%
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <form className="swap-form" onSubmit={onSubmit}>
                      {/* From Card */}
                      <div className={`swap-input-card ${lastEditedField === 'input' && isInputBalanceExceeded ? 'swap-input-card--invalid' : ''}`}>
                        <div className="swap-input-card-header">
                          <span className="swap-input-card-label">From</span>
                          <div className="swap-input-card-balance-wrap">
                            <img src={walletIcon} alt="Wallet" className="wallet-mini-icon" />
                            <span className="swap-input-card-balance-val" style={{ color: isInputBalanceExceeded ? '#ff4d4f' : undefined }}>{inputBalance ?? '0'}</span>
                            <>
                              <button
                                type="button"
                                className="swap-input-card-btn"
                                onClick={() => {
                                  const val = parseBalanceValue(inputBalance)
                                  updateInputAmount(val > 0 ? val.toString() : '0')
                                }}
                              >
                                Max
                              </button>
                              <button
                                type="button"
                                className="swap-input-card-btn"
                                onClick={() => {
                                  const val = parseBalanceValue(inputBalance)
                                  updateInputAmount(val > 0 ? (val / 2).toString() : '0')
                                }}
                              >
                                50%
                              </button>
                            </>
                          </div>
                        </div>

                        <div className="swap-input-card-row">
                          <div className="swap-token-select-pill" onClick={() => {
                            setShowPoolSelector((prev) => {
                              if (!prev) {
                                setSearchQuery(inputTokenShort)
                                return true
                              }
                              return false
                            })
                          }}>
                            <div className="swap-token-logo-sphere" style={{ backgroundColor: colorIn }}>
                              {getIconLabel(inputTokenShort)}
                            </div>
                            <span className="swap-token-symbol">{inputTokenShort}</span>
                            <span className="swap-token-chevron">▼</span>
                          </div>

                          <div className="swap-input-amount-wrap">
                            <input
                              type="text"
                              className="swap-input-field-borderless"
                              value={amountIn}
                              onChange={(e) => updateInputAmount(e.target.value)}
                              placeholder="0"
                            />
                            <span className="swap-input-fiat-value">~$0</span>
                          </div>
                        </div>
                      </div>

                      {/* Direction Switch Toggle */}
                      <div className="swap-direction-toggle">
                        <button
                          type="button"
                          className="swap-direction-toggle__btn"
                          onClick={toggleSwapDirection}
                          aria-label="Swap token direction"
                          title="Swap direction"
                        >
                          <img src={straightArrowIcon} alt="arrow" className="swap-direction-toggle__arrow" />
                          <img src={swapIcon} alt="swap" className="swap-direction-toggle__swap" />
                        </button>
                      </div>

                      {/* To Card */}
                      <div className={`swap-input-card`}>
                        <div className="swap-input-card-header">
                          <span className="swap-input-card-label">To</span>
                          <div className="swap-input-card-balance-wrap">
                            <img src={walletIcon} alt="Wallet" className="wallet-mini-icon" />
                            <span className="swap-input-card-balance-val">{outputBalance ?? '0'}</span>
                            <>
                              <button
                                type="button"
                                className="swap-input-card-btn"
                                onClick={() => {
                                  const val = parseBalanceValue(outputBalance)
                                  updateOutputAmount(val > 0 ? val.toString() : '0')
                                }}
                              >
                                Max
                              </button>
                              <button
                                type="button"
                                className="swap-input-card-btn"
                                onClick={() => {
                                  const val = parseBalanceValue(outputBalance)
                                  updateOutputAmount(val > 0 ? (val / 2).toString() : '0')
                                }}
                              >
                                50%
                              </button>
                            </>
                          </div>
                        </div>

                        <div className="swap-input-card-row">
                          <div className="swap-token-select-pill" onClick={() => {
                            setShowPoolSelector((prev) => {
                              if (!prev) {
                                setSearchQuery(outputTokenShort)
                                return true
                              }
                              return false
                            })
                          }}>
                            <div className="swap-token-logo-sphere" style={{ backgroundColor: colorOut }}>
                              {getIconLabel(outputTokenShort)}
                            </div>
                            <span className="swap-token-symbol">{outputTokenShort}</span>
                            <span className="swap-token-chevron">▼</span>
                          </div>

                          <div className="swap-input-amount-wrap">
                            <input
                              type="text"
                              className="swap-input-field-borderless"
                              value={amountOut}
                              onChange={(e) => updateOutputAmount(e.target.value)}
                              placeholder="0"
                            />
                            <span className="swap-input-fiat-value">~$0</span>
                          </div>
                        </div>
                      </div>

                      {/* Price box / strip info */}
                      <div className="swap-price-box">
                        <div className="swap-price-strip">
                          <div className="swap-price-strip__value">
                            <span className="swap-price-strip__text">{priceText}</span>
                          </div>
                          <div className="swap-price-strip__toggle">
                            <button
                              type="button"
                              className="swap-price-strip__btn"
                              onClick={() => setShowInversePrice((current) => !current)}
                              aria-label={showInversePrice ? 'Show token0 to token1 price' : 'Show token1 to token0 price'}
                            >
                              <img src={swapIcon} alt="toggle price" className="swap-price-strip__icon" />
                            </button>
                          </div>
                        </div>

                        <div className="swap-quote-mode swap-quote-mode--editing">
                          {lastEditedField === 'input'
                            ? `Editing ${inputQuoteLabel} quotes the minimum ${outputQuoteLabel} you will receive.`
                            : `Editing ${outputQuoteLabel} quotes the maximum ${inputQuoteLabel} input required.`}
                        </div>
                      </div>

                      {hasValidSwapAmount && showSwapDetails && (
                        <div style={{ marginBottom: '16px', padding: '16px', background: 'var(--if-background-surface, rgba(15, 25, 41, 0.45))', borderRadius: '12px', fontSize: '13px', color: 'var(--if-text-secondary, #718096)', display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid rgba(30, 45, 69, 0.7)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Price Impact</span>
                            <span style={{ color: priceImpact > 5 ? '#ff4d4f' : 'inherit' }}>
                              {priceImpact === 0 ? '-' : priceImpact < 0.01 ? '<0.01%' : `${priceImpact.toFixed(2)}%`}
                            </span>
                          </div>
                          {lastEditedField === 'input' ? (
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span>Minimum Received</span>
                              <span>{minReceived.toFixed(6)} {outputTokenShort}</span>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span>Maximum Input</span>
                              <span>{maxInput.toFixed(6)} {inputTokenShort}</span>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="swap-actions-row">
                        <button type="submit" className="swap-btn-full" disabled={!canSubmitSwap}>
                          {busy ? 'Swapping...' : !wallet.publicKey ? 'Connect Wallet' : activeBalanceExceeded ? 'Insufficient Balance' : isLiquidityExceeded ? 'Insufficient Liquidity' : 'Swap'}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showWalletConnectedToast && wallet.publicKey && (
        <div className="wallet-connected-toast-wrapper">
          <TransactionCard
            status="success"
            title="Wallet Connected"
            message={`Successfully connected to ${shorten(wallet.publicKey.toBase58())}`}
            onClose={() => setShowWalletConnectedToast(false)}
          />
        </div>
      )}
    </div>
  )
}
