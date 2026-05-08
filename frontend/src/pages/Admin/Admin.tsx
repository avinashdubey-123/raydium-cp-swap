import React, { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import useProgram from '../../utils/useProgram'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import { getAmmConfigAddress, getPermissionPdaAddress } from '../../utils/pda'
import './Admin.css'

const ADMIN_ID = new PublicKey('wE2EtwuovRxvXZoThsXhRTuCrFdAA1jTbLnJp9nfezL')

const Admin = () => {
  const program = useProgram()
  const wallet = useWallet()
  const navigate = useNavigate()
  const location = useLocation()
  const [activeTab, setActiveTab] = useState<'configs' | 'whitelist' | 'fees' | 'pools'>(
    (location.state as any)?.activeTab || 'configs'
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [txResult, setTxResult] = useState<{ sig: string; explorer: string } | null>(null)

  const [configs, setConfigs] = useState<any[]>([])
  const [whitelist, setWhitelist] = useState<any[]>([])
  const [pools, setPools] = useState<any[]>([])

  // Form states
  const [configIndex, setConfigIndex] = useState('0')
  const [tradeFee, setTradeFee] = useState('2500')
  const [protocolFee, setProtocolFee] = useState('120000')
  const [fundFee, setFundFee] = useState('40000')
  const [createPoolFee, setCreatePoolFee] = useState('0')
  const [creatorFee, setCreatorFee] = useState('0')

  const [whitelistOwner, setWhitelistOwner] = useState('')

  const [expandedPools, setExpandedPools] = useState<Set<string>>(new Set())
  const [poolStatusChanges, setPoolStatusChanges] = useState<Record<string, number>>({})

  const [expandedConfigs, setExpandedConfigs] = useState<Set<string>>(new Set())
  const [updateParams, setUpdateParams] = useState<Record<string, string>>({})
  const [updateValues, setUpdateValues] = useState<Record<string, string>>({})

  const fetchData = async () => {
    if (!program) return
    setLoading(true)
    try {
      // Fetch Configs
      const configNamespace = (program.account as any).ammConfig
      const loadedConfigs = await configNamespace.all()
      setConfigs(loadedConfigs.map((c: any) => ({ ...c.account, publicKey: c.publicKey })))

      // Fetch Whitelist
      const permissionNamespace = (program.account as any).permission
      const loadedWhitelist = await permissionNamespace.all()
      setWhitelist(loadedWhitelist.map((w: any) => ({ ...w.account, publicKey: w.publicKey })))

      // Fetch Pools
      const poolNamespace = (program.account as any).poolState
      const loadedPools = await poolNamespace.all()
      setPools(loadedPools.map((p: any) => ({ ...p.account, publicKey: p.publicKey })))

    } catch (err: any) {
      console.error('Fetch error:', err)
      setError(err.message || 'Failed to fetch admin data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [program])

  const handleCreateConfig = async () => {
    if (!program || !wallet.publicKey) return
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const index = parseInt(configIndex)
      const [ammConfig] = await getAmmConfigAddress(index, program.programId)

      const sig = await (program.methods as any)
        .createAmmConfig(
          index,
          new anchor.BN(tradeFee),
          new anchor.BN(protocolFee),
          new anchor.BN(fundFee),
          new anchor.BN(createPoolFee),
          new anchor.BN(creatorFee)
        )
        .accounts({
          owner: wallet.publicKey,
          ammConfig,
          systemProgram: SystemProgram.programId,
        })
        .rpc()

      setTxResult({ sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` })
      setSuccess(`Config ${index} created successfully`)
      fetchData()
    } catch (err: any) {
      setError(err.message || 'Failed to create config')
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateAmmConfig = async (configAddr: PublicKey) => {
    if (!program || !wallet.publicKey) return
    const addrStr = configAddr.toBase58()
    const updateParam = updateParams[addrStr] ?? '0'
    const updateValue = updateValues[addrStr] ?? ''

    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const paramNum = parseInt(updateParam)
      let value: any;

      let remainingAccounts = []
      if (paramNum === 3 || paramNum === 4) {
        remainingAccounts.push({
          pubkey: new PublicKey(updateValue),
          isWritable: false,
          isSigner: false,
        })
        value = new anchor.BN(0) // Value is ignored for owner updates in this program
      } else {
        value = new anchor.BN(updateValue)
      }

      const sig = await (program.methods as any)
        .updateAmmConfig(paramNum, value)
        .accounts({
          owner: wallet.publicKey,
          ammConfig: configAddr,
        })
        .remainingAccounts(remainingAccounts)
        .rpc()

      setTxResult({ sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` })
      setSuccess(`Amm Config updated successfully`)
      setUpdateValues(prev => ({ ...prev, [addrStr]: '' }))
      fetchData()
    } catch (err: any) {
      setError(err.message || 'Failed to update config')
    } finally {
      setLoading(false)
    }
  }

  const handleWhitelistUser = async () => {
    if (!program || !wallet.publicKey) return
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const permissionAuthority = new PublicKey(whitelistOwner)
      const [permission] = await getPermissionPdaAddress(permissionAuthority, program.programId)

      const sig = await (program.methods as any)
        .createPermissionPda()
        .accounts({
          owner: wallet.publicKey,
          permissionAuthority,
          permission,
          systemProgram: SystemProgram.programId,
        })
        .rpc()

      setTxResult({ sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` })
      setSuccess(`User ${permissionAuthority.toBase58()} whitelisted`)
      setWhitelistOwner('')
      fetchData()
    } catch (err: any) {
      setError(err.message || 'Failed to whitelist user')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveFromWhitelist = async (user: PublicKey) => {
    if (!program || !wallet.publicKey) return
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const [permission] = await getPermissionPdaAddress(user, program.programId)

      const sig = await (program.methods as any)
        .closePermissionPda()
        .accounts({
          owner: wallet.publicKey,
          permissionAuthority: user,
          permission,
          systemProgram: SystemProgram.programId,
        })
        .rpc()

      setTxResult({ sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` })
      setSuccess(`User ${user.toBase58()} removed from whitelist`)
      fetchData()
    } catch (err: any) {
      setError(err.message || 'Failed to remove user')
    } finally {
      setLoading(false)
    }
  }

  const togglePoolExpansion = (poolAddr: string, currentStatus: number) => {
    const newExpanded = new Set(expandedPools)
    if (newExpanded.has(poolAddr)) {
      newExpanded.delete(poolAddr)
    } else {
      newExpanded.add(poolAddr)
      // Initialize pending status from current status if not already set
      if (poolStatusChanges[poolAddr] === undefined) {
        setPoolStatusChanges(prev => ({ ...prev, [poolAddr]: currentStatus }))
      }
    }
    setExpandedPools(newExpanded)
  }

  const handleBitToggle = (poolAddr: string, bitValue: number) => {
    const currentPending = poolStatusChanges[poolAddr] ?? 0
    const newStatus = currentPending ^ bitValue // Toggle the bit
    setPoolStatusChanges(prev => ({ ...prev, [poolAddr]: newStatus }))
  }

  const handleUpdateStatus = async (pool: any) => {
    if (!program || !wallet.publicKey) return
    const status = poolStatusChanges[pool.publicKey.toBase58()] ?? pool.status
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const sig = await (program.methods as any)
        .updatePoolStatus(status)
        .accounts({
          authority: wallet.publicKey,
          poolState: pool.publicKey
        })
        .rpc()

      setTxResult({ sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` })
      setSuccess(`Pool ${pool.publicKey.toBase58()} status updated to ${status}`)
      fetchData()
    } catch (err: any) {
      setError(err.message || 'Failed to update status')
    } finally {
      setLoading(false)
    }
  }

  const isAdmin = wallet.publicKey?.equals(ADMIN_ID)

  if (!wallet.connected) {
    return <div className="admin-page">Please connect your wallet</div>
  }

  if (!isAdmin && wallet.publicKey) {
    return <div className="admin-page">Access Denied. You are not the admin.</div>
  }

  return (
    <div className="admin-page">
      <div className="admin-hero">
        <h1 className='admin-title'>Admin Dashboard</h1>
        <p>Manage AMM configurations, whitelists, and collect fees.</p>
      </div>

      <div className="admin-tabs">
        <button className={`admin-tab ${activeTab === 'configs' ? 'active' : ''}`} onClick={() => setActiveTab('configs')}>Configs</button>
        <button className={`admin-tab ${activeTab === 'whitelist' ? 'active' : ''}`} onClick={() => setActiveTab('whitelist')}>Whitelist</button>
        <button className={`admin-tab ${activeTab === 'pools' ? 'active' : ''}`} onClick={() => setActiveTab('pools')}>Pools</button>
        <button className={`admin-tab ${activeTab === 'fees' ? 'active' : ''}`} onClick={() => setActiveTab('fees')}>Fees</button>
      </div>

      {(error || status) && !txResult && (
        <TransactionCard
          status={error ? 'error' : 'info'}
          title={error ? 'Error' : 'Status'}
          message={error || status || ''}
          onClose={() => {
            setError(null)
            setStatus(null)
          }}
        />
      )}

      {txResult && (
        <TransactionCard
          status="success"
          title="Transaction Successful"
          message={success || 'Operation completed successfully'}
          explorerUrl={txResult.explorer}
          signature={txResult.sig}
          onClose={() => {
            setTxResult(null)
            setSuccess(null)
          }}
        />
      )}

      {activeTab === 'configs' && (
        <div className="admin-section">
          <h2>Create AMM Config</h2>
          <div className="admin-form">
            <div className="admin-field">
              <label>Index</label>
              <input type="number" value={configIndex} onChange={(e) => setConfigIndex(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Trade Fee Rate (10^-6)</label>
              <input type="number" value={tradeFee} onChange={(e) => setTradeFee(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Protocol Fee Rate (10^-6)</label>
              <input type="number" value={protocolFee} onChange={(e) => setProtocolFee(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Fund Fee Rate (10^-6)</label>
              <input type="number" value={fundFee} onChange={(e) => setFundFee(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Create Pool Fee</label>
              <input type="number" value={createPoolFee} onChange={(e) => setCreatePoolFee(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Creator Fee Rate (10^-6)</label>
              <input type="number" value={creatorFee} onChange={(e) => setCreatorFee(e.target.value)} />
            </div>
          </div>
          <div className="admin-actions">
            <button className="admin-btn admin-btn-primary" onClick={handleCreateConfig} disabled={loading}>Create Config</button>
          </div>

          <h2>Existing Configs</h2>
          <div className="admin-table-container">
          <div className="admin-grid-table">
            <div className="admin-grid-header configs-grid">
              <span className="center">Index</span>
              <span className="center">Trade Fee</span>
              <span className="center">Protocol Fee</span>
              <span className="center">Fund Fee</span>
              <span className="center">Creator Fee</span>
              <span className="center">Protocol Owner</span>
              <span className="center">Fund Owner</span>
              <span className="center">Address</span>
              <span className="center"></span>
            </div>
            {configs.map((c) => {
              const configAddr = c.publicKey.toBase58()
              const isExpanded = expandedConfigs.has(configAddr)

              return (
                <React.Fragment key={configAddr}>
                  <div 
                    className={`admin-grid-row configs-grid ${isExpanded ? 'expanded' : ''}`}
                    onClick={() => {
                      const newExpanded = new Set(expandedConfigs)
                      if (newExpanded.has(configAddr)) newExpanded.delete(configAddr)
                      else newExpanded.add(configAddr)
                      setExpandedConfigs(newExpanded)
                    }}
                  >
                    <div className="admin-grid-cell center">{c.index}</div>
                    <div className="admin-grid-cell center">{c.tradeFeeRate.toString()}</div>
                    <div className="admin-grid-cell center">{c.protocolFeeRate.toString()}</div>
                    <div className="admin-grid-cell center">{c.fundFeeRate.toString()}</div>
                    <div className="admin-grid-cell center">{c.creatorFeeRate?.toString() || '0'}</div>
                    <div className="admin-grid-cell center" title={c.protocolOwner.toBase58()}>{c.protocolOwner.toBase58().slice(0, 8)}...</div>
                    <div className="admin-grid-cell center" title={c.fundOwner.toBase58()}>{c.fundOwner.toBase58().slice(0, 8)}...</div>
                    <div className="admin-grid-cell center" title={configAddr}>{configAddr.slice(0, 8)}...</div>
                    <div className="admin-grid-cell center">
                      <button className="position-expand" type="button">
                        <span className={`position-expand-icon ${isExpanded ? 'open' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="admin-expanded-content">
                      <div className="pool-controls-content">
                        <p className="pool-controls-title">Update Configuration</p>
                        <div className="admin-form" style={{ marginBottom: 0 }}>
                          <div className="admin-field">
                            <label>Parameter</label>
                            <select
                              value={updateParams[configAddr] ?? '0'}
                              onChange={(e) => setUpdateParams(prev => ({ ...prev, [configAddr]: e.target.value }))}
                            >
                              <option value="0">Trade Fee Rate</option>
                              <option value="1">Protocol Fee Rate</option>
                              <option value="2">Fund Fee Rate</option>
                              <option value="3">New Protocol Owner (Address)</option>
                              <option value="4">New Fund Owner (Address)</option>
                            </select>
                          </div>
                          <div className="admin-field">
                            <label>New Value</label>
                            <input
                              type="text"
                              value={updateValues[configAddr] ?? ''}
                              onChange={(e) => setUpdateValues(prev => ({ ...prev, [configAddr]: e.target.value }))}
                              placeholder={(updateParams[configAddr] ?? '0') === '3' || (updateParams[configAddr] ?? '0') === '4' ? 'PublicKey' : 'Value'}
                            />
                          </div>
                        </div>
                        <div className="pool-controls-actions">
                          <button
                            className="admin-btn admin-btn-primary"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleUpdateAmmConfig(c.publicKey)
                            }}
                            disabled={loading || !(updateValues[configAddr])}
                          >
                            Update Field
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </React.Fragment>
              )
            })}
          </div>
          </div>
        </div>
      )}

      {activeTab === 'whitelist' && (
        <div className="admin-section">
          <h2>Whitelist User</h2>
          <div className="admin-form">
            <div className="admin-field">
              <label>User Wallet Address</label>
              <input type="text" value={whitelistOwner} onChange={(e) => setWhitelistOwner(e.target.value)} placeholder="PublicKey" />
            </div>
          </div>
          <div className="admin-actions">
            <button className="admin-btn admin-btn-primary" onClick={handleWhitelistUser} disabled={loading}>Whitelist User</button>
          </div>

          <h2>Whitelisted Users</h2>
          <div className="admin-grid-table">
            <div className="admin-grid-header whitelist-grid">
              <span>User Address</span>
              <span>PDA</span>
              <span className="center">Actions</span>
            </div>
            {whitelist.map((w) => (
              <div className="admin-grid-row whitelist-grid" key={w.publicKey.toBase58()}>
                <div className="admin-grid-cell" title={w.authority.toBase58()}>{w.authority.toBase58().slice(0, 16)}...</div>
                <div className="admin-grid-cell" title={w.publicKey.toBase58()}>{w.publicKey.toBase58().slice(0, 12)}...</div>
                <div className="admin-grid-cell center">
                  <button className="admin-btn admin-btn-secondary" style={{ padding: '6px 16px', fontSize: '11px' }} onClick={() => handleRemoveFromWhitelist(w.authority)} disabled={loading}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'pools' && (
        <div className="admin-section">
          <h2>Pool Status Management</h2>
          <div className="admin-grid-table">
            <div className="admin-grid-header pools-grid">
              <span>Pool Address</span>
              <span className="center">Operations Status</span>
              <span className="center">Config</span>
              <span className="center"></span>
            </div>
            {pools.map((p) => {
              const poolAddr = p.publicKey.toBase58()
              const isExpanded = expandedPools.has(poolAddr)
              const pendingStatus = poolStatusChanges[poolAddr] ?? p.status

              return (
                <React.Fragment key={poolAddr}>
                  <div className={`admin-grid-row pools-grid ${isExpanded ? 'expanded' : ''}`} onClick={() => togglePoolExpansion(poolAddr, p.status)}>
                    <div className="admin-grid-cell" title={poolAddr}>{poolAddr.slice(0, 16)}...</div>
                    <div className="admin-grid-cell center">
                      <div className="admin-pool-status-group">
                        <span className={`status-indicator ${(p.status & 1) === 0 ? 'enabled' : 'disabled'}`}>
                          Dep
                        </span>
                        <span className={`status-indicator ${(p.status & 2) === 0 ? 'enabled' : 'disabled'}`}>
                          Wth
                        </span>
                        <span className={`status-indicator ${(p.status & 4) === 0 ? 'enabled' : 'disabled'}`}>
                          Swp
                        </span>
                      </div>
                    </div>
                    <div className="admin-grid-cell center" title={p.ammConfig.toBase58()}>{p.ammConfig.toBase58().slice(0, 8)}...</div>
                    <div className="admin-grid-cell center">
                      <button
                        className="position-expand"
                        type="button"
                        aria-expanded={isExpanded}
                      >
                        <span className={`position-expand-icon ${isExpanded ? 'open' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="admin-expanded-content">
                      <div className="pool-controls-content">
                        <p className="pool-controls-title">Pool Controls</p>
                        <div className="pool-checkbox-group">
                          <label className="pool-checkbox-label">
                            <input
                              type="checkbox"
                              checked={(pendingStatus & 1) !== 0}
                              onChange={() => handleBitToggle(poolAddr, 1)}
                            />
                            Disable Deposits (1)
                          </label>
                          <label className="pool-checkbox-label">
                            <input
                              type="checkbox"
                              checked={(pendingStatus & 2) !== 0}
                              onChange={() => handleBitToggle(poolAddr, 2)}
                            />
                            Disable Withdrawals (2)
                          </label>
                          <label className="pool-checkbox-label">
                            <input
                              type="checkbox"
                              checked={(pendingStatus & 4) !== 0}
                              onChange={() => handleBitToggle(poolAddr, 4)}
                            />
                            Disable Swaps (4)
                          </label>
                        </div>
                        <div className="pool-status-info">
                          Current Status: <strong>{p.status}</strong>
                          {pendingStatus !== p.status && (
                            <> → New Status: <strong>{pendingStatus}</strong></>
                          )}
                        </div>
                        <div className="pool-controls-actions">
                          <button
                            className="admin-btn admin-btn-primary"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleUpdateStatus(p)
                            }}
                            disabled={loading || pendingStatus === p.status}
                          >
                            Save Changes
                          </button>
                          {pendingStatus !== p.status && (
                            <button
                              className="admin-btn admin-btn-secondary"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPoolStatusChanges(prev => {
                                  const next = { ...prev }
                                  delete next[poolAddr]
                                  return next
                                })
                              }}
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </React.Fragment>
              )
            })}
          </div>
        </div>
      )}

      {activeTab === 'fees' && (
        <div className="admin-section">
          <h2>Collect Protocol/Fund Fees</h2>
          <p className="fees-msg">This section allows collecting fees from specific pools.</p>
          <div className="admin-grid-table">
            <div className="admin-grid-header fees-grid">
              <span>Pool</span>
              <span className="center">Protocol Fees</span>
              <span className="center">Fund Fees</span>
              <span className="center">Actions</span>
            </div>
            {pools.map((p) => (
              <div className="admin-grid-row fees-grid" key={p.publicKey.toBase58()}>
                <div className="admin-grid-cell" title={p.publicKey.toBase58()}>{p.publicKey.toBase58().slice(0, 16)}...</div>
                <div className="admin-grid-cell center">
                  {((Number(p.protocolFeesToken0 || p.protocolFees0 || 0)) / Math.pow(10, p.mint0Decimals || 6)).toFixed(4)} / {((Number(p.protocolFeesToken1 || p.protocolFees1 || 0)) / Math.pow(10, p.mint1Decimals || 6)).toFixed(4)}
                </div>
                <div className="admin-grid-cell center">
                  {((Number(p.fundFeesToken0 || p.fundFees0 || 0)) / Math.pow(10, p.mint0Decimals || 6)).toFixed(4)} / {((Number(p.fundFeesToken1 || p.fundFees1 || 0)) / Math.pow(10, p.mint1Decimals || 6)).toFixed(4)}
                </div>
                <div className="admin-grid-cell center">
                  <div className="admin-actions" style={{ marginTop: 0, justifyContent: 'center' }}>
                    <button className="admin-btn admin-btn-secondary" style={{ padding: '6px 12px', fontSize: '11px' }} onClick={() => {
                      navigate('/admin/collect-fees', {
                        state: {
                          pool: {
                            ...p,
                            publicKey: p.publicKey.toBase58(),
                            ammConfig: p.ammConfig.toBase58(),
                            protocolFees0: p.protocolFeesToken0 || p.protocolFees0,
                            protocolFees1: p.protocolFeesToken1 || p.protocolFees1,
                            fundFees0: p.fundFeesToken0 || p.fundFees0,
                            fundFees1: p.fundFeesToken1 || p.fundFees1
                          },
                          type: 'protocol',
                          fromTab: activeTab
                        }
                      })
                    }} disabled={loading}>Protocol</button>
                    <button className="admin-btn admin-btn-secondary" style={{ padding: '6px 12px', fontSize: '11px' }} onClick={() => {
                      navigate('/admin/collect-fees', {
                        state: {
                          pool: { ...p, publicKey: p.publicKey.toBase58(), ammConfig: p.ammConfig.toBase58() },
                          type: 'fund',
                          fromTab: activeTab
                        }
                      })
                    }} disabled={loading}>Fund</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default Admin
