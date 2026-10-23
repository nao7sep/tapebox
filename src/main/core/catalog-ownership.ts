import { TRACKED_FILENAME_FIELDS, type Tape } from '@shared/domain'
import { portableFilenameIdentity } from '@shared/filename'
import { SourceIndex, tapeSourceRef, type SourceRef } from '@shared/source-identity'

type Owners = Map<string, Set<string>>
const ownerExcept = (owners: Set<string> | undefined, except?: string) => {
  if (owners) for (const owner of owners) if (owner !== except) return owner
  return undefined
}
function prefixes(name: string): string[] {
  const result: string[] = []
  for (let at = name.indexOf('.'); at !== -1; at = name.indexOf('.', at + 1)) result.push(name.slice(0, at))
  return result
}
function change(index: Owners, key: string, owner: string, add: boolean): void {
  if (add) {
    let owners = index.get(key)
    if (!owners) index.set(key, owners = new Set())
    owners.add(owner)
  } else {
    const owners = index.get(key)
    owners?.delete(owner)
    if (owners?.size === 0) index.delete(key)
  }
}

/** Derived live ownership. Dot prefixes reserve download namespaces without
 * scanning unrelated tapes, and sets preserve overlapping historical owners. */
export class CatalogOwnership {
  private readonly names: Owners = new Map()
  private readonly stems: Owners = new Map()
  private readonly belowStem: Owners = new Map()
  private readonly sources = new SourceIndex()

  constructor(tapes: readonly Tape[] = []) { for (const tape of tapes) this.replace(undefined, tape) }

  replace(previous: Tape | undefined, next?: Tape): void {
    if (previous) this.update(previous, false)
    if (next) this.update(next, true)
    if (!previous || !next || previous.sourceUrl !== next.sourceUrl || previous.extractor !== next.extractor || previous.sourceId !== next.sourceId) {
      if (previous) this.sources.remove(tapeSourceRef(previous), previous.id)
      if (next) this.sources.add(tapeSourceRef(next), next.id)
    }
  }

  private update(tape: Tape, add: boolean): void {
    const names = new Set(TRACKED_FILENAME_FIELDS.flatMap((field) => tape[field] === null ? [] : [portableFilenameIdentity(tape[field]!)]))
    const stem = portableFilenameIdentity(tape.id)
    const below = new Set([...names].flatMap(prefixes).concat(prefixes(stem)))
    for (const name of names) change(this.names, name, tape.id, add)
    change(this.stems, stem, tape.id, add)
    for (const prefix of below) change(this.belowStem, prefix, tape.id, add)
  }

  filenameOwner(name: string, except?: string): string | undefined {
    const identity = portableFilenameIdentity(name)
    return ownerExcept(this.names.get(identity), except) ?? this.ancestorOwner(identity, except)
  }

  stemOwner(stem: string, except?: string): string | undefined {
    const identity = portableFilenameIdentity(stem)
    return ownerExcept(this.stems.get(identity), except) ?? ownerExcept(this.belowStem.get(identity), except) ?? this.ancestorOwner(identity, except)
  }

  sourceOwner(ref: SourceRef, except?: string): string | undefined { return this.sources.find(ref, except) }

  private ancestorOwner(name: string, except?: string): string | undefined {
    for (const prefix of prefixes(name)) {
      const owner = ownerExcept(this.stems.get(prefix), except)
      if (owner !== undefined) return owner
    }
    return undefined
  }
}
