import { useMemo, useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './DepositForm.css'
import useProgram from '../../utils/useProgram'
import usePool from '../../hooks/usePool'
import useTokenProgramAta from '../../hooks/useTokenProgramAta'
import { PublicKey, SendTransactionError } from '@solana/web3.js'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import * as anchor from '@coral-xyz/anchor'
import { getAuthAddress, getPoolAddress, getPoolLpMintAddress, getPoolVaultAddress } from '../../utils/pda'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getAccount } from '@solana/spl-token'
import copyIcon from '../../assets/copy.svg'
import walletIcon from '../../assets/wallet.svg'
import plusIcon from '../../assets/plus-circle.svg'
import BN from 'bn.js'
import { computeTransferFeeForPre, computeInverseTransferFee } from '../../utils/curve/fee'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import { RoundDirection } from '../../utils/curve/calculator'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import { getShortTokenName, getPoolDisplayName } from '../../utils/token'
import { formatAmount } from '../../utils/format'
import idlJson from '../../../idl/raydium_cp_swap.json'
import { logActivity } from '../../utils/activity'
import { useDispatch } from 'react-redux'
import { solanaApi } from '../../store/solanaApi'

type Pool = {
  name?: string
  fee?: string
  poolPda?: string
  ammConfig?: string
  token0?: string
  token1?: string
  token0Mint?: string
  token1Mint?: string
  vault0Amount?: string // base units as string
  vault1Amount?: string
  lpSupply?: string
  decimals0?: number
  decimals1?: number
}

