export function formatAmount(value: number | string | null | undefined, maxDecimals = 6): string {
  if (value == null || value === '') return '-'
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return '-'
  const fixed = num.toFixed(maxDecimals)
  const trimmed = fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
  return trimmed
}

export function formatPercent(value: number | string | null | undefined, maxDecimals = 2): string {
  if (value == null || value === '') return '-'
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return '-'
  return `${formatAmount(num, maxDecimals)}%`
}
