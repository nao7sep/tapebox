import { describe, expect, it } from 'vitest'
import { finalSegmentStart } from '@renderer/components/PathLine'

describe('a path\'s final segment', () => {
  it.each([
    ['https://example.test/a/b/watch?v=1', 'watch?v=1'],
    ['/Users/me/Movies/clip.mp4', 'clip.mp4'],
    ['C:\\Users\\me\\Videos\\clip.mp4', 'clip.mp4'],
    ['/Users/me/Movies/', 'Movies/'],
    ['clip.mp4', 'clip.mp4'],
  ])('of %s is %s', (path, segment) => {
    expect(path.slice(finalSegmentStart(path))).toBe(segment)
  })
})
