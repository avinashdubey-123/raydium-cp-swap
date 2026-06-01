import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import useProgram from '../../utils/useProgram'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import { logActivity } from '../../utils/activity'
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, SendTransactionError } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  getAuthAddress,
  getPoolAddress,
  getPoolLpMintAddress,
  getPoolVaultAddress,
  getOrcleAccountAddress,
  getPermissionPdaAddress,
} from '../../utils/pda'
import {
  addTokenToRegistry,
  getTokenRegistry,
  isValidMintAddress,
  searchTokenRegistry,
  type TokenRegistryEntry,
} from '../../utils/tokenRegistry'
import useTokenProgramAta from '../../hooks/useTokenProgramAta'
import { useDispatch } from 'react-redux'
import { invalidatePoolsList } from '../../store/solanaApi'

const CREATE_POOL_FEE_RECEIVER = new PublicKey('63EqUEuqiLw9ZvJJsFECg5fN7bM9hBifUEYJFGhJtuCa')

import './InitializeForm.css'
import showPriceIcon from '../../assets/show-price.svg'
import copyIcon from '../../assets/copy.svg'
import plusIcon from '../../assets/plus-circle.svg'

const parseHumanAmountToBigInt = (value: string, decimals: number): bigint => {
  const normalized = value.trim()
  if (!Number.isFinite(decimals) || decimals < 0) {
    throw new Error('Invalid mint decimals')
  }
  const parts = normalized.split('.')
  const wholePart = parts[0] || '0'
  let fractionPart = parts[1] || ''
  if (fractionPart.length < decimals) {
    fractionPart = fractionPart + '0'.repeat(decimals - fractionPart.length)
  } else if (fractionPart.length > decimals) {
    fractionPart = fractionPart.slice(0, decimals)
  }
  const baseUnits = `${wholePart}${fractionPart}`.replace(/^0+(?=\d)/, '')
  return BigInt(baseUnits || '0')
}

