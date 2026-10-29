// Signed-in user + the controlled lists and user directory every screen needs.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, hasToken, setToken, setUnauthorizedHandler } from './api'
import type { Lists, User } from './types'

type Status = 'loading' | 'ready' | 'signed-out'
interface SessionState { status: Status; user: User | null; lists: Lists | null; users: User[]; error: string }
export interface Session extends SessionState {
  signIn: (idToken: string) => void
  signOut: () => void
  refreshUsers: () => Promise<void>
}
// Screens only render once signed in, so they can rely on user/lists.
export interface ReadySession extends Session { user: User; lists: Lists }

const SessionCtx = createContext<Session | null>(null)
const empty: SessionState = { status: 'signed-out', user: null, lists: null, users: [], error: '' }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ ...empty, status: hasToken() ? 'loading' : 'signed-out' })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', error: '' }))
    try {
      const [user, lists, users] = await Promise.all([api<User>('/me'), api<Lists>('/lists'), api<User[]>('/users')])
      setState({ status: 'ready', user, lists, users, error: '' })
    } catch (e) {
      const err = e as ApiError
      setState({ ...empty, error: err.status === 401 ? '' : err.message })
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setState((s) => ({ ...s, status: 'signed-out', user: null })))
    if (hasToken()) void load()
  }, [load])

  const signIn = useCallback((idToken: string) => { setToken(idToken); void load() }, [load])
  const signOut = useCallback(() => {
    setToken(null)
    window.google?.accounts.id.disableAutoSelect()
    setState(empty)
  }, [])
  const refreshUsers = useCallback(async () => {
    const users = await api<User[]>('/users')
    setState((s) => ({ ...s, users }))
  }, [])

  return <SessionCtx.Provider value={{ ...state, signIn, signOut, refreshUsers }}>{children}</SessionCtx.Provider>
}

export function useSessionState(): Session {
  const s = useContext(SessionCtx)
  if (!s) throw new Error('useSessionState must be used inside <SessionProvider>')
  return s
}

// For screens behind sign-in: user and lists are guaranteed.
export function useSession(): ReadySession {
  const s = useSessionState()
  if (!s.user || !s.lists) throw new Error('useSession() called before sign-in completed')
  return s as ReadySession
}

export function useCanEdit(ownerId: string | null | undefined): boolean {
  const { user } = useSession()
  return user.role === 'manager' || user.role === 'admin' || !ownerId || ownerId === user.id
}
