import { useEffect, useState } from 'react'
import { DEFAULT_EXCLUDES } from '../data/filters'

interface Props {
  excludes: readonly string[]
  onChange: (next: string[]) => void
}

const toText = (patterns: readonly string[]) => patterns.join('\n')
const toList = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** One path glob per line; applied on blur so typing does not re-derive. */
export function ExcludeEditor({ excludes, onChange }: Props) {
  const [draft, setDraft] = useState(() => toText(excludes))

  // Pick up an external reset without clobbering an edit in progress.
  useEffect(() => {
    setDraft((current) => (toList(current).join('\n') === toText(excludes) ? current : toText(excludes)))
  }, [excludes])

  const isDefault = toText(excludes) === toText(DEFAULT_EXCLUDES)

  return (
    <>
      <h2>
        Excluded paths
        {!isDefault && (
          <button type="button" className="link" onClick={() => onChange([...DEFAULT_EXCLUDES])}>
            reset
          </button>
        )}
      </h2>
      <textarea
        className="excludes"
        spellCheck={false}
        rows={Math.max(3, toList(draft).length + 1)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = toList(draft)
          if (toText(next) !== toText(excludes)) onChange(next)
        }}
      />
    </>
  )
}
