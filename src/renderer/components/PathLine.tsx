/** Where a path's final segment starts: after its last separator, ignoring a trailing one. */
export function finalSegmentStart(path: string): number {
  const end = path.replace(/[\\/]+$/, '').length
  return Math.max(path.lastIndexOf('/', end - 1), path.lastIndexOf('\\', end - 1)) + 1
}

/**
 * A path or URL on one line that keeps its final segment and loses its middle
 * (interface-styling-conventions, Labels): the beginning is usually shared, the end
 * tells items apart. The leading part shrinks first and ends in an ellipsis; a final
 * segment wider than the line ends in one too. The caller provides the complete
 * value elsewhere, by keyboard and touch.
 */
export function PathLine({ value, className = '' }: { value: string; className?: string }) {
  const cut = finalSegmentStart(value)
  return (
    <span className={`flex min-w-0 whitespace-nowrap ${className}`} data-literal>
      <span className="min-w-0 truncate">{value.slice(0, cut)}</span>
      <span className="max-w-full shrink-0 truncate">{value.slice(cut)}</span>
    </span>
  )
}
