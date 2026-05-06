import './Header.css'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { NavLink } from 'react-router-dom'
import raydiumLogo from '../../assets/raydium-logo.svg'

export default function Header() {

return (
    <header className="rcs-header">
        <NavLink to='/' className="rcs-logo">
          <img src={raydiumLogo} />
        </NavLink>
        <nav className="rcs-nav">
          <NavLink to='/' className="rcs-nav__item">Swap</NavLink>
          <NavLink to='/liquidity' className="rcs-nav__item">Liquidity</NavLink>
          <NavLink to='/Portfolio' className="rcs-nav__item">Portfolio</NavLink>
        </nav>
        <div className="rcs-actions">
          <WalletMultiButton />
        </div>
    </header>
  )
}
