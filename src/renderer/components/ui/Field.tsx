import type { ReactNode } from 'react'

type Props = {
  label: string
  children: ReactNode
  htmlFor?: string
}

/** Label wrapper for non-`<input>` controls (radio groups, custom widgets). */
export function Field({ label, children, htmlFor }: Props) {
  return (
    <div>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-fg">{label}</label>
      ) : (
        <div className="mb-1 text-xs font-medium text-fg">{label}</div>
      )}
      {children}
    </div>
  )
}