export default function InitializeForm() {
  const navigate = useNavigate()
  const location = useLocation()
  const program = useProgram()
  const { connection } = useConnection()
  const wallet = useWallet()
  const { detectTokenProgram, buildEnsureAtaInstruction } = useTokenProgramAta()
  const dispatch = useDispatch()

  const state = (location.state as { mode?: 'permissioned' | 'standard' }) || {}
  const isPermissionedMode = state.mode === 'permissioned'

  const [ammConfig, setAmmConfig] = useState('')
  const [mintA, setMintA] = useState('')
  const [mintB, setMintB] = useState('')
  const [baseAmount, setBaseAmount] = useState('')
  const [quoteAmount, setQuoteAmount] = useState('')
  const [openTime, setOpenTime] = useState('0')
  const [status, setStatus] = useState<string | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInversePrice, setShowInversePrice] = useState(false)
  const [isWhitelisted, setIsWhitelisted] = useState(false)
  const [checkingWhitelist, setCheckingWhitelist] = useState(isPermissionedMode)
  const [creatorFeeOn, setCreatorFeeOn] = useState('0')
  const [configs, setConfigs] = useState<any[]>([])
  const [loadingConfigs, setLoadingConfigs] = useState(false)
  const [tokenRegistry, setTokenRegistry] = useState<TokenRegistryEntry[]>([])
  const [tokenPickerFor, setTokenPickerFor] = useState<'mintA' | 'mintB' | null>(null)
  const [tokenQuery, setTokenQuery] = useState('')
  const [tokenPickerStatus, setTokenPickerStatus] = useState<string | null>(null)
  const [addingToken, setAddingToken] = useState(false)
  const [balanceA, setBalanceA] = useState<number>(0)
  const [balanceB, setBalanceB] = useState<number>(0)
  const [balanceRefetchTrigger, setBalanceRefetchTrigger] = useState<number>(0)

  const getDatetimeLocalValue = (unixSeconds: string) => {
    const seconds = Number(unixSeconds)
    if (!seconds || isNaN(seconds)) return ''
    const date = new Date(seconds * 1000)
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    const hh = String(date.getHours()).padStart(2, '0')
    const min = String(date.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`
  }

  const handleDatetimeLocalChange = (datetimeStr: string) => {
    if (!datetimeStr) {
      setOpenTime('0')
      return
    }
    const date = new Date(datetimeStr)
    const seconds = Math.floor(date.getTime() / 1000)
    if (!isNaN(seconds) && seconds > 0) {
      setOpenTime(seconds.toString())
    }
  }

  useEffect(() => {
    if (!wallet.publicKey || !connection) {
      setBalanceA(0)
      setBalanceB(0)
      return
    }

    let active = true

    const fetchBalances = async () => {
      let balA = 0
      let balB = 0

      // Fetch Balance A
      if (mintA.trim()) {
        try {
          const pubkeyA = new PublicKey(mintA.trim())
          const isSol = mintA.trim() === 'So11111111111111111111111111111111111111112'
          if (isSol) {
            const rawBal = await connection.getBalance(wallet.publicKey!)
            balA = rawBal / 1e9
          } else {
            const tokenProgram = await detectTokenProgram(pubkeyA).catch(() => TOKEN_PROGRAM_ID)
            const ata = getAssociatedTokenAddressSync(pubkeyA, wallet.publicKey!, true, tokenProgram)
            const accountBal = await connection.getTokenAccountBalance(ata).catch(() => null)
            if (accountBal && accountBal.value.uiAmount != null) {
              balA = accountBal.value.uiAmount
            }
          }
        } catch (e) {
          console.error('Error fetching balance A:', e)
        }
      }

      // Fetch Balance B
      if (mintB.trim()) {
        try {
          const pubkeyB = new PublicKey(mintB.trim())
          const isSol = mintB.trim() === 'So11111111111111111111111111111111111111112'
          if (isSol) {
            const rawBal = await connection.getBalance(wallet.publicKey!)
            balB = rawBal / 1e9
          } else {
            const tokenProgram = await detectTokenProgram(pubkeyB).catch(() => TOKEN_PROGRAM_ID)
            const ata = getAssociatedTokenAddressSync(pubkeyB, wallet.publicKey!, true, tokenProgram)
            const accountBal = await connection.getTokenAccountBalance(ata).catch(() => null)
            if (accountBal && accountBal.value.uiAmount != null) {
              balB = accountBal.value.uiAmount
            }
          }
        } catch (e) {
          console.error('Error fetching balance B:', e)
        }
      }

      if (active) {
        setBalanceA(balA)
        setBalanceB(balB)
      }
    }

    fetchBalances()
    const interval = setInterval(fetchBalances, 10000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [wallet.publicKey, mintA, mintB, connection, balanceRefetchTrigger])

  // validation: if inputs exceed user balances, mark invalid similar to DepositForm
  const parsedBaseAmount = Number((baseAmount || '0').toString().replace(/,/g, '')) || 0
  const parsedQuoteAmount = Number((quoteAmount || '0').toString().replace(/,/g, '')) || 0
  const isInsufficientBase = !!wallet.publicKey && parsedBaseAmount > (balanceA || 0)
  const isInsufficientQuote = !!wallet.publicKey && parsedQuoteAmount > (balanceB || 0)
  const canSubmitInitialize = !busy && !!wallet.publicKey && !isInsufficientBase && !isInsufficientQuote

  const tokenA = useMemo(() => tokenRegistry.find(entry => entry.mint === mintA.trim()), [mintA, tokenRegistry])
  const tokenB = useMemo(() => tokenRegistry.find(entry => entry.mint === mintB.trim()), [mintB, tokenRegistry])

  const baseIsA = true
  const TEST_MODE = false

  async function showSendErrorDetails(err: any, hintAddress?: PublicKey) {
    const errorMessage = (err?.message || String(err) || '').toString()
    console.error('[InitializeForm] initialize failed', {
      error: err,
      message: errorMessage,
      wallet: wallet.publicKey?.toBase58?.() ?? null,
      mintA: mintA || null,
      mintB: mintB || null,
      baseAmount,
      quoteAmount,
      isPermissionedMode,
      hintAddress: hintAddress?.toBase58?.() ?? null,
    })
    try {
      const rawMsg = errorMessage.toLowerCase()
      if (rawMsg.includes('already') && rawMsg.includes('processed')) {
        if (hintAddress) {
          try {
            const sigs = await connection.getSignaturesForAddress(hintAddress, { limit: 1 })
            if (sigs && sigs.length > 0) {
              const latestSig = sigs[0].signature
              setTxResult({ sig: latestSig, explorer: 'https://explorer.solana.com/tx/' + latestSig + '?cluster=devnet' })
              setStatus('Transaction executed successfully.')
              return
            }
          } catch (e) {
            console.error(e)
          }
        }
        setStatus('Transaction appears already processed; it likely executed successfully.')
        return
      }
    } catch (e) {
      console.error(e)
    }

    if (err instanceof SendTransactionError || err?.name === 'SendTransactionError') {
      try {
        const logs = await err.getLogs(connection).catch(() => null)
        if (logs && logs.length) {
          console.error('[InitializeForm] simulation logs', logs)
          setErrorDetails(logs.join('\n'))
          setStatus('Simulation failed. Click "Details" to view logs.')
          return
        }
        const sig = err?.signature || err?.txSignature || (typeof err.message === 'string' && (err.message.match(/[A-Za-z0-9]{60,88}/)?.[0])) || null
        if (sig) {
          const tx = await (connection as any).getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null)
          const txLogs = (tx as any)?.meta?.logMessages
          if (txLogs && txLogs.length) {
            console.error('[InitializeForm] rpc transaction logs', txLogs)
            setErrorDetails(txLogs.join('\n'))
            setStatus('Transaction processed. Click "Details" to view RPC logs.')
            return
          }
        }
        console.error('[InitializeForm] simulation failed without logs', errorMessage)
        setStatus('Simulation failed: ' + (err.message || String(err)))
      } catch (inner) {
        console.error('[InitializeForm] error while collecting logs', inner)
        setStatus('Simulation failed: ' + (err.message || String(err)))
      }
    } else {
      console.error('[InitializeForm] non-transaction error', err)
      setStatus('Error: ' + (err.message || String(err)))
    }
  }

  useEffect(() => {
    setTokenRegistry(getTokenRegistry())
  }, [])

  async function getMintWithProgramFallback(mint: PublicKey) {
    const preferredProgram = await detectTokenProgram(mint)
    const programsToTry = preferredProgram.equals(TOKEN_PROGRAM_ID)
      ? [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
      : [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]

    let lastError: any = null
    for (const tokenProgram of programsToTry) {
      try {
        const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram)
        return { mintInfo, tokenProgram }
      } catch (error: any) {
        lastError = error
      }
    }

    throw lastError || new Error(`Unable to read mint info for ${mint.toBase58()}`)
  }

  useEffect(() => {
    const fetchConfigs = async () => {
      if (!program) return
      setLoadingConfigs(true)
      try {
        const all = await (program.account as any).ammConfig.all()
        const sorted = all.map((a: any) => ({
          ...a.account,
          publicKey: a.publicKey,
        })).sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        setConfigs(sorted)
        if (sorted.length > 0 && !ammConfig) {
          setAmmConfig(sorted[0].publicKey.toBase58())
        }
      } catch (e) {
        console.error('Failed to fetch configs', e)
      } finally {
        setLoadingConfigs(false)
      }
    }
    fetchConfigs()

    const checkWhitelist = async () => {
      if (!program || !wallet.publicKey) {
        if (isPermissionedMode) setCheckingWhitelist(false)
        return
      }
      try {
        if (isPermissionedMode) setCheckingWhitelist(true)
        const [permissionPda] = await getPermissionPdaAddress(wallet.publicKey, program.programId)
        const account = await connection.getAccountInfo(permissionPda)
        if (account) setIsWhitelisted(true)
      } catch (e) {
        console.error('Whitelist check failed:', e)
      } finally {
        setCheckingWhitelist(false)
      }
    }
    checkWhitelist()
  }, [program, wallet.publicKey, isPermissionedMode])

  useEffect(() => {
    if (!tokenPickerFor) {
      setTokenPickerStatus(null)
      return
    }
    setTokenQuery(tokenPickerFor === 'mintA' ? mintA : mintB)
    setTokenPickerStatus(null)
  }, [tokenPickerFor, mintA, mintB])

  const otherSelectedMint = tokenPickerFor === 'mintA' ? mintB.trim() : tokenPickerFor === 'mintB' ? mintA.trim() : ''
  const tokenSearchResults = useMemo(
    () => searchTokenRegistry(tokenQuery, tokenRegistry).filter(token => token.mint !== otherSelectedMint),
    [tokenQuery, tokenRegistry, otherSelectedMint]
  )
  const canAddToken = isValidMintAddress(tokenQuery)
    && !tokenRegistry.some(token => token.mint === tokenQuery.trim())
    && tokenQuery.trim() !== otherSelectedMint

  function closeTokenPicker() {
    setTokenPickerFor(null)
    setTokenQuery('')
    setTokenPickerStatus(null)
    setAddingToken(false)
  }

  function openTokenPicker(field: 'mintA' | 'mintB') {
    setTokenPickerFor(field)
    setTokenQuery(field === 'mintA' ? mintA : mintB)
    setTokenPickerStatus(null)
  }

  function applyTokenMint(mint: string) {
    if (tokenPickerFor === 'mintA') setMintA(mint)
    if (tokenPickerFor === 'mintB') setMintB(mint)
    closeTokenPicker()
  }

  async function handleAddToken() {
    if (!canAddToken) return
    setAddingToken(true)
    setTokenPickerStatus(null)
    try {
      const entry = await addTokenToRegistry(connection, tokenQuery)
      setTokenRegistry(getTokenRegistry())
      applyTokenMint(entry.mint)
    } catch (error: any) {
      setTokenPickerStatus(error?.message || 'Failed to add token')
    } finally {
      setAddingToken(false)
    }
  }

  async function handleInitialize() {
    if (!program) return setStatus('Program not ready')
    if (!wallet.publicKey) return setStatus('Connect wallet')
    if (busy) return
    setBusy(true)
    try {
      setStatus('Deriving and preparing initialize transaction...')
      const programId = (program as any).programId as PublicKey
      const creator = wallet.publicKey!
      let amm: PublicKey
      let mA: PublicKey
      let mB: PublicKey
      try {
        amm = new PublicKey(ammConfig)
        mA = new PublicKey(mintA)
        mB = new PublicKey(mintB)
      } catch (e) {
        setStatus('Invalid AMM or mint pubkey')
        setBusy(false)
        return
      }

      const [authority] = await getAuthAddress(programId)
      const [token0Mint, token1Mint] = Buffer.compare(mA.toBuffer(), mB.toBuffer()) < 0 ? [mA, mB] : [mB, mA]
      const token0Program = await detectTokenProgram(token0Mint)
      const token1Program = await detectTokenProgram(token1Mint)

      const [poolState] = await getPoolAddress(amm, token0Mint, token1Mint, programId)

      // Pre-flight: check if pool already exists on-chain.
      // Without this, the on-chain initialize instruction tries to Allocate the pool
      // state PDA via System Program and fails with "account already in use" /
      // custom error 0x0 — an opaque error with no user-friendly message.
      const existingPoolAccount = await connection.getAccountInfo(poolState).catch(() => null)
      if (existingPoolAccount) {
        setStatus(
          `Pool already exists (${poolState.toBase58().slice(0, 8)}…). ` +
          'Use the Deposit page to add liquidity to this pool.'
        )
        setBusy(false)
        return
      }

      const [lpMint] = await getPoolLpMintAddress(poolState, programId)
      const [token0Vault] = await getPoolVaultAddress(poolState, token0Mint, programId)
      const [token1Vault] = await getPoolVaultAddress(poolState, token1Mint, programId)
      const [observationState] = await getOrcleAccountAddress(poolState, programId)

      const mint0Resolved = await getMintWithProgramFallback(mA)
      const mint1Resolved = await getMintWithProgramFallback(mB)
      const mint0Info = mint0Resolved.mintInfo
      const mint1Info = mint1Resolved.mintInfo

      const amountForMintA_units = parseHumanAmountToBigInt((baseIsA ? baseAmount : quoteAmount) || '0', mint0Info.decimals)
      const amountForMintB_units = parseHumanAmountToBigInt((baseIsA ? quoteAmount : baseAmount) || '0', mint1Info.decimals)
      const amountA_bn = new anchor.BN(amountForMintA_units.toString())
      const amountB_bn = new anchor.BN(amountForMintB_units.toString())

      let baseInitAmount0: anchor.BN
      let baseInitAmount1: anchor.BN
      if (token0Mint.equals(mA)) {
        baseInitAmount0 = amountA_bn
        baseInitAmount1 = amountB_bn
      } else {
        baseInitAmount0 = amountB_bn
        baseInitAmount1 = amountA_bn
      }
      const openTimeBn = new anchor.BN(openTime)

      const [permissionPda] = await getPermissionPdaAddress(creator, programId)

      // Derive creator ATAs using the SORTED token0Mint/token1Mint with their correctly-detected
      // programs. This is critical for Token-2022 mints: token0AtaCtx must use token0Program
      // (which belongs to the sorted token0Mint), NOT the program resolved from the user-input
      // mA (which may be token1Mint after sorting). Uses the same buildEnsureAtaInstruction
      // pattern as WithdrawForm and DepositForm.
      const creatorToken0AtaCtx = await buildEnsureAtaInstruction({
        payer: creator,
        owner: creator,
        mint: token0Mint,
        tokenProgram: token0Program,
      })
      const creatorToken1AtaCtx = await buildEnsureAtaInstruction({
        payer: creator,
        owner: creator,
        mint: token1Mint,
        tokenProgram: token1Program,
      })
      const creatorToken0Ata = creatorToken0AtaCtx.ata
      const creatorToken1Ata = creatorToken1AtaCtx.ata
      const creatorLpAta = getAssociatedTokenAddressSync(lpMint, creator, false, TOKEN_PROGRAM_ID)

      const ataPreInstructions = [
        ...(creatorToken0AtaCtx.instruction ? [creatorToken0AtaCtx.instruction] : []),
        ...(creatorToken1AtaCtx.instruction ? [creatorToken1AtaCtx.instruction] : []),
      ]

      const accounts: any = {
        ammConfig: amm,
        authority,
        poolState,
        token0Mint,
        token1Mint,
        lpMint,
        token0Vault,
        token1Vault,
        createPoolFee: CREATE_POOL_FEE_RECEIVER,
        observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        token0Program,
        token1Program,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }

      if (isPermissionedMode) {
        accounts.payer = creator
        accounts.creator = creator
        accounts.payerToken0 = creatorToken0Ata
        accounts.payerToken1 = creatorToken1Ata
        accounts.payerLpToken = creatorLpAta
        accounts.permission = permissionPda
      } else {
        accounts.creator = creator
        accounts.creatorToken0 = creatorToken0Ata
        accounts.creatorToken1 = creatorToken1Ata
        accounts.creatorLpToken = creatorLpAta
      }

      if (TEST_MODE) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        setTxResult({
          sig: 'TEST_' + Math.random().toString(36).substring(2, 50).toUpperCase(),
          explorer: '#',
        })
        setStatus(null)
        setBusy(false)
        return
      }

      if (typeof (program.provider as any).wallet.signTransaction === 'function') {
        let initBuilder: any
        if (isPermissionedMode && isWhitelisted) {
          initBuilder = (program as any).methods.initializeWithPermission(
            baseInitAmount0,
            baseInitAmount1,
            openTimeBn,
            { [creatorFeeOn === '0' ? 'bothToken' : creatorFeeOn === '1' ? 'onlyToken0' : 'onlyToken1']: {} }
          ).accounts(accounts).preInstructions(ataPreInstructions)
        } else {
          initBuilder = (program as any).methods.initialize(baseInitAmount0, baseInitAmount1, openTimeBn).accounts(accounts).preInstructions(ataPreInstructions)
        }

        setStatus('Sending transaction...')
        const tx = await initBuilder.transaction()
        tx.feePayer = wallet.publicKey
        const latest = await connection.getLatestBlockhash()
        tx.recentBlockhash = latest.blockhash
        const signedTx = await (wallet as any).signTransaction(tx)
        const raw = signedTx.serialize()
        const sentSig = await connection.sendRawTransaction(raw)
        await connection.confirmTransaction(sentSig)
        setTxResult({ sig: sentSig, explorer: 'https://explorer.solana.com/tx/' + sentSig + '?cluster=devnet' })
        logActivity({
          actionType: 'Pool Creation',
          poolAddress: poolState.toBase58(),
          tokenPair: `${tokenA?.symbol || 'Unknown'}/${tokenB?.symbol || 'Unknown'}`,
          signature: sentSig,
          status: 'success',
        })
        // Invalidate the full pools list since a new pool was created
        invalidatePoolsList(dispatch)
        setBalanceRefetchTrigger(t => t + 1)
        setStatus(null)
        setBusy(false)
        return
      } else {
        setStatus('Sending transaction...')
        let sig: string
        if (isPermissionedMode && isWhitelisted) {
          sig = await (program as any).methods.initializeWithPermission(
            baseInitAmount0,
            baseInitAmount1,
            openTimeBn,
            { [creatorFeeOn === '0' ? 'bothToken' : creatorFeeOn === '1' ? 'onlyToken0' : 'onlyToken1']: {} }
          ).accounts(accounts).preInstructions(ataPreInstructions).rpc()
        } else {
          sig = await (program as any).methods.initialize(baseInitAmount0, baseInitAmount1, openTimeBn).accounts(accounts).preInstructions(ataPreInstructions).rpc()
        }
        setTxResult({ sig, explorer: 'https://explorer.solana.com/tx/' + sig + '?cluster=devnet' })
        logActivity({
          actionType: 'Pool Creation',
          poolAddress: poolState.toBase58(),
          tokenPair: `${tokenA?.symbol || 'Unknown'}/${tokenB?.symbol || 'Unknown'}`,
          signature: sig,
          status: 'success',
        })
        // Invalidate the full pools list since a new pool was created
        invalidatePoolsList(dispatch)
        setBalanceRefetchTrigger(t => t + 1)
        setStatus(null)
        setBusy(false)
        return
      }
    } catch (err: any) {
      logActivity({
        actionType: 'Pool Creation',
        tokenPair: `${tokenA?.symbol || 'Unknown'}/${tokenB?.symbol || 'Unknown'}`,
        status: 'failed',
      })
      await showSendErrorDetails(err, wallet.publicKey ?? undefined)
      setBusy(false)
    }
  }

  return (
    <div className="initialize-page">
      <div className="initialize-layout">
        <div className="initialize-sidebar">
          <button className="initialize-page__back" onClick={() => navigate('/liquidity')}>{'< Back'}</button>

          <aside className="initialize-note">
            <div className="initialize-note__title">
              <span className="initialize-note__icon">!</span> Please Note
            </div>
            <div className="initialize-note__body">
              This tool is for advanced users. For detailed instructions, read the guide for <a className="initialize-link" href="https://docs.raydium.io/raydium/build/developer-guides/clmm/creating-a-pool#creating-a-pool" target="_blank" rel="noreferrer">CLMM</a> or <span className="initialize-link">Standard</span> pools.
            </div>
          </aside>

          <aside className="initialize-balances-card">
            <div className="initialize-balances-card__title">
              <svg className="wallet-icon" viewBox="0 0 24 24" width="14" height="14" style={{ marginRight: '6px' }}>
                <path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2-.9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
              </svg>
              <span>Your Balances</span>
            </div>
            <div className="initialize-balances-card__list">
              <div className="initialize-balances-card__item">
                <span className="initialize-balances-card__item-label">Base Token:</span>
                <span className="initialize-balances-card__item-value">
                  {tokenA ? `${balanceA} ${tokenA.symbol.slice(0, 4).toUpperCase()}` : 'Not Selected'}
                </span>
              </div>
              <div className="initialize-balances-card__item">
                <span className="initialize-balances-card__item-label">Quote Token:</span>
                <span className="initialize-balances-card__item-value">
                  {tokenB ? `${balanceB} ${tokenB.symbol.slice(0, 4).toUpperCase()}` : 'Not Selected'}
                </span>
              </div>
            </div>
          </aside>
        </div>

        <div className="initialize-main">
          <h2 className="initialize-page-title">
            {isPermissionedMode ? 'Initialize CPMM Pool (Creator Fees)' : 'Initialize CPMM Pool'}
          </h2>
          <div className="initialize-page__content">
            <div className="initialize-page__form">
              {checkingWhitelist ? (
                <div className="initialize-card" style={{ textAlign: 'center', padding: '40px' }}>
                  <div className="lp-loading">⏳</div>
                  <p style={{ marginTop: '20px' }}>Verifying whitelist status...</p>
                </div>
              ) : isPermissionedMode && !isWhitelisted ? (
                <div className="initialize-access-denied">
                  <div className="initialize-access-denied__icon">!</div>
                  <div className="initialize-access-denied__content">
                    <div className="initialize-access-denied__title-row">
                      <strong className="initialize-access-denied__title">Access denied</strong>
                      <span className="initialize-access-denied__tag">Creator fees</span>
                    </div>
                    <p className="initialize-access-denied__body">
                      You are not on the whitelist yet. Pool creation with creator fees is limited to approved wallets.
                    </p>
                  </div>
                  <div className="initialize-access-denied__actions">
                    <button
                      className="initialize-btn initialize-btn--primary initialize-access-denied__button"
                      onClick={() => navigate('/liquidity')}
                    >
                      Return to Liquidity
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {txResult && (
                    <TransactionCard
                      status="success"
                      title="Transaction Successful"
                      message="Your pool has been initialized successfully"
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

                  <div className="dex-form-container-card">
                    {/* Initial Liquidity Section */}
                    <div className="dex-liquidity-group">
                      <h4 className="dex-group-title">Initial liquidity</h4>

                      {/* Base Token Card */}
                      <div className={`dex-liquidity-card ${isInsufficientBase ? 'dex-liquidity-card--invalid' : ''}`}>
                        <div className="dex-liquidity-card__top">
                          <span className="dex-liquidity-card__label">Base token</span>
                          <div className="dex-liquidity-card__balance">
                            <svg className="wallet-icon" viewBox="0 0 24 24" width="12" height="12">
                              <path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2-.9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
                            </svg>
                            <span className={`dex-liquidity-card__balance-value ${isInsufficientBase ? 'dex-liquidity-card__balance-value--invalid' : ''}`}>{balanceA}</span>
                            <button type="button" className="balance-pill" onClick={() => setBaseAmount((balanceA * 0.5).toString())}>50%</button>
                            <button type="button" className="balance-pill" onClick={() => setBaseAmount(balanceA.toString())}>Max</button>
                          </div>
                        </div>
                        <div className="dex-liquidity-card__row">
                          {tokenA ? (
                            <div className="dex-token-selected-container">
                              <button type="button" className="dex-token-selector selected" onClick={() => openTokenPicker('mintA')} style={{ ['--token-accent' as any]: tokenA.color }}>
                                <div className="dex-token-icon" style={{ backgroundColor: tokenA.color }}>
                                  {tokenA.symbol.slice(0, 2).toUpperCase()}
                                </div>
                                <span className="dex-token-symbol">{tokenA.symbol.slice(0, 4).toUpperCase()}</span>
                                <svg className="dex-caret-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z" /></svg>
                              </button>
                              <div className="dex-token-mint-subscript">
                                <span className="dex-mint-address">{tokenA.mint}</span>
                                <button
                                  type="button"
                                  className="dex-copy-mint-btn"
                                  title="Copy address"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(tokenA.mint);
                                  }}
                                >
                                  <img src={copyIcon} alt="copy" className="dex-copy-icon" style={{ width: '12px', height: '12px' }} />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" className="dex-token-selector empty" onClick={() => openTokenPicker('mintA')}>
                              <span className="dex-token-symbol">Select Token</span>
                              <svg className="dex-caret-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z" /></svg>
                            </button>
                          )}
                          <div className="dex-amount-container">
                            <input
                              type="text"
                              className="dex-amount-input"
                              value={baseAmount}
                              onChange={e => setBaseAmount(e.target.value)}
                              placeholder="0.00"
                            />
                            <span className="dex-amount-usd">~$0</span>
                          </div>
                        </div>
                      </div>

                      {/* Divider Plus Icon */}
                      <div className="dex-liquidity-divider">
                        <div className="dex-liquidity-divider__circle">
                          <img src={plusIcon} alt="plus" className="dex-plus-icon" />
                        </div>
                      </div>

                      {/* Quote Token Card */}
                      <div className={`dex-liquidity-card ${isInsufficientQuote ? 'dex-liquidity-card--invalid' : ''}`}>
                        <div className="dex-liquidity-card__top">
                          <span className="dex-liquidity-card__label">Quote token</span>
                          <div className="dex-liquidity-card__balance">
                            <svg className="wallet-icon" viewBox="0 0 24 24" width="12" height="12">
                              <path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2-.9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
                            </svg>
                            <span className={`dex-liquidity-card__balance-value ${isInsufficientQuote ? 'dex-liquidity-card__balance-value--invalid' : ''}`}>{balanceB}</span>
                            <button type="button" className="balance-pill" onClick={() => setQuoteAmount((balanceB * 0.5).toString())}>50%</button>
                            <button type="button" className="balance-pill" onClick={() => setQuoteAmount(balanceB.toString())}>Max</button>
                          </div>
                        </div>
                        <div className="dex-liquidity-card__row">
                          {tokenB ? (
                            <div className="dex-token-selected-container">
                              <button type="button" className="dex-token-selector selected" onClick={() => openTokenPicker('mintB')} style={{ ['--token-accent' as any]: tokenB.color }}>
                                <div className="dex-token-icon" style={{ backgroundColor: tokenB.color }}>
                                  {tokenB.symbol.slice(0, 2).toUpperCase()}
                                </div>
                                <span className="dex-token-symbol">{tokenB.symbol.slice(0, 4).toUpperCase()}</span>
                                <svg className="dex-caret-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z" /></svg>
                              </button>
                              <div className="dex-token-mint-subscript">
                                <span className="dex-mint-address">{tokenB.mint}</span>
                                <button
                                  type="button"
                                  className="dex-copy-mint-btn"
                                  title="Copy address"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(tokenB.mint);
                                  }}
                                >
                                  <img src={copyIcon} alt="copy" className="dex-copy-icon" style={{ width: '12px', height: '12px' }} />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" className="dex-token-selector empty" onClick={() => openTokenPicker('mintB')}>
                              <span className="dex-token-symbol">Select Token</span>
                              <svg className="dex-caret-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z" /></svg>
                            </button>
                          )}
                          <div className="dex-amount-container">
                            <input
                              type="text"
                              className="dex-amount-input"
                              value={quoteAmount}
                              onChange={e => setQuoteAmount(e.target.value)}
                              placeholder="0.00"
                            />
                            <span className="dex-amount-usd">~$0</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Fee Tier Selector (Placed below Base/Quote Tokens) */}
                    <div className="dex-form-card">
                      <label className="dex-form-card__label">Fee Tier</label>
                      <div className="dex-select-wrapper">
                        <select
                          className="dex-select-input"
                          value={ammConfig}
                          onChange={e => setAmmConfig(e.target.value)}
                          disabled={loadingConfigs}
                        >
                          {loadingConfigs && <option>Loading...</option>}
                          {configs.map(c => (
                            <option key={c.publicKey.toBase58()} value={c.publicKey.toBase58()}>
                              {(c.tradeFeeRate / 10000).toFixed(2)}%
                              {isPermissionedMode ? ` | Creator ${(c.creatorFeeRate / 10000).toFixed(2)}%` : ''}
                            </option>
                          ))}
                        </select>
                        <svg className="dex-select-caret" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z" /></svg>
                      </div>
                    </div>

                    {/* Price Selector */}
                    <div className="dex-form-card">
                      <div className="dex-form-card__header-row">
                        <label className="dex-form-card__label">Initial Price</label>
                        <button type="button" className="dex-price-toggle-btn" onClick={() => setShowInversePrice(s => !s)}>
                          <img src={showPriceIcon} alt="toggle" className="dex-price-toggle-icon" />
                          <span>Show {showInversePrice ? 'token1/token0' : 'token0/token1'}</span>
                        </button>
                      </div>

                      <div className="dex-price-display-box">
                        {(() => {
                          const aBase = Number(baseAmount || '0')
                          const aQuote = Number(quoteAmount || '0')
                          try {
                            const mA = new PublicKey(mintA)
                            const mB = new PublicKey(mintB)
                            const amountA = baseIsA ? aBase : aQuote
                            const amountB = baseIsA ? aQuote : aBase
                            if (isFinite(amountA) && isFinite(amountB) && amountA > 0 && amountB > 0) {
                              const token0First = Buffer.compare(mA.toBuffer(), mB.toBuffer()) < 0
                              const token0 = token0First ? amountA : amountB
                              const token1 = token0First ? amountB : amountA
                              const price = showInversePrice ? (token0 / token1) : (token1 / token0)
                              return <span className="dex-price-val">{price.toString()}</span>
                            }
                          } catch (e) {
                            if (isFinite(aBase) && isFinite(aQuote) && aBase > 0 && aQuote > 0) {
                              const price = showInversePrice ? (aBase / aQuote) : (aQuote / aBase)
                              return <span className="dex-price-val">{price.toString()}</span>
                            }
                          }
                          return <span className="dex-price-val">-</span>
                        })()}
                        <span className="dex-price-suffix">
                          {(() => {
                            const symbolA = tokenA?.symbol || 'token0'
                            const symbolB = tokenB?.symbol || 'token1'
                            try {
                              const mA = new PublicKey(mintA)
                              const mB = new PublicKey(mintB)
                              const token0First = Buffer.compare(mA.toBuffer(), mB.toBuffer()) < 0
                              const s0 = token0First ? symbolA : symbolB
                              const s1 = token0First ? symbolB : symbolA
                              return showInversePrice ? `${s0}/${s1}` : `${s1}/${s0}`
                            } catch (e) {
                              return showInversePrice ? `${symbolA}/${symbolB}` : `${symbolB}/${symbolA}`
                            }
                          })()}
                        </span>
                      </div>

                      {(() => {
                        const aBase = Number(baseAmount || '0')
                        const aQuote = Number(quoteAmount || '0')
                        if (aBase > 0 && aQuote > 0) {
                          const symbolA = tokenA?.symbol || 'Token A'
                          const symbolB = tokenB?.symbol || 'Token B'
                          const priceVal = (aQuote / aBase)
                          return (
                            <div className="dex-price-current-row">
                              <span>Current price: 1 {symbolA} ≈ {priceVal.toFixed(6)} {symbolB}</span>
                            </div>
                          )
                        }
                        return null
                      })()}
                    </div>

                    {/* Start Time Selector */}
                    <div className="dex-form-card">
                      <label className="dex-form-card__label">Start Time</label>
                      <div className="dex-tabs">
                        <button
                          type="button"
                          className={`dex-tab-btn ${openTime === '0' ? 'active' : ''}`}
                          onClick={() => setOpenTime('0')}
                        >
                          Start Now
                        </button>
                        <button
                          type="button"
                          className={`dex-tab-btn ${openTime !== '0' ? 'active' : ''}`}
                          onClick={() => {
                            if (openTime === '0') {
                              setOpenTime(Math.floor(Date.now() / 1000).toString())
                            }
                          }}
                        >
                          Custom
                        </button>
                      </div>

                      {openTime !== '0' && (
                        <div className="dex-time-picker-panel">
                          <input
                            type="datetime-local"
                            className="dex-time-picker-input"
                            value={getDatetimeLocalValue(openTime)}
                            onChange={e => handleDatetimeLocalChange(e.target.value)}
                          />
                          <div className="dex-time-picker-preview">
                            {(() => {
                              try {
                                const ms = Number(openTime) * 1000
                                if (!isNaN(ms) && ms > 0) {
                                  const date = new Date(ms)
                                  return (
                                    <span className="dex-time-preview-text">
                                      {date.getUTCFullYear()}/
                                      {String(date.getUTCMonth() + 1).padStart(2, '0')}/
                                      {String(date.getUTCDate()).padStart(2, '0')} {' '}
                                      {String(date.getUTCHours()).padStart(2, '0')}:
                                      {String(date.getUTCMinutes()).padStart(2, '0')} (UTC)
                                    </span>
                                  )
                                }
                              } catch (e) { }
                              return <span className="dex-time-preview-text error">Invalid Timestamp</span>
                            })()}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Creator Fee Mode */}
                    {isPermissionedMode && isWhitelisted && (
                      <div className="dex-form-card">
                        <label className="dex-form-card__label">Creator Fee Mode (Whitelisted)</label>
                        <div className="dex-select-wrapper">
                          <select className="dex-select-input" value={creatorFeeOn} onChange={e => setCreatorFeeOn(e.target.value)}>
                            <option value="0">Both Tokens</option>
                            <option value="1">Only Token 0</option>
                            <option value="2">Only Token 1</option>
                          </select>
                          <svg className="dex-select-caret" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z" /></svg>
                        </div>
                      </div>
                    )}

                    <div className="initialize-actions">
                      <button
                        type="button"
                        className="initialize-btn initialize-btn--primary dex-submit-btn"
                        onClick={handleInitialize}
                        disabled={!canSubmitInitialize}
                      >
                        {busy ? 'Processing...' : !wallet.publicKey ? 'Connect Wallet' : (isInsufficientBase || isInsufficientQuote) ? 'Insufficient Balance' : 'Initialize Pool'}
                      </button>
                    </div>

                    <div className="dex-creation-fee-notice">
                      <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" /></svg>
                      <span>Note: A pool creation fee of ~0.2 SOL is required.</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Token Selector Modal Overlay */}
      {tokenPickerFor && (
        <div className="dex-overlay animate-fade-in" onClick={closeTokenPicker}>
          <div className="dex-modal animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="dex-modal__header">
              <h3 className="dex-modal__title">Select a token</h3>
              <button type="button" className="dex-modal__close-btn" onClick={closeTokenPicker}>
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
                </svg>
              </button>
            </div>

            {/* Search Input Box */}
            <div className="dex-modal__search-wrapper">
              <svg className="dex-search-icon" viewBox="0 0 24 24" width="16" height="16">
                <path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
              <input
                className="dex-modal__search-input"
                value={tokenQuery}
                onChange={e => setTokenQuery(e.target.value)}
                placeholder="Search by token or paste address"
                autoFocus
              />
            </div>

            {tokenPickerStatus && (
              <div className="dex-picker-status-error">
                {tokenPickerStatus}
              </div>
            )}


            {/* Main Token List */}
            <div className="dex-modal__list-header">
              <span>Token</span>
              <span>Balance/Address</span>
            </div>

            <div className="dex-modal__list scrollable">
              {tokenSearchResults.length > 0 ? (
                tokenSearchResults.map(token => (
                  <div
                    key={token.mint}
                    className="dex-token-row"
                    onClick={() => applyTokenMint(token.mint)}
                    style={{ ['--token-accent' as any]: token.color }}
                  >
                    <div className="dex-token-row__left">
                      <div className="dex-token-row__badge" style={{ backgroundColor: token.color }}>
                        {token.symbol.slice(0, 1)}
                      </div>
                      <div className="dex-token-row__details">
                        <strong className="dex-token-row__symbol">{token.symbol}</strong>
                        <span className="dex-token-row__name">{token.name}</span>
                      </div>
                    </div>
                    <div className="dex-token-row__right" onClick={e => e.stopPropagation()}>
                      <span className="dex-token-row__balance">0</span>
                      <div className="dex-token-row__address-block">
                        <span className="dex-token-row__address-text">
                          {token.mint.slice(0, 6)}...{token.mint.slice(-6)}
                        </span>
                        {/* Copy button */}
                        <button
                          type="button"
                          className="dex-action-btn"
                          title="Copy address"
                          onClick={() => navigator.clipboard.writeText(token.mint)}
                        >
                          <img src={copyIcon} alt="copy" className="dex-copy-icon" style={{ width: '12px', height: '12px' }} />
                        </button>
                        {/* Link button */}
                        <a
                          href={`https://explorer.solana.com/address/${token.mint}?cluster=devnet`}
                          target="_blank"
                          rel="noreferrer"
                          className="dex-action-btn"
                          title="View on Explorer"
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" /></svg>
                        </a>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="dex-token-empty-state">
                  <span>No tokens found in the local registry.</span>
                </div>
              )}

              {/* Dynamic import button if address is valid and missing */}
              {canAddToken && (
                <div className="dex-import-card">
                  <div className="dex-import-card__body">
                    <span className="dex-import-card__title">Import Custom Token</span>
                    <p className="dex-import-card__desc">This token is not in the local list, but it appears to be a valid Solana address. You can import it on-chain.</p>
                    <span className="dex-import-card__address">{tokenQuery}</span>
                  </div>
                  <button
                    type="button"
                    className="initialize-btn initialize-btn--primary dex-import-btn"
                    onClick={handleAddToken}
                    disabled={addingToken}
                  >
                    {addingToken ? 'Importing...' : 'Import from On-Chain'}
                  </button>
                </div>
              )}
            </div>

            <div className="dex-modal__help-card">
              <span>Can't find the token you're looking for? Try entering the mint address or check token list settings.</span>
            </div>


          </div>
        </div>
      )}
    </div>
  )
}