const parseBalanceValue = (bal: string | null | undefined): number => {
  if (!bal || bal === '-') return 0
  const parsed = Number(bal.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export default function DepositForm() {
  const location = useLocation()
  const navigate = useNavigate()
  const rawState = (location.state as any) || {}
  const poolFromRoute = (rawState as Pool) || null
  const program = useProgram()
  const wallet = useWallet()
  const { connection } = useConnection()
  const { detectTokenProgram, deriveAta, buildEnsureAtaInstruction } = useTokenProgramAta()
  const dispatch = useDispatch()

  const poolPdaParam = useMemo(() => {
    try {
      if (rawState?.poolPda) return new PublicKey(rawState.poolPda)
    } catch (e) {
      return undefined
    }
    return undefined
  }, [rawState])

  const token0MintParam = useMemo(() => {
    try {
      if (rawState?.token0Mint) return new PublicKey(rawState.token0Mint)
      if (rawState?.token0) return new PublicKey(rawState.token0)
    } catch (e) {
      return undefined
    }
    return undefined
  }, [rawState])

  const token1MintParam = useMemo(() => {
    try {
      if (rawState?.token1Mint) return new PublicKey(rawState.token1Mint)
      if (rawState?.token1) return new PublicKey(rawState.token1)
    } catch (e) {
      return undefined
    }
    return undefined
  }, [rawState])

  const ammConfigParam = useMemo(() => {
    try {
      if (rawState?.ammConfig) return new PublicKey(rawState.ammConfig)
    } catch (e) {
      return undefined
    }
    return undefined
  }, [rawState])

  const { poolState, vault0Amount, vault1Amount, decimals0: hookDecimals0, decimals1: hookDecimals1, refresh: refreshPoolState } = usePool({ poolPda: poolPdaParam, ammConfig: ammConfigParam, token0Mint: token0MintParam, token1Mint: token1MintParam })


  const poolName = poolFromRoute?.name ?? (poolState ? `Pool ${poolState?.lpMint?.toString?.()?.slice?.(0, 6) ?? 'Unknown'}` : 'Unknown Pool')
  const pool = poolFromRoute || { name: poolName, fee: '-' }

  // prefer on-chain numeric values from usePool, fall back to route-provided values
  const decimals0 = hookDecimals0 ?? poolState?.mint_0_decimals ?? (pool.decimals0 ?? 0)
  const decimals1 = hookDecimals1 ?? poolState?.mint_1_decimals ?? (pool.decimals1 ?? 0)

  const toAddressString = (v: any) => {
    if (!v) return null
    if (typeof v === 'string') return v
    if (v?.toBase58) return v.toBase58()
    try { return String(v) } catch { return null }
  }

  const poolIdStr = toAddressString(rawState?.poolPda ?? poolFromRoute?.poolPda)
  const ammConfigStr = toAddressString(rawState?.ammConfig)
  const token0Str = toAddressString(rawState?.token0Mint ?? rawState?.token0)
  const token1Str = toAddressString(rawState?.token1Mint ?? rawState?.token1)

  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [lastEditedField, setLastEditedField] = useState<'token0' | 'token1'>('token0')
  const [userBalances, setUserBalances] = useState<{ token0: string; token1: string } | null>(null)
  const [quote, setQuote] = useState<null | {
    impliedLp: string,
    token0PostHuman: string
    token1PostHuman: string
  }>(null)

  const [poolHoverInfo, setPoolHoverInfo] = useState<{ poolId?: string | null; token0?: string | null; token1?: string | null } | null>(null)
  const poolHoverTimeout = useRef<number | null>(null)
  const [activePoolFeeTier, setActivePoolFeeTier] = useState<string>('-')

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

  useEffect(() => {
    const configStr = ammConfigStr
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
            try { configAcct = coder.decode('AmmConfig', info.data) } catch (e) {}
            if (!configAcct) try { configAcct = coder.decode('ammConfig', info.data) } catch (e) {}
            if (!configAcct) try { configAcct = coder.decode('amm_config', info.data) } catch (e) {}
          }
        }

        if (!mounted) return

        if (configAcct) {
          const feeRate = configAcct.tradeFeeRate ?? configAcct.trade_fee_rate ?? 0
          const feeRateNum = typeof feeRate === 'number'
            ? feeRate
            : feeRate?.toNumber
              ? feeRate.toNumber()
              : Number(feeRate?.toString?.()) || 0
          setActivePoolFeeTier(`${(feeRateNum / 10000).toFixed(2)}%`)
        } else if (pool.fee) {
          const feeStr = String(pool.fee)
          setActivePoolFeeTier(feeStr.includes('%') ? feeStr : `${feeStr}%`)
        } else {
          setActivePoolFeeTier('-')
        }
      } catch (err) {
        console.error('Error fetching specific AMM config:', err)
        if (mounted) {
          if (pool.fee) {
            const feeStr = String(pool.fee)
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
  }, [ammConfigStr, program, connection, pool.fee])


  useEffect(() => {
    if (!wallet.publicKey || !token0MintParam || !token1MintParam) {
      setUserBalances(null)
      return
    }

    let mounted = true
    const fetchUserBalances = async () => {
      try {
        const owner = wallet.publicKey!
        const mint0Str = token0MintParam.toBase58()
        const mint1Str = token1MintParam.toBase58()

        const mint0 = token0MintParam
        const mint1 = token1MintParam

        let dec0 = decimals0
        let dec1 = decimals1

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
          } catch (e) {}
        }
        if (dec1 === 0 && !isSol1) {
          try {
            const mInfo = await callWithRetry(() => getMint(connection, mint1, 'confirmed', tokenProgram1))
            dec1 = mInfo.decimals
          } catch (e) {}
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
    const interval = setInterval(fetchUserBalances, 10000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [wallet.publicKey, token0MintParam, token1MintParam, connection, decimals0, decimals1])
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  const formatBaseUnitsToHuman = (amount: BN, decimals: number) => {
    if (!Number.isFinite(decimals) || decimals < 0) throw new Error('Invalid mint decimals')
    const raw = amount.toString(10)
    if (decimals === 0) return raw
    const padded = raw.padStart(decimals + 1, '0')
    const whole = padded.slice(0, -decimals)
    const fraction = padded.slice(-decimals).replace(/0+$/, '')
    return fraction.length ? `${whole}.${fraction}` : whole
  }

  const applyMaxBuffer = (amount: BN, bps: number) => {
    const numerator = amount.mul(new BN(10000 + bps))
    return numerator.add(new BN(9999)).div(new BN(10000))
  }

  const copyText = async (value?: string | null) => {
    if (!value) return
    try { await navigator.clipboard.writeText(value) } catch (e) { }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleDeposit()
  }

  // prefer hook-provided UI amounts (already converted to UI amounts by usePool), else fall back to route-provided numeric values
  const totalVault0UI = (vault0Amount != null) ? vault0Amount : (pool.vault0Amount != null ? Number(pool.vault0Amount) : undefined)
  const totalVault1UI = (vault1Amount != null) ? vault1Amount : (pool.vault1Amount != null ? Number(pool.vault1Amount) : undefined)

  const loadQuoteContext = async () => {
    if (!program) throw new Error('Program not ready')
    const programId = (program as any).programId as PublicKey
    let t0 = token0MintParam as PublicKey | undefined
    let t1 = token1MintParam as PublicKey | undefined
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
      const [p] = await getPoolAddress(ammConfigParam as PublicKey, t0!, t1!, programId)
      poolAddr = p
    }

    const [lpMint] = await getPoolLpMintAddress(poolAddr, programId)
    const [token0Vault] = await getPoolVaultAddress(poolAddr, t0 as PublicKey, programId)
    const [token1Vault] = await getPoolVaultAddress(poolAddr, t1 as PublicKey, programId)

    const connectionRef = (program.provider as any).connection
    const token0Program = await detectTokenProgram(t0!)
    const token1Program = await detectTokenProgram(t1!)
    const lpTokenProgram = await detectTokenProgram(lpMint).catch(() => TOKEN_PROGRAM_ID)

    const mint0 = await getMint(connectionRef, t0!, 'confirmed', token0Program)
    const mint1 = await getMint(connectionRef, t1!, 'confirmed', token1Program)
    const lpMintAcct = await getMint(connectionRef, lpMint, 'confirmed', lpTokenProgram)
    const vault0Acct = await getAccount(connectionRef, token0Vault, 'confirmed', token0Program)
    const vault1Acct = await getAccount(connectionRef, token1Vault, 'confirmed', token1Program)
    const poolStateAcct: any = await (program.account as any).poolState.fetch(poolAddr)

    const poolVault0Amount = new BN(vault0Acct.amount.toString())
    const poolVault1Amount = new BN(vault1Acct.amount.toString())
    const lpSupplyFromState = new BN(poolStateAcct.lpSupply?.toString?.() ?? lpMintAcct.supply.toString())

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

    return { t0: t0!, t1: t1!, mint0, mint1, totalVault0, totalVault1, lpSupplyFromState }
  }

  const quoteFromToken0 = async (inputToken0Human: string) => {
    const ctx = await loadQuoteContext()
    const connectionRef = (program as any).provider as any
    const inputToken0Base = parseHumanAmountToBaseUnits(inputToken0Human, Number(ctx.mint0.decimals ?? 0))
    const fee0bn = await computeTransferFeeForPre(connectionRef.connection, ctx.t0, inputToken0Base)
    const postToken0 = inputToken0Base.sub(fee0bn)

    let impliedLp = postToken0.mul(ctx.lpSupplyFromState).div(ctx.totalVault0)
    if (postToken0.mul(ctx.lpSupplyFromState).mod(ctx.totalVault0).gt(new BN(0))) impliedLp = impliedLp.add(new BN(1))

    const results = ConstantProductCurve.lpTokensToTradingTokens(
      impliedLp,
      ctx.lpSupplyFromState,
      ctx.totalVault0,
      ctx.totalVault1,
      RoundDirection.Ceiling
    )

    const token1Amount = results.tokenAmount1
    const inv1 = await computeInverseTransferFee(connectionRef.connection, ctx.t1, token1Amount)
    const max1Human = formatBaseUnitsToHuman(inv1.transferAmount, Number(ctx.mint1.decimals ?? 0))
    return { impliedLp: impliedLp.toString(), token0PostHuman: inputToken0Human, token1PostHuman: max1Human }
  }

  const quoteFromToken1 = async (inputToken1Human: string) => {
    const ctx = await loadQuoteContext()
    const connectionRef = (program as any).provider as any
    const inputToken1Base = parseHumanAmountToBaseUnits(inputToken1Human, Number(ctx.mint1.decimals ?? 0))
    const fee1bn = await computeTransferFeeForPre(connectionRef.connection, ctx.t1, inputToken1Base)
    const postToken1 = inputToken1Base.sub(fee1bn)

    let impliedLp = postToken1.mul(ctx.lpSupplyFromState).div(ctx.totalVault1)
    if (postToken1.mul(ctx.lpSupplyFromState).mod(ctx.totalVault1).gt(new BN(0))) impliedLp = impliedLp.add(new BN(1))

    const results = ConstantProductCurve.lpTokensToTradingTokens(
      impliedLp,
      ctx.lpSupplyFromState,
      ctx.totalVault0,
      ctx.totalVault1,
      RoundDirection.Ceiling
    )

    const token0Amount = results.tokenAmount0
    const inv0 = await computeInverseTransferFee(connectionRef.connection, ctx.t0, token0Amount)
    const max0Human = formatBaseUnitsToHuman(inv0.transferAmount, Number(ctx.mint0.decimals ?? 0))
    return { impliedLp: impliedLp.toString(), token0PostHuman: max0Human, token1PostHuman: inputToken1Human }
  }

  const toNumberSafe = (v: any) => {
    if (v == null) return 0
    if (typeof v === 'number') return v
    if (typeof v === 'string') return Number(v)
    if (v?.toNumber) return v.toNumber()
    if (v?.toString) return Number(v.toString())
    return 0
  }

  const feesToken0UI = poolState
    ? (toNumberSafe(poolState.protocolFeesToken0) + toNumberSafe(poolState.fundFeesToken0) + toNumberSafe(poolState.creatorFeesToken0)) / Math.pow(10, decimals0)
    : 0
  const feesToken1UI = poolState
    ? (toNumberSafe(poolState.protocolFeesToken1) + toNumberSafe(poolState.fundFeesToken1) + toNumberSafe(poolState.creatorFeesToken1)) / Math.pow(10, decimals1)
    : 0

  const netVault0UI = totalVault0UI != null ? (Number(totalVault0UI) - feesToken0UI) : null
  const netVault1UI = totalVault1UI != null ? (Number(totalVault1UI) - feesToken1UI) : null

  const totalDepositAmount = Number(amountA || '0') + Number(amountB || '0')
  const depositToken0Percent = totalDepositAmount > 0 ? ((Number(amountA || '0') / totalDepositAmount) * 100).toFixed(2) : '-'
  const depositToken1Percent = totalDepositAmount > 0 ? ((Number(amountB || '0') / totalDepositAmount) * 100).toFixed(2) : '-'
  const dynamicRatio = totalDepositAmount > 0
    ? `${depositToken0Percent}% ${getShortTokenName(token0Str)} / ${depositToken1Percent}% ${getShortTokenName(token1Str)}`
    : '-'

  const isInsufficientA = wallet.publicKey && amountA && userBalances?.token0
    ? (Number(amountA) > parseBalanceValue(userBalances.token0))
    : false

  const isInsufficientB = wallet.publicKey && amountB && userBalances?.token1
    ? (Number(amountB) > parseBalanceValue(userBalances.token1))
    : false

  const canSubmitDeposit = !busy && !!wallet.publicKey && (Number(amountA || '0') > 0 || Number(amountB || '0') > 0) && !isInsufficientA && !isInsufficientB

  async function handleDeposit() {
    if (!program) {
      alert('Program not ready')
      return
    }
    if (!wallet || !wallet.publicKey) {
      alert('Connect wallet to deposit')
      return
    }
    if (isInsufficientA || isInsufficientB) {
      setStatus('Insufficient balance')
      return
    }

    setBusy(true)
    setStatus('Preparing deposit transaction...')

    try {
      const programId = (program as any).programId as PublicKey
      let t0 = token0MintParam as PublicKey | undefined
      let t1 = token1MintParam as PublicKey | undefined
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
        if (!t0 || !t1 || !ammConfigParam) {
          alert('Pool PDA or (token mints + ammConfig) required to perform deposit on-chain')
          return
        }
        const [p] = await getPoolAddress(ammConfigParam as PublicKey, t0, t1, programId)
        poolAddr = p
      }

      const [authority] = await getAuthAddress(programId)
      const [lpMint] = await getPoolLpMintAddress(poolAddr, programId)
      const [token0Vault] = await getPoolVaultAddress(poolAddr, t0 as PublicKey, programId)
      const [token1Vault] = await getPoolVaultAddress(poolAddr, t1 as PublicKey, programId)

      const connectionRef = (program.provider as any).connection
      const token0Program = await detectTokenProgram(t0!)
      const token1Program = await detectTokenProgram(t1!)
      const lpTokenProgram = await detectTokenProgram(lpMint).catch(() => TOKEN_PROGRAM_ID)

      const mint0 = await getMint(connectionRef, t0!, 'confirmed', token0Program)
      const mint1 = await getMint(connectionRef, t1!, 'confirmed', token1Program)
      const lpMintAcct = await getMint(connectionRef, lpMint, 'confirmed', lpTokenProgram)

      const vault0Acct = await getAccount(connectionRef, token0Vault, 'confirmed', token0Program)
      const vault1Acct = await getAccount(connectionRef, token1Vault, 'confirmed', token1Program)

      const poolStateAcct: any = await (program.account as any).poolState.fetch(poolAddr)

      const poolVault0Amount = new BN(vault0Acct.amount.toString())
      const poolVault1Amount = new BN(vault1Acct.amount.toString())

      const lpSupplyFromMint = new BN(lpMintAcct.supply.toString())
      const lpSupplyFromState = new BN(poolStateAcct.lpSupply?.toString?.() ?? lpSupplyFromMint.toString())

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

      const sourceField = lastEditedField
      const sourceHuman = sourceField === 'token0' ? amountA : amountB
      const sourceMint = sourceField === 'token0' ? t0! : t1!
      const sourceDecimals = sourceField === 'token0' ? mint0.decimals : mint1.decimals

      if (Number(sourceHuman || '0') <= 0) {
        alert(`Enter Token ${sourceField === 'token0' ? 'A' : 'B'} amount for deposit quoting`)
        return
      }

      const sourceBase = parseHumanAmountToBaseUnits(sourceHuman, Number(sourceDecimals ?? 0))
      const sourceFee = await computeTransferFeeForPre(connectionRef, sourceMint, sourceBase)
      const sourcePost = sourceBase.sub(sourceFee)

      let impliedLp = sourceField === 'token0'
        ? sourcePost.mul(lpSupplyFromState).div(totalVault0)
        : sourcePost.mul(lpSupplyFromState).div(totalVault1)
      const sourceVault = sourceField === 'token0' ? totalVault0 : totalVault1
      if (sourcePost.mul(lpSupplyFromState).mod(sourceVault).gt(new BN(0))) {
        impliedLp = impliedLp.add(new BN(1))
      }

      const results = ConstantProductCurve.lpTokensToTradingTokens(
        impliedLp,
        lpSupplyFromState,
        totalVault0,
        totalVault1,
        RoundDirection.Ceiling
      )

      const token0Amount = results.tokenAmount0
      const token1Amount = results.tokenAmount1

      let max0: BN
      let max1: BN
      if (sourceField === 'token0') {
        max0 = sourceBase
        max1 = (await computeInverseTransferFee(connectionRef, t1!, token1Amount)).transferAmount
      } else {
        max1 = sourceBase
        max0 = (await computeInverseTransferFee(connectionRef, t0!, token0Amount)).transferAmount
      }

      const maxSlippageBps = 30
      const max0WithBuffer = applyMaxBuffer(max0, maxSlippageBps)
      const max1WithBuffer = applyMaxBuffer(max1, maxSlippageBps)

      const ownerLpAtaCtx = await buildEnsureAtaInstruction({
        payer: wallet.publicKey!,
        owner: wallet.publicKey!,
        mint: lpMint,
        tokenProgram: lpTokenProgram,
      })
      const ownerToken0AtaCtx = await buildEnsureAtaInstruction({
        payer: wallet.publicKey!,
        owner: wallet.publicKey!,
        mint: t0!,
        tokenProgram: token0Program,
      })
      const ownerToken1AtaCtx = await buildEnsureAtaInstruction({
        payer: wallet.publicKey!,
        owner: wallet.publicKey!,
        mint: t1!,
        tokenProgram: token1Program,
      })

      const ownerLpToken = ownerLpAtaCtx.ata
      const ownerToken0Account = ownerToken0AtaCtx.ata
      const ownerToken1Account = ownerToken1AtaCtx.ata

      const impliedLpAnchor = new anchor.BN(impliedLp.toString())
      const max0Anchor = new anchor.BN(max0WithBuffer.toString())
      const max1Anchor = new anchor.BN(max1WithBuffer.toString())

      setStatus('Sending deposit transaction...')
      try {
        const tx = await (program as any).methods
          .deposit(impliedLpAnchor, max0Anchor, max1Anchor)
          .preInstructions([
            ...(ownerLpAtaCtx.instruction ? [ownerLpAtaCtx.instruction] : []),
            ...(ownerToken0AtaCtx.instruction ? [ownerToken0AtaCtx.instruction] : []),
            ...(ownerToken1AtaCtx.instruction ? [ownerToken1AtaCtx.instruction] : []),
          ])
          .accounts({
            owner: wallet.publicKey,
            authority,
            poolState: poolAddr,
            ownerLpToken,
            token0Account: ownerToken0Account,
            token1Account: ownerToken1Account,
            token0Vault: token0Vault,
            token1Vault: token1Vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            tokenProgram2022: TOKEN_2022_PROGRAM_ID,
            vault0Mint: t0,
            vault1Mint: t1,
            lpMint,
          })
          .rpc()

        setTxResult({ sig: tx, explorer: 'https://explorer.solana.com/tx/' + tx + '?cluster=devnet' })
        logActivity({
          actionType: 'Deposit',
          poolAddress: poolAddr.toBase58(),
          tokenPair: `${getShortTokenName(token0Str)}/${getShortTokenName(token1Str)}`,
          signature: tx,
          status: 'success',
        })
        dispatch(solanaApi.util.invalidateTags([{ type: 'Pools', id: 'LIST' }, { type: 'Portfolio', id: 'LIST' }]))
        await refetchPoolStateAfterTx(tx)
        setStatus(null)
        setBusy(false)
      } catch (err: any) {
        logActivity({
          actionType: 'Deposit',
          poolAddress: poolAddr?.toBase58?.(),
          tokenPair: `${getShortTokenName(token0Str)}/${getShortTokenName(token1Str)}`,
          status: 'failed',
        })
        await showSendErrorDetails(err, wallet.publicKey ?? undefined)
        setBusy(false)
      }

      return
    } catch (err: any) {
      logActivity({
        actionType: 'Deposit',
        tokenPair: `${getShortTokenName(token0Str)}/${getShortTokenName(token1Str)}`,
        status: 'failed',
      })
      await showSendErrorDetails(err, wallet.publicKey ?? undefined)
      setBusy(false)
    }
  }

  const refetchPoolStateAfterTx = async (signature?: string | null) => {
    try {
      if (signature) {
        await connection.confirmTransaction(signature, 'confirmed').catch(() => null)
      }
      await refreshPoolState().catch(() => null)
      window.setTimeout(() => {
        void refreshPoolState().catch(() => null)
      }, 900)
    } catch (e) {
      console.error('[DepositForm] Error in refetchPoolStateAfterTx:', e)
    }
  }

  async function showSendErrorDetails(err: any, hintAddress?: PublicKey) {
    try {
      const rawMsg = (err?.message || String(err) || '').toString().toLowerCase()
      if (rawMsg.includes('already') && rawMsg.includes('processed')) {
        if (hintAddress) {
          try {
            const sigs = await connection.getSignaturesForAddress(hintAddress, { limit: 1 })
            if (sigs && sigs.length > 0) {
              const latestSig = sigs[0].signature
              setTxResult({ sig: latestSig, explorer: 'https://solscan.io/tx/' + latestSig + '?cluster=devnet' })
              await refetchPoolStateAfterTx(latestSig)
              setStatus('Transaction executed successfully.')
              return
            }
          } catch (e) { }
        }
        setStatus('Transaction appears already processed; it likely executed successfully.')
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

  const getIconLabel = (symbol: string) => symbol.slice(0, 2).toUpperCase()

  return (
    <div className="deposit-page">
      <div className="deposit-layout">
        <div className="deposit-main">
          <button className="deposit-page__back" onClick={() => navigate(location.state?.from || '/liquidity')}>&lt; Back</button>
          <div className="deposit-page__content">
            <div className="deposit-page__form">
              {txResult && (
                <TransactionCard
                  status="success"
                  title="Transaction Successful"
                  message="Your deposit transaction has been confirmed"
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

              <div className="deposit-card">
                <div className="deposit-header">
                  <div className="deposit-title">
                    <h2>Deposit</h2>
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
                              <button className="swap-copy-btn" onClick={() => copyText(poolHoverInfo.poolId)} title="Copy pool id" aria-label="Copy pool id">
                                <img src={copyIcon} alt="Copy" />
                              </button>
                            </div>
                            <div className="swap-hover-row">
                              <span><strong>Token0 Mint:</strong> {poolHoverInfo.token0 ?? '-'}</span>
                              <button className="swap-copy-btn" onClick={() => copyText(poolHoverInfo.token0)} title="Copy token0" aria-label="Copy token0">
                                <img src={copyIcon} alt="Copy" />
                              </button>
                            </div>
                            <div className="swap-hover-row">
                              <span><strong>Token1 Mint:</strong> {poolHoverInfo.token1 ?? '-'}</span>
                              <button className="swap-copy-btn" onClick={() => copyText(poolHoverInfo.token1)} title="Copy token1" aria-label="Copy token1">
                                <img src={copyIcon} alt="Copy" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="deposit-body">
                  {/* Left Panel - Pool Details */}
                  <div className="deposit-panel pool-details-panel">
                    <h3>Pool Details</h3>
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
                          <span className="pool-details-card__label">Total Pool Reserves</span>
                          <div className="pool-details-balances">
                            <div className="pool-balance-row">
                              <span className="pool-balance-token">{getShortTokenName(token0Str)}</span>
                              <span className="pool-balance-amount">{netVault0UI != null ? formatAmount(netVault0UI) : '-'}</span>
                            </div>
                            <div className="pool-balance-row">
                              <span className="pool-balance-token">{getShortTokenName(token1Str)}</span>
                              <span className="pool-balance-amount">{netVault1UI != null ? formatAmount(netVault1UI) : '-'}</span>
                            </div>
                          </div>
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
                  </div>

                  {/* Right Panel - Add Deposit Amount */}
                  <div className="deposit-panel">
                    <h3>Add Deposit Amount</h3>
                    <form className="deposit-form" onSubmit={onSubmit}>
                      {/* Token A Input Card */}
                      <div className={`deposit-input-card ${isInsufficientA ? 'deposit-input-card--invalid' : ''}`}>
                        <div className="deposit-input-card-header">
                          <span className="deposit-input-card-label">Deposit Token A</span>
                          <div className="deposit-input-card-balance-wrap">
                            <img src={walletIcon} alt="Wallet" className="wallet-mini-icon" />
                            <span className={`deposit-input-card-balance-val ${isInsufficientA ? 'deposit-input-card-balance-val--invalid' : ''}`}>{userBalances?.token0 ?? '0'}</span>
                            <button
                              type="button"
                              className="swap-input-card-btn"
                              onClick={async () => {
                                setLastEditedField('token0')
                                setQuote(null)
                                const val = parseBalanceValue(userBalances?.token0)
                                const valStr = val > 0 ? val.toString() : '0'
                                setAmountA(valStr)
                                if (val > 0) {
                                  try {
                                    const nextQuote = await quoteFromToken0(valStr)
                                    setQuote(nextQuote)
                                    setAmountB(nextQuote.token1PostHuman)
                                  } catch (e) {}
                                } else {
                                  setAmountB('')
                                }
                              }}
                            >
                              Max
                            </button>
                            <button
                              type="button"
                              className="swap-input-card-btn"
                              onClick={async () => {
                                setLastEditedField('token0')
                                setQuote(null)
                                const val = parseBalanceValue(userBalances?.token0)
                                const valStr = val > 0 ? (val / 2).toString() : '0'
                                setAmountA(valStr)
                                if (val > 0) {
                                  try {
                                    const nextQuote = await quoteFromToken0(valStr)
                                    setQuote(nextQuote)
                                    setAmountB(nextQuote.token1PostHuman)
                                  } catch (e) {}
                                } else {
                                  setAmountB('')
                                }
                              }}
                            >
                              50%
                            </button>
                          </div>
                        </div>

                        <div className="deposit-input-card-row">
                          {/* Non-interactive Token Pill */}
                          <div className="deposit-token-pill">
                            <div className="swap-token-logo-sphere deposit-token-logo-sphere deposit-token-logo-sphere--a">
                              {getIconLabel(getShortTokenName(token0Str))}
                            </div>
                            <span className="swap-token-symbol deposit-token-symbol">{getShortTokenName(token0Str)}</span>
                          </div>

                          <div className="swap-input-amount-wrap deposit-input-amount-wrap">
                            <input
                              type="text"
                              className="swap-input-field-borderless"
                              value={amountA}
                              onChange={async (e) => {
                                setLastEditedField('token0')
                                setQuote(null)
                                const next = e.target.value
                                setAmountA(next)
                                if (!next || Number(next) <= 0) {
                                  setAmountB('')
                                  return
                                }
                                try {
                                  const nextQuote = await quoteFromToken0(next)
                                  setQuote(nextQuote)
                                  setAmountB(nextQuote.token1PostHuman)
                                } catch (err) { }
                              }}
                              placeholder="0"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Divider Plus Icon between Token A and Token B (decorative) */}
                      <div className="dex-liquidity-divider">
                        <div className="dex-liquidity-divider__circle">
                          <img src={plusIcon} alt="plus" className="dex-plus-icon" />
                        </div>
                      </div>

                      {/* Token B Input Card */}
                      <div className={`deposit-input-card ${isInsufficientB ? 'deposit-input-card--invalid' : ''}`}>
                        <div className="deposit-input-card-header">
                          <span className="deposit-input-card-label">Deposit Token B</span>
                          <div className="deposit-input-card-balance-wrap">
                            <img src={walletIcon} alt="Wallet" className="wallet-mini-icon" />
                            <span className={`deposit-input-card-balance-val ${isInsufficientB ? 'deposit-input-card-balance-val--invalid' : ''}`}>{userBalances?.token1 ?? '0'}</span>
                            <button
                              type="button"
                              className="swap-input-card-btn"
                              onClick={async () => {
                                setLastEditedField('token1')
                                setQuote(null)
                                const val = parseBalanceValue(userBalances?.token1)
                                const valStr = val > 0 ? val.toString() : '0'
                                setAmountB(valStr)
                                if (val > 0) {
                                  try {
                                    const nextQuote = await quoteFromToken1(valStr)
                                    setQuote(nextQuote)
                                    setAmountA(nextQuote.token0PostHuman)
                                  } catch (e) {}
                                } else {
                                  setAmountA('')
                                }
                              }}
                            >
                              Max
                            </button>
                            <button
                              type="button"
                              className="swap-input-card-btn"
                              onClick={async () => {
                                setLastEditedField('token1')
                                setQuote(null)
                                const val = parseBalanceValue(userBalances?.token1)
                                const valStr = val > 0 ? (val / 2).toString() : '0'
                                setAmountB(valStr)
                                if (val > 0) {
                                  try {
                                    const nextQuote = await quoteFromToken1(valStr)
                                    setQuote(nextQuote)
                                    setAmountA(nextQuote.token0PostHuman)
                                  } catch (e) {}
                                } else {
                                  setAmountA('')
                                }
                              }}
                            >
                              50%
                            </button>
                          </div>
                        </div>

                        <div className="deposit-input-card-row">
                          {/* Non-interactive Token Pill */}
                          <div className="deposit-token-pill">
                            <div className="swap-token-logo-sphere deposit-token-logo-sphere deposit-token-logo-sphere--b">
                              {getIconLabel(getShortTokenName(token1Str))}
                            </div>
                            <span className="swap-token-symbol deposit-token-symbol">{getShortTokenName(token1Str)}</span>
                          </div>

                          <div className="swap-input-amount-wrap deposit-input-amount-wrap">
                            <input
                              type="text"
                              className="swap-input-field-borderless"
                              value={amountB}
                              onChange={async (e) => {
                                setLastEditedField('token1')
                                setQuote(null)
                                const next = e.target.value
                                setAmountB(next)
                                if (!next || Number(next) <= 0) {
                                  setAmountA('')
                                  return
                                }
                                try {
                                  const nextQuote = await quoteFromToken1(next)
                                  setQuote(nextQuote)
                                  setAmountA(nextQuote.token0PostHuman)
                                } catch (err) { }
                              }}
                              placeholder="0"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Deposit Ratio Box */}
                      <div className="deposit-ratio-card deposit-ratio-card--spaced">
                        <span className="deposit-ratio-title">Deposit Ratio</span>
                        <div className="deposit-ratio-values">
                          <span>{quote ? dynamicRatio : ''}</span>
                        </div>
                      </div>

                      <div className="swap-actions-row deposit-actions-row">
                        <button type="submit" className="swap-btn-full deposit-submit-btn" disabled={!canSubmitDeposit}>
                          {busy ? 'Depositing...' : !wallet.publicKey ? 'Connect Wallet' : (isInsufficientA || isInsufficientB) ? 'Insufficient Balance' : 'Deposit'}
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
