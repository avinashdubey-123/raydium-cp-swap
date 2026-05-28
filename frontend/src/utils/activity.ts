export interface ActivityItem {
  id: string
  actionType: 'Deposit' | 'Withdraw' | 'Swap' | 'Pool Creation' | 'Fee Collection'
  poolAddress?: string
  tokenPair: string
  timestamp: number
  signature?: string
  status: 'success' | 'failed'
}

const STORAGE_KEY = 'raydium_cp_session_activity'

export const logActivity = (item: Omit<ActivityItem, 'id' | 'timestamp'>) => {
  try {
    const sessionItems = sessionStorage.getItem(STORAGE_KEY)
    const list: ActivityItem[] = sessionItems ? JSON.parse(sessionItems) : []
    const newItem: ActivityItem = {
      ...item,
      id: item.signature || Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
    }
    list.unshift(newItem)
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (e) {
    console.error('Failed to log activity:', e)
  }
}

export const getActivities = (): ActivityItem[] => {
  try {
    const sessionItems = sessionStorage.getItem(STORAGE_KEY)
    return sessionItems ? JSON.parse(sessionItems) : []
  } catch (e) {
    console.error('Failed to get activity log:', e)
    return []
  }
}
