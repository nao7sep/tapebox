import type { ReactNode } from 'react'

type Props = {
  label: string
  children: ReactNode
}

/** Label wrapper for non-`<input>` controls (radio groups, custom widgets). */
export function Field({ label, children }: Props) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-zinc-400">{label}</div>
      {children}
    </div>
  )
}
