import { configureStore } from '@reduxjs/toolkit'
import { solanaApi } from './solanaApi'

export const store = configureStore({
  reducer: {
    [solanaApi.reducerPath]: solanaApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredPaths: [solanaApi.reducerPath],
      },
    }).concat(solanaApi.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
