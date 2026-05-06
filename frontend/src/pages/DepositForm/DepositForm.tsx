import { useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './DepositForm.css'
import useProgram from '../../utils/useProgram'
import usePool from '../../hooks/usePool'
import { PublicKey, SendTransactionError } from '@solana/web3.js'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import * as anchor from '@coral-xyz/anchor'
import { getAuthAddress, getPoolAddress, getPoolLpMintAddress, getPoolVaultAddress } from '../../utils/pda'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getMint, getAccount } from '@solana/spl-token'
import viewIcon from '../../assets/view.svg'
import copyIcon from '../../assets/copy.svg'
import BN from 'bn.js'
import { computeTransferFeeForPre, computeInverseTransferFee } from '../../utils/curve/fee'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import { RoundDirection } from '../../utils/curve/calculator'
import TransactionCard from '../../components/TransactionCard/TransactionCard'

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

export default function DepositForm() {
  const location = useLocation()
  const navigate = useNavigate()
  const rawState = (location.state as any) || {}
  const poolFromRoute = (rawState as Pool) || null
  const program = useProgram()
  const wallet = useWallet()

  // derive params for usePool: prefer explicit poolPda, else use token mints + ammConfig if provided
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

  // DEBUG: Log vault amounts from hook
  console.log('[DepositForm] usePool hook vault amounts:', { vault0Amount, vault1Amount, hookDecimals0, hookDecimals1, poolState: poolState ? 'exists' : 'null' })

  const poolName = poolFromRoute?.name ?? (poolState ? `Pool ${poolState?.lpMint?.toString?.()?.slice?.(0, 6) ?? 'Unknown'}` : 'Unknown Pool')
  const pool = poolFromRoute || { name: poolName, fee: '-' }

  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [lastEditedField, setLastEditedField] = useState<'token0' | 'token1'>('token0')
  const [, setQuote] = useState<null | {
    impliedLp: string,
    token0PostHuman: string
    token1PostHuman: string
  }>(null)
  const [hoverInfo, setHoverInfo] = useState<{ label: string; value: string } | null>(null)
  const hoverTimeout = useRef<number | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { connection } = useConnection()

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

  const toAddressString = (v: any) => {
    if (!v) return null
    if (typeof v === 'string') return v
    if (v?.toBase58) return v.toBase58()
    try { return String(v) } catch { return null }
  }

  const shorten = (v?: string | null) => {
    if (!v) return '-'
    return `${v.slice(0, 4)}...${v.slice(-4)}`
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
      <div className="deposit-hover-card" onMouseEnter={clearHoverTimeout} onMouseLeave={hideHover}>
        <div className="deposit-hover-row">
          <span><strong>{label}:</strong> {value}</span>
          <button className="deposit-copy-btn" onClick={() => copyText(value)} title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`}>
            <img src={copyIcon} alt="Copy" />
          </button>
        </div>
      </div>
    )
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleDeposit()
  }

  // prefer on-chain numeric values from usePool, fall back to route-provided values
  const decimals0 = hookDecimals0 ?? poolState?.mint_0_decimals ?? (pool.decimals0 ?? 0)
  const decimals1 = hookDecimals1 ?? poolState?.mint_1_decimals ?? (pool.decimals1 ?? 0)
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

    const mint0 = await getMint((program.provider as any).connection, t0!)
    const mint1 = await getMint((program.provider as any).connection, t1!)
    const lpMintAcct = await getMint((program.provider as any).connection, lpMint)
    const vault0Acct = await getAccount((program.provider as any).connection, token0Vault)
    const vault1Acct = await getAccount((program.provider as any).connection, token1Vault)
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

  const depositRatio = (netVault0UI != null && netVault1UI != null && netVault1UI > 0)
    ? (netVault0UI / Math.max(netVault1UI, 1)).toFixed(4)
    : '-'

  // DEBUG: Log liquidity and ratio after computation
  console.log('[DepositForm] Computed liquidity/ratio:', { totalVault0UI, totalVault1UI, netVault0UI, netVault1UI, depositRatio, feesToken0UI, feesToken1UI })


  async function handleDeposit() {
    if (!program) {
      alert('Program not ready')
      return
    }
    if (!wallet || !wallet.publicKey) {
      alert('Connect wallet to deposit')
      return
    }

    setBusy(true)
    setStatus('Preparing deposit transaction...')

    try {
      const programId = (program as any).programId as PublicKey
      // Resolve token ordering: scripts sort by buffer ascending
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

      // Resolve pool PDA: prefer explicit param, else derive from provided token mints + ammConfig
      let poolAddr = poolPdaParam
      if (!poolAddr) {
        if (!t0 || !t1 || !ammConfigParam) {
          alert('Pool PDA or (token mints + ammConfig) required to perform deposit on-chain')
          return
        }
        const [p] = await getPoolAddress(ammConfigParam as PublicKey, t0, t1, programId)
        poolAddr = p
      }

      // derive other PDAs
      const [authority] = await getAuthAddress(programId)
      const [lpMint] = await getPoolLpMintAddress(poolAddr, programId)
      const [token0Vault] = await getPoolVaultAddress(poolAddr, t0 as PublicKey, programId)
      const [token1Vault] = await getPoolVaultAddress(poolAddr, t1 as PublicKey, programId)

      // Fetch on-chain mint/vault info (base units)
      const mint0 = await getMint((program.provider as any).connection, t0!)
      const mint1 = await getMint((program.provider as any).connection, t1!)
      const lpMintAcct = await getMint((program.provider as any).connection, lpMint)

      const vault0Acct = await getAccount((program.provider as any).connection, token0Vault)
      const vault1Acct = await getAccount((program.provider as any).connection, token1Vault)

      const poolStateAcct: any = await (program.account as any).poolState.fetch(poolAddr)

      const poolVault0Amount = new BN(vault0Acct.amount.toString())
      const poolVault1Amount = new BN(vault1Acct.amount.toString())

      const lpSupplyFromMint = new BN(lpMintAcct.supply.toString())
      const lpSupplyFromState = new BN(poolStateAcct.lpSupply?.toString?.() ?? lpSupplyFromMint.toString())

      // compute fee counters (BN) and totalVaults used by program
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

      // Helper: detect token program owner (SPL v1 or token-2022)
      async function detectTokenProgram(connection: any, mint: PublicKey) {
        const info = await connection.getAccountInfo(mint)
        if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`)
        if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
        if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
        // fallback to v1
        return TOKEN_PROGRAM_ID
      }

      const sourceField = lastEditedField
      const connectionRef = (program.provider as any).connection
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

      // Prepare associated addresses (use per-mint token program when computing ATA)
      const token0Program = await detectTokenProgram((program.provider as any).connection, t0!)
      const token1Program = await detectTokenProgram((program.provider as any).connection, t1!)

      const lpTokenProgram = (await (program.provider as any).connection.getAccountInfo(lpMint))?.owner?.equals(TOKEN_PROGRAM_ID)
        ? TOKEN_PROGRAM_ID
        : TOKEN_2022_PROGRAM_ID
      const ownerLpToken = getAssociatedTokenAddressSync(lpMint, wallet.publicKey!, false, lpTokenProgram)
      const ownerLpInfo = await (program.provider as any).connection.getAccountInfo(ownerLpToken).catch(() => null)
      const createLpAtaIx = !ownerLpInfo
        ? createAssociatedTokenAccountInstruction(
            wallet.publicKey!,
            ownerLpToken,
            wallet.publicKey!,
            lpMint,
            lpTokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        : null
      const ownerToken0Account = getAssociatedTokenAddressSync(t0!, wallet.publicKey!, false, token0Program)
      const ownerToken1Account = getAssociatedTokenAddressSync(t1!, wallet.publicKey!, false, token1Program)

      // Convert to anchor BN
      const impliedLpAnchor = new anchor.BN(impliedLp.toString())
      const max0Anchor = new anchor.BN(max0WithBuffer.toString())
      const max1Anchor = new anchor.BN(max1WithBuffer.toString())

      try {
        const tx = await (program as any).methods
          .deposit(impliedLpAnchor, max0Anchor, max1Anchor)
          .preInstructions(createLpAtaIx ? [createLpAtaIx] : [])
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

        console.log('[DepositForm] Deposit tx successful:', tx)
        setTxResult({ sig: tx, explorer: 'https://explorer.solana.com/tx/' + tx + '?cluster=devnet' })
        console.log('[DepositForm] About to refetch pool state...')
        await refetchPoolStateAfterTx(tx)
        console.log('[DepositForm] Pool state refetch completed, clearing status')
        setStatus(null)
        setBusy(false)
      } catch (err: any) {
        console.error('Transaction failed:', err)
        await showSendErrorDetails(err, wallet.publicKey ?? undefined)
        setBusy(false)
      }

      return
    } catch (err: any) {
      console.error('Deposit failed', err)
      await showSendErrorDetails(err, wallet.publicKey ?? undefined)
      setBusy(false)
    }
  }

  const poolIdStr = toAddressString(rawState?.poolPda ?? poolFromRoute?.poolPda)
  const ammConfigStr = toAddressString(rawState?.ammConfig)
  const token0Str = toAddressString(rawState?.token0Mint ?? rawState?.token0)
  const token1Str = toAddressString(rawState?.token1Mint ?? rawState?.token1)
  const volume24h = (rawState as any)?.volume24h ?? '-'
  const fees24h = (rawState as any)?.fees24h ?? '-'

  const liquidityDisplay = (totalVault0UI != null && totalVault1UI != null)
    ? `${totalVault0UI} / ${totalVault1UI}`
    : '-'

  const refetchPoolStateAfterTx = async (signature?: string | null) => {
    try {
      console.log('[DepositForm] Starting pool state refresh after tx:', signature)
      if (signature) {
        await connection.confirmTransaction(signature, 'confirmed').catch(() => null)
        console.log('[DepositForm] Transaction confirmed:', signature)
      }
      console.log('[DepositForm] Calling refreshPoolState...')
      await refreshPoolState().catch(() => null)
      console.log('[DepositForm] refreshPoolState completed')
      // Follow-up refresh for RPC propagation lag.
      window.setTimeout(() => {
        console.log('[DepositForm] Performing follow-up refresh (900ms later)')
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

  return (
    <div className="deposit-page">
      <div className="deposit-layout">
        <div className="deposit-main">
          <button className="deposit-page__back" onClick={() => navigate('/liquidity')}>&lt; Back</button>
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
                  onClose={() => {
                    setStatus(null)
                    setErrorDetails(null)
                  }}
                />
              )}

              <div className="deposit-card">
                <div className="deposit-header">
                  <div className="deposit-title">
                    <h2>Deposit</h2>
                    <div className="deposit-subtitle">Pool id: {shorten(poolIdStr)}</div>
                  </div>
                  <div className="deposit-metrics">
                    <div className="metric">
                      <span>Liquidity</span>
                      <strong>{liquidityDisplay}</strong>
                    </div>
                    <div className="metric">
                      <span>Volume 24H</span>
                      <strong>{volume24h}</strong>
                    </div>
                    <div className="metric">
                      <span>Fees 24H</span>
                      <strong>{fees24h}</strong>
                    </div>
                  </div>
                </div>

                <div className="deposit-body">
                  <div className="deposit-panel">
                    <h3>Pool Details</h3>
                    <div className="address-row">
                      <span>Pool id</span>
                      <span className="address-value">{shorten(poolIdStr)}</span>
                      <div className="deposit-hover-wrapper" onMouseEnter={() => showHover('Pool id', poolIdStr)} onMouseLeave={hideHover}>
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
                      <div className="deposit-hover-wrapper" onMouseEnter={() => showHover('Amm config', ammConfigStr)} onMouseLeave={hideHover}>
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
                      <div className="deposit-hover-wrapper" onMouseEnter={() => showHover('Token0 address', token0Str)} onMouseLeave={hideHover}>
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
                      <div className="deposit-hover-wrapper" onMouseEnter={() => showHover('Token1 address', token1Str)} onMouseLeave={hideHover}>
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

                  <div className="deposit-panel">
                    <h3>Add Deposit Amount</h3>
                    <form className="deposit-form" onSubmit={onSubmit}>
                      <div className="token-row">
                        <div className="token-info">
                          <span className="token-label">Token A</span>
                          <div className="token-address">
                            <span>{shorten(token0Str)}</span>
                          </div>
                        </div>
                        <input
                          className="deposit-input"
                          value={amountA}
                          onChange={async (e) => {
                            setLastEditedField('token0')
                            const next = e.target.value
                            setAmountA(next)
                            if (!next || Number(next) <= 0) return
                            try {
                              const nextQuote = await quoteFromToken0(next)
                              setQuote(nextQuote)
                              setAmountB(nextQuote.token1PostHuman)
                            } catch (err) { }
                          }}
                          placeholder="0.0"
                        />
                      </div>

                      <div className="token-row">
                        <div className="token-info">
                          <span className="token-label">Token B</span>
                          <div className="token-address">
                            <span>{shorten(token1Str)}</span>
                          </div>
                        </div>
                        <input
                          className="deposit-input"
                          value={amountB}
                          onChange={async (e) => {
                            setLastEditedField('token1')
                            const next = e.target.value
                            setAmountB(next)
                            if (!next || Number(next) <= 0) return
                            try {
                              const nextQuote = await quoteFromToken1(next)
                              setQuote(nextQuote)
                              setAmountA(nextQuote.token0PostHuman)
                            } catch (err) { }
                          }}
                          placeholder="0.0"
                        />
                      </div>

                      <div className="deposit-actions-row" style={{ textAlign: 'center' }}>
                        <button type="submit" className="btn primary" disabled={busy || !(numeric(lastEditedField === 'token0' ? amountA : amountB) > 0) || !wallet.publicKey}>Deposit</button>
                      </div>

                      <div className="deposit-summary">
                        <div>Total Deposit (est): {amountA || '-'} / {amountB || '-'}</div>
                        <div>Editing: {lastEditedField === 'token0' ? 'Token A' : 'Token B'}</div>
                        <div>Deposit Ratio: {depositRatio}</div>
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
