import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// A local process stand-in, limited to the path grammar under test. Matches
// YoutubeDL.get_output_path/_outtmpl_expandpath and utils.expand_path:
// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py
// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/utils/_utils.py
// Expansion flavour is selectable independently of the host's native filesystem;
// this does not model Windows filename sanitation of unsupported trailing spaces.
const windows = process.env.TAPEBOX_TEST_PATH_FLAVOUR === 'windows'
const args = process.argv.slice(2)
const lastOption = (option) => {
  const index = args.lastIndexOf(option)
  return index === -1 ? undefined : args[index + 1]
}

function expandVars(value) {
  if (!windows) {
    // Python posixpath.expandvars replaces matches once; values are not rescanned.
    return value.replace(/\$(?:\{([^}]*)\}|([A-Za-z0-9_]+))/g, (match, braced, plain) => process.env[braced ?? plain] ?? match)
  }
  // Python ntpath additionally expands %name%, preserves single-quoted portions,
  // and treats doubled $/% as literals. Consume only the original input once.
  let result = ''
  for (let i = 0; i < value.length;) {
    const char = value[i]
    if (char === "'") {
      const end = value.indexOf("'", i + 1)
      if (end === -1) return result + value.slice(i)
      result += value.slice(i, end + 1)
      i = end + 1
    } else if ((char === '$' || char === '%') && value[i + 1] === char) {
      result += char
      i += 2
    } else if (char === '%') {
      const end = value.indexOf('%', i + 1)
      if (end === -1) return result + value.slice(i)
      const name = value.slice(i + 1, end)
      result += process.env[name] ?? value.slice(i, end + 1)
      i = end + 1
    } else if (char === '$' && value[i + 1] === '{') {
      const end = value.indexOf('}', i + 2)
      if (end === -1) return result + value.slice(i)
      const name = value.slice(i + 2, end)
      result += process.env[name] ?? value.slice(i, end + 1)
      i = end + 1
    } else if (char === '$') {
      const name = /^[A-Za-z0-9_-]+/.exec(value.slice(i + 1))?.[0]
      if (name) {
        result += process.env[name] ?? '$' + name
        i += name.length + 1
      } else {
        result += char
        i++
      }
    } else {
      result += char
      i++
    }
  }
  return result
}

function expandPath(value) {
  // expanduser runs before expandvars, never on a value inserted from env.
  const expandedUser = value.startsWith('~/')
    ? join(process.env.TAPEBOX_TEST_EXPANSION_HOME, value.slice(2))
    : value
  return expandVars(expandedUser)
}

function outputName(template, ext) {
  const separator = 'TapeBoxFixtureEscapedPair'
  const protectedPairs = template.replaceAll('%%', '%' + separator + '%').replaceAll('$$', '$' + separator + '$')
  const expanded = expandPath(protectedPairs).replaceAll(separator, '')
  return expanded.replace(/%%|%\(([^)]*)\)s/g, (match, field) => {
    if (match === '%%') return '%'
    return ({ title: 'Unrelated', ext })[field] ?? 'NA'
  })
}

try {
  const home = args.flatMap((arg, i) => arg === '--paths' && args[i + 1]?.startsWith('home:') ? [args[i + 1].slice(5)] : []).at(-1) ?? ''
  const directory = resolve(expandPath(home.trim()))
  const template = lastOption('--output')
  const url = args.at(-1)
  // An intentionally authored relative cookie path still resolves from the
  // inherited app cwd, and intentionally authored env references still expand.
  const cookies = lastOption('--cookies')
  if (cookies && readFileSync(resolve(expandPath(cookies)), 'utf8') !== 'fixture cookie file') throw new Error('cookie option changed')
  const header = lastOption('--add-header')
  process.stdout.write('[fixture] ' + JSON.stringify({ cwd: process.cwd(), pid: process.pid, cookies, header, url }) + '\n')
  const write = (ext, data) => {
    // Python os.path.join discards home when the expanded filename is absolute.
    // For relative filenames, this has the same target as joining our absolute home.
    const path = resolve(directory, outputName(template, ext))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    return path
  }
  if (args.includes('--skip-download')) {
    const result = process.env.TAPEBOX_TEST_THUMBNAIL_RESULT
    if (result === 'missing') {
      process.stderr.write('WARNING: no thumbnail available\n')
    } else {
      const raw = write('webp', 'raw poster')
      process.stdout.write('[info] Writing video thumbnail to: ' + raw + '\n')
      if (result === 'fail') {
        process.stderr.write('ERROR: fixture thumbnail failure\n')
        process.exitCode = 1
      } else if (result === 'park') {
        setInterval(() => {}, 1000)
      }
    }
  } else {
    const mediaPath = write('mp4', 'fixture media')
    write('info.json', JSON.stringify({ url }))
    if (args.includes('--write-thumbnail')) write('webp', 'raw poster')
    process.stdout.write('tapebox-final-filepath:' + mediaPath + '\n')
  }
} catch (err) {
  process.stderr.write(String(err) + '\n')
  process.exitCode = 1
}
