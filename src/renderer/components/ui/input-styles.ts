/**
 * Shared <input> base classes used by TextField / NumberField.
 * Tweak here and every form input picks it up.
 */
export const INPUT_CLASS =
  'rounded border border-field-line bg-canvas px-2 py-1.5 text-sm placeholder-fg-subtle focus:border-field-focus focus:outline-hidden disabled:opacity-50'

/**
 * The standard control height, for a field that holds ONE line — it also keeps
 * a button beside such a field the same height. A field that holds several
 * lines (a prompt, a list of arguments) must not take this: it is sized by its
 * rows instead, so its content is what decides how tall it stands.
 */
export const INPUT_LINE_CLASS = `h-9 ${INPUT_CLASS}`
