/**
 * Two thin bars sharing a look. ProgressBar fills to a known percent;
 * IndeterminateBar sweeps a segment back and forth to say "still working"
 * honestly, without claiming a percentage.
 */

export function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className="h-0.5 w-full overflow-hidden rounded bg-zinc-800">
      <div className="h-full rounded bg-zinc-200 transition-all" style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function IndeterminateBar() {
  return (
    <div className="h-0.5 w-full overflow-hidden rounded bg-zinc-800">
      <div
        className="h-full w-1/3 rounded bg-zinc-200"
        style={{ animation: 'tapebox-indeterminate 1.15s ease-in-out infinite' }}
      />
    </div>
  )
}
