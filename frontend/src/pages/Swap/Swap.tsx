import { useMemo, useRef, useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './Swap.css'
import useProgram from '../../utils/useProgram'
import { PublicKey, SendTransactionError } from '@solana/web3.js'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import * as anchor from '@coral-xyz/anchor'
import { getAuthAddress, getPoolAddress, getPoolVaultAddress, getOrcleAccountAddress } from '../../utils/pda'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAccount,
} from '@solana/spl-token'
import viewIcon from '../../assets/view.svg'
import copyIcon from '../../assets/copy.svg'
import showPriceIcon from '../../assets/show-price.svg'
import BN from 'bn.js'
import { computeTransferFeeForPre, computeInverseTransferFee, CpmmFee } from '../../utils/curve/fee'
import { CurveCalculator } from '../../utils/curve/calculator'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import idlJson from '../../../idl/raydium_cp_swap.json'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')

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

const POOLS_CACHE: Map<string, { ts: number; pools: any[] }> = new Map()
const POOLS_PROMISE: Map<string, Promise<any>> = new Map()

type PoolData = {
  poolPda: string
  token0: string | null
  token1: string | null
  ammConfig: string | null
  raw: any
}

export default function Swap() {
  const location = useLocation()
  const navigate = useNavigate()
  const rawState = (location.state as any) || {}
  const poolFromRoute = rawState?.poolPda ? (rawState as Pool) : null
  const program = useProgram()
  const wallet = useWallet()
  const { connection } = useConnection()

  const [allPools, setAllPools] = useState<PoolData[]>([])
  const [loadingPools, setLoadingPools] = useState(false)
  const [poolsError, setPoolsError] = useState<string | null>(null)
  const [selectedPool, setSelectedPool] = useState<PoolData | null>(null)
  const [showPoolSelector, setShowPoolSelector] = useState(false)
  const [poolsReloadKey, setPoolsReloadKey] = useState(0)

  const detectTokenProgram = async (mint: PublicKey) => {
    const info = await connection.getAccountInfo(mint)
    if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`)
    if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
    return TOKEN_PROGRAM_ID
  }

  const ensureAssociatedTokenAccount = async (payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram)
    const info = await connection.getAccountInfo(ata)
    if (info) return ata

    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ata,
        owner,
        mint,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
    const latest = await connection.getLatestBlockhash('confirmed')
    tx.feePayer = payer
    tx.recentBlockhash = latest.blockhash
    await wallet.sendTransaction(tx, connection)
    return ata
  }

  useEffect(() => {
    let mounted = true

    async function loadPoolsWithRetry() {
      setLoadingPools(true)
      setPoolsError(null)
      const maxAttempts = 5
      let attempt = 0
      let lastErr: any = null

      const endpoint = (connection as any)?.rpcEndpoint || (connection as any)?._rpcEndpoint || ''
      const cacheEntry = POOLS_CACHE.get(endpoint)
      const cacheTtl = 60 * 1000
      if (cacheEntry && Date.now() - cacheEntry.ts < cacheTtl) {
        if (mounted) {
          setAllPools(cacheEntry.pools)
          setLoadingPools(false)
        }
        return
      }

      if (POOLS_PROMISE.has(endpoint)) {
        try {
          const res = await POOLS_PROMISE.get(endpoint)
          if (mounted) {
            setAllPools(res)
            setLoadingPools(false)
          }
          return
        } catch (e) {
        }
      }

      while (attempt < maxAttempts && mounted) {
        attempt++
        try {
          const work = (async () => {
            let accounts: Array<any> = []
            if (program) {
              const all = await (program.account as any).poolState.all()
              accounts = all.map((a: any) => ({ pubkey: a.publicKey, account: a.account }))
            } else {
              const raw = await connection.getProgramAccounts(PROGRAM_ID)
              const coder = new anchor.BorshAccountsCoder(idlJson as any)
              accounts = []
              for (const r of raw) {
                let decoded: any = null
                try {
                  const data = r.account.data as any
                  let buf: Buffer

                  if (Buffer.isBuffer(data)) {
                    buf = data
                  } else if (data instanceof Uint8Array) {
                    buf = Buffer.from(data)
                  } else if (typeof data === 'string') {
                    buf = Buffer.from(data, 'base64')
                  } else if (Array.isArray(data) && (data as any).length > 0) {
                    buf = Buffer.from((data as any)[0], 'base64')
                  } else {
                    continue
                  }

                  try { decoded = coder.decode('poolState', buf) } catch (e1) {
                    try { decoded = coder.decode('pool_state', buf) } catch (e2) {
                      try { decoded = coder.decode('PoolState', buf) } catch (e3) { decoded = null }
                    }
                  }

                  if (decoded) {
                    accounts.push({ pubkey: r.pubkey, account: decoded })
                  }
                } catch (err: any) { }
              }
            }

            const toPubString = (v: any) => {
              if (!v) return null
              if (typeof v === 'string') return v
              if (v?.toBase58) return v.toBase58()
              try { return String(v) } catch { return null }
            }

            const mapped: PoolData[] = []
            for (const a of accounts) {
              try {
                const acc = a.account
                const poolPda = a.pubkey ? (a.pubkey.toBase58 ? a.pubkey.toBase58() : String(a.pubkey)) : null

                if (!poolPda) continue

                const token0 = toPubString(
                  acc.token_0_mint ?? acc.token0Mint ?? acc.mint_0 ?? acc.mint0 ??
                  acc.mint_0_mint ?? acc.mint_0_pubkey ?? acc.token0_mint ?? acc.tokenMint0 ??
                  acc.mintA ?? acc.mint_a
                )
                const token1 = toPubString(
                  acc.token_1_mint ?? acc.token1Mint ?? acc.mint_1 ?? acc.mint1 ??
                  acc.mint_1_mint ?? acc.mint_1_pubkey ?? acc.token1_mint ?? acc.tokenMint1 ??
                  acc.mintB ?? acc.mint_b
                )
                const ammConfig = toPubString(
                  acc.amm_config ?? acc.ammConfig ?? acc.amm_config_key ?? acc.ammConfigKey ?? acc.amm
                )

                mapped.push({
                  poolPda,
                  token0,
                  token1,
                  ammConfig,
                  raw: acc,
                })
              } catch (err) {
                // skip invalid pools
              }
            }

            try { POOLS_CACHE.set(endpoint, { ts: Date.now(), pools: mapped }) } catch (e) { }
            return mapped
          })()
          POOLS_PROMISE.set(endpoint, work)
          const mapped = await work
          POOLS_PROMISE.delete(endpoint)

          if (mounted) {
            setAllPools(mapped)
          }
          lastErr = null
          break
        } catch (err: any) {
          lastErr = err
          console.error('Error loading pools (attempt', attempt, '):', err)
          const msg = (err?.message || String(err) || '').toLowerCase()
          if (msg.includes('429') || msg.includes('too many requests')) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000) + Math.round(Math.random() * 300)
            await sleep(backoff)
            continue
          }
          break
        }
      }

      if (mounted) {
        if (lastErr) setPoolsError(lastErr?.message || String(lastErr))
        setLoadingPools(false)
      }
    }

    loadPoolsWithRetry()
    return () => { mounted = false }
  }, [program, connection, poolFromRoute, poolsReloadKey])

  const activePool = selectedPool || poolFromRoute

  const poolPdaParam = useMemo(() => {
    if (!activePool?.poolPda) return undefined
    try {
      return new PublicKey(activePool.poolPda)
    } catch (e) {
      return undefined
    }
  }, [activePool?.poolPda])

  const token0MintParam = useMemo(() => {
    if (!activePool?.token0) return undefined
    try {
      return new PublicKey(activePool.token0)
    } catch (e) {
      return undefined
    }
  }, [activePool?.token0])

  const token1MintParam = useMemo(() => {
    if (!activePool?.token1) return undefined
    try {
      return new PublicKey(activePool.token1)
    } catch (e) {
      return undefined
    }
  }, [activePool?.token1])

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
  const [lastEditedField, setLastEditedField] = useState<'token0' | 'token1'>('token0')
  const [hoverInfo, setHoverInfo] = useState<{ label: string; value: string } | null>(null)
  const hoverTimeout = useRef<number | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInversePrice, setShowInversePrice] = useState(false)
  const [priceDetails, setPriceDetails] = useState<{ token0ToToken1: string; token1ToToken0: string } | null>(null)
  const [priceLoading, setPriceLoading] = useState(false)

  const numeric = (s: string) => Number(s || 0)

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
  const ammConfigStr = activePool?.ammConfig

  const getPoolLabel = () => {
    if (!activePool) return 'Select Pool'
    if (token0Str && token1Str) {
      return `${shorten(token0Str)} / ${shorten(token1Str)}`
    }
    return poolIdStr ? shorten(poolIdStr) : 'Select Pool'
  }



  const getPoolSelectorLabel = () => {
    if (loadingPools) return 'Loading pools...'
    return getPoolLabel()
  }

  const clearHoverTimeout = () => {
    if (hoverTimeout.current != null) {
      clearTimeout(hoverTimeout.current)
      hoverTimeout.current = null
    }
  }

  const showHover = (label: string, value?: string | null) => {
    if (!value) return
    clearHoverTimeout()
    setHoverInfo({ label, value })
  }

  const hideHover = () => {
    clearHoverTimeout()
    hoverTimeout.current = window.setTimeout(() => setHoverInfo(null), 150)
  }

  const copyText = async (value?: string | null) => {
    if (!value) return
    try { await navigator.clipboard.writeText(value) } catch (e) { }
  }

  const renderHoverCard = (label: string, value?: string | null) => {
    if (!value || hoverInfo?.label !== label) return null
    return (
      <div className="swap-hover-card" onMouseEnter={clearHoverTimeout} onMouseLeave={hideHover}>
        <div className="swap-hover-row">
          <span><strong>{label}:</strong> {value}</span>
          <button className="swap-copy-btn" onClick={() => copyText(value)} title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`}>
            <img src={copyIcon} alt="Copy" />
          </button>
        </div>
      </div>
    )
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleSwap()
  }

  const loadSwapContext = async (ownerPublicKey?: PublicKey) => {
    if (!program) throw new Error('Program not ready')
    const programId = (program as any).programId as PublicKey
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
    const inputTokenAccount = ownerPublicKey ? getAssociatedTokenAddressSync(t0!, ownerPublicKey, false, inputTokenProgram) : null
    const outputTokenAccount = ownerPublicKey ? getAssociatedTokenAddressSync(t1!, ownerPublicKey, false, outputTokenProgram) : null

    const mint0 = await getMint((program.provider as any).connection, t0!)
    const mint1 = await getMint((program.provider as any).connection, t1!)
    const vault0Acct = await getAccount((program.provider as any).connection, token0Vault)
    const vault1Acct = await getAccount((program.provider as any).connection, token1Vault)
    const poolStateAcct: any = await (program.account as any).poolState.fetch(poolAddr)

    const poolVault0Amount = new BN(vault0Acct.amount.toString())
    const poolVault1Amount = new BN(vault1Acct.amount.toString())

    const proto0 = new BN(poolStateAcct.protocolFeesToken0?.toString?.() ?? poolStateAcct.protocolFeesToken0 ?? 0)
    const fund0 = new BN(poolStateAcct.fundFeesToken0?.toString?.() ?? poolStateAcct.fundFeesToken0 ?? 0)
    const creator0 = new BN(poolStateAcct.creatorFeesToken0?.toString?.() ?? poolStateAcct.creatorFeesToken0 ?? 0)
    const feesToken0 = proto0.add(fund0).add(creator0)

    const proto1 = new BN(poolStateAcct.protocolFeesToken1?.toString?.() ?? poolStateAcct.protocolFeesToken1 ?? 0)
    const fund1 = new BN(poolStateAcct.fundFeesToken1?.toString?.() ?? poolStateAcct.fundFeesToken1 ?? 0)
    const creator1 = new BN(poolStateAcct.creatorFeesToken1?.toString?.() ?? poolStateAcct.creatorFeesToken1 ?? 0)
    const feesToken1 = proto1.add(fund1).add(creator1)

    const totalVault0 = poolVault0Amount.sub(feesToken0)
    const totalVault1 = poolVault1Amount.sub(feesToken1)

    const ammConfigAcct: any = await (program.account as any).ammConfig.fetch(ammConfigParam as PublicKey)
    const tradeFeeRate = new BN(ammConfigAcct.tradeFeeRate?.toString?.() ?? ammConfigAcct.trade_fee_rate ?? 0)
    const creatorFeeRate = new BN(ammConfigAcct.creatorFeeRate?.toString?.() ?? ammConfigAcct.creator_fee_rate ?? 0)
    const protocolFeeRate = new BN(ammConfigAcct.protocolFeeRate?.toString?.() ?? ammConfigAcct.protocol_fee_rate ?? 0)
    const fundFeeRate = new BN(ammConfigAcct.fundFeeRate?.toString?.() ?? ammConfigAcct.fund_fee_rate ?? 0)

    const creatorFeeOn = Number(poolStateAcct.creatorFeeOn ?? poolStateAcct.creator_fee_on ?? 0)

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

  const swapToken0ForToken1 = async (inputToken0Human: string) => {
    const ctx = await loadSwapContext()
    const inputToken0Base = parseHumanAmountToBaseUnits(inputToken0Human, Number(ctx.mint0.decimals ?? 0))

    const fee0bn = await computeTransferFeeForPre(((program as any).provider as any).connection, ctx.t0, inputToken0Base)
    const postToken0 = inputToken0Base.sub(fee0bn)

    const isCreatorFeeOnInput = ctx.creatorFeeOn === 0 || (ctx.creatorFeeOn === 1 && true)

    const result = CurveCalculator.swapBaseInput(
      postToken0,
      ctx.totalVault0,
      ctx.totalVault1,
      ctx.tradeFeeRate,
      ctx.creatorFeeRate,
      ctx.protocolFeeRate,
      ctx.fundFeeRate,
      isCreatorFeeOnInput
    )

    const outputTransferFee = await computeTransferFeeForPre(((program as any).provider as any).connection, ctx.t1, result.outputAmount)
    const receiveAmount = result.outputAmount.sub(outputTransferFee)
    const outputToken1Human = (Number(receiveAmount.toString()) / Math.pow(10, Number(ctx.mint1.decimals ?? 0))).toString()
    return outputToken1Human
  }

  const quoteToken0ForToken1ExactOut = async (desiredToken1Human: string) => {
    const ctx = await loadSwapContext()
    const desiredToken1Base = parseHumanAmountToBaseUnits(desiredToken1Human, Number(ctx.mint1.decimals ?? 0))

    const invOut = await computeInverseTransferFee(((program as any).provider as any).connection, ctx.t1, desiredToken1Base)
    const preTransferOutput = invOut.transferAmount

    const isCreatorFeeOnInput = ctx.creatorFeeOn === 0 || ctx.creatorFeeOn === 1

    let outputAmountSwapped = preTransferOutput
    if (!isCreatorFeeOnInput) {
      outputAmountSwapped = CpmmFee.calculatePreFeeAmount(preTransferOutput, ctx.creatorFeeRate)
    }

    const inputAmountLessFees = ConstantProductCurve.swapBaseOutputWithoutFees(
      outputAmountSwapped,
      ctx.totalVault0,
      ctx.totalVault1,
    )

    let actualAmountIn: BN
    if (isCreatorFeeOnInput) {
      actualAmountIn = CpmmFee.calculatePreFeeAmount(inputAmountLessFees, ctx.tradeFeeRate.add(ctx.creatorFeeRate))
    } else {
      actualAmountIn = CpmmFee.calculatePreFeeAmount(inputAmountLessFees, ctx.tradeFeeRate)
    }

    const invIn = await computeInverseTransferFee(((program as any).provider as any).connection, ctx.t0, actualAmountIn)
    return (Number(invIn.transferAmount.toString()) / Math.pow(10, Number(ctx.mint0.decimals ?? 0))).toString()
  }

  const loadPrices = async () => {
    if (!activePool?.poolPda || !token0MintParam || !token1MintParam) {
      setPriceDetails(null)
      return
    }

    setPriceLoading(true)
    try {
      const token0ToToken1 = await swapToken0ForToken1('1')
      const token1ToToken0 = await quoteToken0ForToken1ExactOut('1')
      setPriceDetails({ token0ToToken1, token1ToToken0 })
    } catch (err) {
      setPriceDetails(null)
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
      await ensureAssociatedTokenAccount(payer, payer, ctx.t0, ctx.inputTokenProgram)
      await ensureAssociatedTokenAccount(payer, payer, ctx.t1, ctx.outputTokenProgram)


      if (lastEditedField === 'token0') {
        const inputToken0Human = Number(amountIn || '0')
        if (inputToken0Human <= 0) {
          alert('Enter valid Token0 amount for swap')
          return
        }

        const inputToken0Base = parseHumanAmountToBaseUnits(amountIn, Number(ctx.mint0.decimals ?? 0))
        const uiExpectedOutBase = parseHumanAmountToBaseUnits(amountOut, Number(ctx.mint1.decimals ?? 0))
        const minOutToken1 = uiExpectedOutBase.mul(new BN(99)).div(new BN(100))

        try {
          const tx = await (program as any).methods
            .swapBaseInput(new anchor.BN(inputToken0Base.toString()), new anchor.BN(minOutToken1.toString()))
            .accounts({
              payer: wallet.publicKey,
              authority,
              ammConfig: ammConfigAccount,
              poolState: ctx.poolAddr,
              inputTokenAccount: ctx.inputTokenAccount,
              outputTokenAccount: ctx.outputTokenAccount,
              inputVault: ctx.token0Vault,
              outputVault: ctx.token1Vault,
              inputTokenProgram: ctx.inputTokenProgram,
              outputTokenProgram: ctx.outputTokenProgram,
              inputTokenMint: ctx.t0,
              outputTokenMint: ctx.t1,
              observationState: ctx.observationState,
            })
            .rpc()

          setTxResult({ sig: tx, explorer: 'https://explorer.solana.com/tx/' + tx + '?cluster=devnet' })

          await connection.confirmTransaction(tx, 'confirmed').catch(() => null)
          await loadPrices()
          setStatus(null)
          setBusy(false)
        } catch (err: any) {
          if (!isAlreadyProcessedError(err)) {
            console.error('Swap transaction failed:', err)
          }
          await showSendErrorDetails(err, wallet.publicKey ?? undefined)
          setBusy(false)
        }
      } else {
        const desiredToken1Human = Number(amountOut || '0')
        if (desiredToken1Human <= 0) {
          alert('Enter valid Token1 amount to receive')
          return
        }

        const desiredToken1Base = parseHumanAmountToBaseUnits(amountOut, Number(ctx.mint1.decimals ?? 0))      
        const uiExpectedInBase = parseHumanAmountToBaseUnits(amountIn, Number(ctx.mint0.decimals ?? 0))
        const maxInputPreFee = uiExpectedInBase.mul(new BN(101)).div(new BN(100))

        try {
          const tx = await (program as any).methods
            .swapBaseOutput(new anchor.BN(maxInputPreFee.toString()), new anchor.BN(desiredToken1Base.toString()))
            .accounts({
              payer: wallet.publicKey,
              authority,
              ammConfig: ammConfigAccount,
              poolState: ctx.poolAddr,
              inputTokenAccount: ctx.inputTokenAccount,
              outputTokenAccount: ctx.outputTokenAccount,
              inputVault: ctx.token0Vault,
              outputVault: ctx.token1Vault,
              inputTokenProgram: ctx.inputTokenProgram,
              outputTokenProgram: ctx.outputTokenProgram,
              inputTokenMint: ctx.t0,
              outputTokenMint: ctx.t1,
              observationState: ctx.observationState,
            })
            .rpc()

          setTxResult({ sig: tx, explorer: 'https://explorer.solana.com/tx/' + tx + '?cluster=devnet' })

          await connection.confirmTransaction(tx, 'confirmed').catch(() => null)
          await loadPrices()
          setStatus(null)
          setBusy(false)
        } catch (err: any) {
          if (!isAlreadyProcessedError(err)) {
          }
          await showSendErrorDetails(err, wallet.publicKey ?? undefined)
          setBusy(false)
        }
      }
    } catch (err: any) {
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
                  onClose={() => {
                    setStatus(null)
                    setErrorDetails(null)
                  }}
                />
              )}

              <div className="swap-card">
                <div className="swap-header">
                  <div className="swap-title">
                    <h2>Swap</h2>
                    <div className="swap-subtitle">Pool id: {shorten(poolIdStr)}</div>
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
                        {loadingPools ? (
                          <div className="swap-pool-item swap-pool-empty">Loading pools...</div>
                        ) : poolsError ? (
                          <div className="swap-pool-item swap-pool-empty">
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span>Error loading pools</span>
                              <button className="swap-pool-retry" onClick={() => { setPoolsError(null); setPoolsReloadKey((k) => k + 1) }}>Retry</button>
                            </div>
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--if-text-secondary)' }}>{poolsError}</div>
                          </div>
                        ) : allPools.length === 0 ? (
                          <div className="swap-pool-item swap-pool-empty">No pools found</div>
                        ) : (
                          allPools.map((pool) => (
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
                              <span className="swap-pool-pair">
                                {pool.token0 && pool.token1 ? `${shorten(pool.token0)} / ${shorten(pool.token1)}` : shorten(pool.poolPda)}
                              </span>
                              <span className="swap-pool-id">{shorten(pool.poolPda)}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="swap-body">
                  <div className="swap-panel">
                    <h3>Swap Details</h3>
                    <div className="address-row">
                      <span>Pool id</span>
                      <span className="address-value">{shorten(poolIdStr)}</span>
                      <div className="swap-hover-wrapper" onMouseEnter={() => showHover('Pool id', poolIdStr)} onMouseLeave={hideHover}>
                        <button
                          className="view-btn"
                          disabled={!poolIdStr}
                          aria-label="View pool id"
                        >
                          <img src={viewIcon} alt="View" />
                        </button>
                        {renderHoverCard('Pool id', poolIdStr)}
                      </div>
                    </div>
                    <div className="address-row">
                      <span>Amm config</span>
                      <span className="address-value">{shorten(ammConfigStr)}</span>
                      <div className="swap-hover-wrapper" onMouseEnter={() => showHover('Amm config', ammConfigStr)} onMouseLeave={hideHover}>
                        <button
                          className="view-btn"
                          disabled={!ammConfigStr}
                          aria-label="View amm config"
                        >
                          <img src={viewIcon} alt="View" />
                        </button>
                        {renderHoverCard('Amm config', ammConfigStr)}
                      </div>
                    </div>
                    <div className="address-row">
                      <span>Token0 address</span>
                      <span className="address-value">{shorten(token0Str)}</span>
                      <div className="swap-hover-wrapper" onMouseEnter={() => showHover('Token0 address', token0Str)} onMouseLeave={hideHover}>
                        <button
                          className="view-btn"
                          disabled={!token0Str}
                          aria-label="View token0"
                        >
                          <img src={viewIcon} alt="View" />
                        </button>
                        {renderHoverCard('Token0 address', token0Str)}
                      </div>
                    </div>
                    <div className="address-row">
                      <span>Token1 address</span>
                      <span className="address-value">{shorten(token1Str)}</span>
                      <div className="swap-hover-wrapper" onMouseEnter={() => showHover('Token1 address', token1Str)} onMouseLeave={hideHover}>
                        <button
                          className="view-btn"
                          disabled={!token1Str}
                          aria-label="View token1"
                        >
                          <img src={viewIcon} alt="View" />
                        </button>
                        {renderHoverCard('Token1 address', token1Str)}
                      </div>
                    </div>
                  </div>

                  <div className="swap-panel">
                    <h3>Swap Amount</h3>
                    <form className="swap-form" onSubmit={onSubmit}>
                      <div className="token-row">
                        <div className="token-info">
                          <span className="token-label">Token0 amount</span>
                          <div className="token-address">
                            <span>{shorten(token0Str)}</span>
                          </div>
                        </div>
                        <input
                          className="swap-input"
                          value={amountIn}
                          onChange={async (e) => {
                            setLastEditedField('token0')
                            const next = e.target.value
                            setAmountIn(next)
                            if (!next || Number(next) <= 0) {
                              setAmountOut('')
                              return
                            }
                            try {
                              setAmountOut(await swapToken0ForToken1(next))
                            } catch (err) {
                              setAmountOut('')
                            }
                          }}
                          placeholder="0.0"
                        />
                      </div>

                      <div className="token-row">
                        <div className="token-info">
                          <span className="token-label">Token1 amount</span>
                          <div className="token-address">
                            <span>{shorten(token1Str)}</span>
                          </div>
                        </div>
                        <input
                          className="swap-input"
                          value={amountOut}
                          onChange={async (e) => {
                            setLastEditedField('token1')
                            const next = e.target.value
                            setAmountOut(next)
                            if (!next || Number(next) <= 0) {
                              setAmountIn('')
                              return
                            }
                            try {
                              setAmountIn(await quoteToken0ForToken1ExactOut(next))
                            } catch (err) {
                              setAmountIn('')
                            }
                          }}
                          placeholder="0.0"
                        />
                      </div>

                      <div className="swap-price-box">
                        <div className="swap-price-strip">
                          <div className="swap-price-strip__value">
                            {priceLoading ? (
                              <span className="swap-price-strip__text">Loading price...</span>
                            ) : priceDetails ? (
                              showInversePrice ? (
                                <span className="swap-price-strip__text">
                                  1 Token1 ≈ {priceDetails.token1ToToken0} Token0
                                </span>
                              ) : (
                                <span className="swap-price-strip__text">
                                  1 Token0 ≈ {priceDetails.token0ToToken1} Token1
                                </span>
                              )
                            ) : (
                              <span className="swap-price-strip__text">Price unavailable</span>
                            )}
                            <span className="swap-price-strip__suffix">
                              {showInversePrice ? 'token0/token1' : 'token1/token0'}
                            </span>
                          </div>
                          <div className="swap-price-strip__toggle">
                            <button
                              type="button"
                              className="swap-price-strip__btn"
                              onClick={() => setShowInversePrice((current) => !current)}
                              aria-label={showInversePrice ? 'Show token0 to token1 price' : 'Show token1 to token0 price'}
                            >
                              <img src={showPriceIcon} alt="toggle price" className="swap-price-strip__icon" />
                            </button>
                            <span className="swap-price-strip__label">
                              {showInversePrice ? 'Show token0/token1' : 'Show token1/token0'}
                            </span>
                          </div>
                        </div>

                        <div className="swap-quote-mode swap-quote-mode--editing">
                          {lastEditedField === 'token0'
                            ? 'Editing Token0 quotes the minimum Token1 you will receive.'
                            : 'Editing Token1 quotes the maximum Token0 input required.'}
                        </div>
                      </div>

                      <div className="swap-actions-row">
                        <button type="submit" className="btn primary" disabled={busy || !(numeric(lastEditedField === 'token0' ? amountIn : amountOut) > 0) || !wallet.publicKey}>
                          Swap
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
    </div>
  )
}