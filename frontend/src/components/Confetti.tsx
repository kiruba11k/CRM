// A short, small celebration when a deal is won. Pure CSS; hidden for
// people who ask their system for reduced motion.
import { useMemo } from 'react'

const COLORS = ['#4F46E5', '#16A34A', '#F59E0B', '#EC4899', '#06B6D4', '#A855F7']

export default function Confetti({ burst }: { burst: number }) {
  const pieces = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    x: Math.round(Math.cos((i / 36) * Math.PI * 2) * (120 + (i * 37) % 160)),
    y: Math.round(Math.sin((i / 36) * Math.PI * 2) * (90 + (i * 53) % 140)) - 60,
    r: (i * 47) % 360,
    c: COLORS[i % COLORS.length],
    d: (i % 6) * 25,
  })), [burst]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!burst) return null
  return (
    <div className="confetti" aria-hidden="true" key={burst}>
      {pieces.map((p, i) => (
        <span key={i} style={{ ['--x' as string]: `${p.x}px`, ['--y' as string]: `${p.y}px`, ['--r' as string]: `${p.r}deg`, background: p.c, animationDelay: `${p.d}ms` }} />
      ))}
    </div>
  )
}
