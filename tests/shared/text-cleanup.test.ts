import { describe, expect, it } from 'vitest'
import { multiline, singleLine } from '@shared/text-cleanup'

// The reference cases of the text-cleanup-conventions for the two patterns used here.
describe('singleLine', () => {
  it.each([
    ['  hello  ', {}, 'hello'],
    ['a\nb', {}, 'a b'],
    ['aaa\n \n\nbbb', {}, 'aaa bbb'],
    ['a    b', {}, 'a    b'],
    ['a    b', { minify: true }, 'a b'],
    ['a　　b', { minify: true }, 'a b'],
    ['a　b', {}, 'a　b'],
    ['  a\nb  ', { flattenLineBreaks: false }, 'a\nb'],
    ['\n\n  \n', {}, ''],
  ])('%j with %j', (text, opts, expected) => {
    expect(singleLine(text, opts)).toBe(expected)
  })
})

describe('multiline', () => {
  it.each([
    ['\n\n  hello  \n\n', {}, '  hello'],
    ['a  \nb  ', {}, 'a\nb'],
    ['a  \nb  ', { trimLineEnds: false }, 'a  \nb  '],
    ['a\n\n\nb', {}, 'a\n\n\nb'],
    ['a\n\n\nb', { collapseBlankLines: true }, 'a\n\nb'],
    ['a\r\nb\r\nc', {}, 'a\nb\nc'],
    ['a\n   \nb', {}, 'a\n\nb'],
    ['   \n   ', {}, ''],
    ['  indented\n    more', {}, '  indented\n    more'],
  ])('%j with %j', (text, opts, expected) => {
    expect(multiline(text, opts)).toBe(expected)
  })
})
