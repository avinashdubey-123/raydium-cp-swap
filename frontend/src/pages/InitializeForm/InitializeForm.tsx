import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useProgram from '../../utils/useProgram'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
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
} from '../../utils/pda'

const DEFAULT_AMM = ''
const DEFAULT_MINT_A = ''
const DEFAULT_MINT_B = ''
const DEFAULT_CREATE_POOL_FEE = ''
const DEFAULT_AMOUNT = '1000'
const DEFAULT_OPEN_TIME = '0'

import './InitializeForm.css'
import showPriceIcon from '../../assets/show-price.svg'

export default function InitializeForm() {
  const navigate = useNavigate()
  const program = useProgram()
  const { connection } = useConnection()
  const wallet = useWallet()

  const [ammConfig, setAmmConfig] = useState(DEFAULT_AMM)
  const [mintA, setMintA] = useState(DEFAULT_MINT_A)
  const [mintB, setMintB] = useState(DEFAULT_MINT_B)
  const [createPoolFee, setCreatePoolFee] = useState(DEFAULT_CREATE_POOL_FEE)
  const [baseAmount, setBaseAmount] = useState(DEFAULT_AMOUNT)
  const [quoteAmount, setQuoteAmount] = useState(DEFAULT_AMOUNT)
  const [openTime, setOpenTime] = useState(DEFAULT_OPEN_TIME)
  const [status, setStatus] = useState<string | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInversePrice, setShowInversePrice] = useState(false)
  const baseIsA = true
  
  // ✅ TEST MODE: Set to false for real transactions
  const TEST_MODE = true

  async function detectTokenProgram(mint: PublicKey) {
    const info = await connection.getAccountInfo(mint)
    if (!info) throw new Error('Mint not found: ' + mint.toBase58())
    if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
    throw new Error('Unsupported mint owner: ' + info.owner.toBase58())
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
              setTxResult({ sig: latestSig, explorer: 'https://explorer.solana.com/tx/' + latestSig + '?cluster=devnet' })
              setStatus('Transaction executed successfully.')
              return
            }
          } catch (e) {}
        }
        setStatus('Transaction appears already processed; it likely executed successfully.')
        return
      }
    } catch (e) {}
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

  async function handleInitialize() {
    if (!program) return setStatus('Program not ready')
    if (!wallet.publicKey) return setStatus('Connect wallet')
    if (busy) return
    setBusy(true)
    try {
      console.log('Initialize Liquidity Pool clicked')
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
      const [lpMint] = await getPoolLpMintAddress(poolState, programId)
      const [token0Vault] = await getPoolVaultAddress(poolState, token0Mint, programId)
      const [token1Vault] = await getPoolVaultAddress(poolState, token1Mint, programId)
      const [observationState] = await getOrcleAccountAddress(poolState, programId)

      const mint0Info = await getMint(connection, mA)
      const mint1Info = await getMint(connection, mB)
      const mult0 = BigInt(10) ** BigInt(mint0Info.decimals)
      const mult1 = BigInt(10) ** BigInt(mint1Info.decimals)
      const amountForMintA_units = BigInt((baseIsA ? baseAmount : quoteAmount) || '0') * mult0
      const amountForMintB_units = BigInt((baseIsA ? quoteAmount : baseAmount) || '0') * mult1
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

      setStatus('Preparing initialize transaction...')
      const accounts: any = {
        creator,
        ammConfig: amm,
        authority,
        poolState,
        token0Mint,
        token1Mint,
        lpMint,
        creatorToken0: getAssociatedTokenAddressSync(token0Mint, creator, false, token0Program),
        creatorToken1: getAssociatedTokenAddressSync(token1Mint, creator, false, token1Program),
        creatorLpToken: getAssociatedTokenAddressSync(lpMint, creator, false, TOKEN_PROGRAM_ID),
        token0Vault,
        token1Vault,
        createPoolFee: new PublicKey(createPoolFee),
        observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        token0Program,
        token1Program,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }

      if (TEST_MODE) {
        // ✅ Simulate successful transaction
        await new Promise(resolve => setTimeout(resolve, 1500))
        setTxResult({ 
          sig: 'TEST_' + Math.random().toString(36).substring(2, 50).toUpperCase(), 
          explorer: '#' 
        })
        setStatus(null)
        setBusy(false)
        return
      }
      
      if (typeof (program.provider as any).wallet.signTransaction === 'function') {
        const initBuilder = (program as any).methods.initialize(baseInitAmount0, baseInitAmount1, openTimeBn).accounts(accounts)
        const tx = await initBuilder.transaction()
        tx.feePayer = wallet.publicKey
        const latest = await connection.getLatestBlockhash()
        tx.recentBlockhash = latest.blockhash
        const signedTx = await (wallet as any).signTransaction(tx)
        const raw = signedTx.serialize()
        const sentSig = await connection.sendRawTransaction(raw)
        await connection.confirmTransaction(sentSig)
        setTxResult({ sig: sentSig, explorer: 'https://explorer.solana.com/tx/' + sentSig + '?cluster=devnet' })
        setStatus(null)
        setBusy(false)
        return
      } else {
        const sig = await (program as any).methods.initialize(baseInitAmount0, baseInitAmount1, openTimeBn).accounts(accounts).rpc()
        setTxResult({ sig, explorer: 'https://explorer.solana.com/tx/' + sig + '?cluster=devnet' })
        setStatus(null)
        setBusy(false)
        return
      }
    } catch (err: any) {
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
        </div>

        <div className="initialize-main">
          <h2 className="initialize-page-title">Initialize CPMM pool</h2>
          <div className="initialize-page__content">
            <div className="initialize-page__form">
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
              onClose={() => {
                setStatus(null)
                setErrorDetails(null)
              }}
            />
          )}
          

          <div className="initialize-card">
            <div className="initialize-card__header">
              <div className="initialize-subtitle">Initial liquidity</div>
            </div>
            <div className="initialize-field">
              <label className="initialize-label">Initialize config</label>
              <input className="initialize-input" value={ammConfig} onChange={e => setAmmConfig(e.target.value)} placeholder="AMM config pubkey" />
            </div>
            <div className="initialize-liquidity">
              <div className="initialize-liquidity__section">
                <div className="initialize-liquidity__header">
                  <span>Base token</span>
                </div>
                <div className="initialize-field">
                  <label className="initialize-label">Base token mint</label>
                  <input className="initialize-input" value={mintA} onChange={e => setMintA(e.target.value)} placeholder="Mint A pubkey" />
                </div>
                <div className="initialize-field">
                  <label className="initialize-label">Base token amount</label>
                  <input className="initialize-input" value={baseAmount} onChange={e => setBaseAmount(e.target.value)} />
                </div>
              </div>
              <div className="initialize-divider" aria-hidden="true">+</div>
              <div className="initialize-liquidity__section">
                <div className="initialize-liquidity__header">
                  <span>Quote token</span>
                </div>
                <div className="initialize-field">
                  <label className="initialize-label">Quote token mint</label>
                  <input className="initialize-input" value={mintB} onChange={e => setMintB(e.target.value)} placeholder="Mint B pubkey" />
                </div>
                <div className="initialize-field">
                  <label className="initialize-label">Quote token amount</label>
                  <input className="initialize-input" value={quoteAmount} onChange={e => setQuoteAmount(e.target.value)} />
                </div>
              </div>
            </div>
            <div className="initialize-field">
              <label className="initialize-label">Initial price</label>
              <div className="initialize-price" title="Initial price">
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
                      return <span className="initialize-price__text">{price.toString()}</span>
                    }
                  } catch (e) {
                    if (isFinite(aBase) && isFinite(aQuote) && aBase > 0 && aQuote > 0) {
                      const price = showInversePrice ? (aBase / aQuote) : (aQuote / aBase)
                      return <span className="initialize-price__text">{price.toString()}</span>
                    }
                  }
                  return <span className="initialize-price__text">-</span>
                })()}
                <span className="initialize-price__suffix">{showInversePrice ? 'token0/token1' : 'token1/token0'}</span>
              </div>
              <div className="initialize-price-toggle">
                <button className="initialize-price-toggle__btn" onClick={() => setShowInversePrice(s => !s)}>
                  <img src={showPriceIcon} alt="toggle" className="initialize-price-toggle__icon" />
                </button>
                <span className="initialize-price-toggle__text">{showInversePrice ? 'Show token1/token0' : 'Show token0/token1'} Initial price</span>
              </div>
            </div>
            <div className="initialize-field">
              <label className="initialize-label">Creation fee account</label>
              <input className="initialize-input" value={createPoolFee} onChange={e => setCreatePoolFee(e.target.value)} placeholder="create pool fee account" />
            </div>
            <div className="initialize-field initialize-field--compact">
              <label className="initialize-label">Start time (unix)</label>
              <input className="initialize-input" value={openTime} onChange={e => setOpenTime(e.target.value)} placeholder="0" />
            </div>

            <div className="initialize-actions">
              <button type="button" className="initialize-btn initialize-btn--primary" onClick={handleInitialize} disabled={busy}>
                {busy ? 'Processing...' : 'Initialize Pool'}
              </button>
            </div>
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}