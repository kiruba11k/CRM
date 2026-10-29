// Signed-in user + the controlled lists and user directory every screen needs.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, hasToken, setToken, setUnauthorizedHandler } from './api.js'

const SessionCtx = createContext(null)

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: hasToken() ? 'loading' : 'signed-out', user: null, lists: null, users: [], error: '' })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', error: '' }))
    try {
      const [user, lists, users] = await Promise.all([api('/me'), api('/lists'), api('/users')])
      setState({ status: 'ready', user, lists, users, error: '' })
    } catch (e) {
      setState({ status: 'signed-out', user: null, lists: null, users: [], error: e.status === 401 ? '' : e.message })
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setState((s) => ({ ...s, status: 'signed-out', user: null })))
    if (hasToken()) load()
  }, [load])

  const signIn = useCallback((idToken) => { setToken(idToken); load() }, [load])
  const signOut = useCallback(() => {
    setToken(null)
    window.google?.accounts?.id?.disableAutoSelect?.()
    setState({ status: 'signed-out', user: null, lists: null, users: [], error: '' })
  }, [])
  const refreshUsers = useCallback(async () => {
    const users = await api('/users')
    setState((s) => ({ ...s, users }))
  }, [])

  return <SessionCtx.Provider value={{ ...state, signIn, signOut, refreshUsers }}>{children}</SessionCtx.Provider>
}

export const useSession = () => useContext(SessionCtx)

export function useCanEdit(ownerId) {
  const { user } = useSession()
  return !!user && (user.role === 'manager' || user.role === 'admin' || !ownerId || ownerId === user.id)
}
