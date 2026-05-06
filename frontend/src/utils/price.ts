import { MOCK_PRICES } from '../mocks/prices'

export function getPriceUsd(symbol: string | undefined): number | null {
  if (!symbol) return null
  return MOCK_PRICES[symbol] ?? null
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—'          // clear fallback for missing price
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}