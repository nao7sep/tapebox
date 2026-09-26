import { app, ipcMain, systemPreferences } from 'electron'
import { readFileSync } from 'node:fs'
import {
  chromiumLocale,
  effectiveLanguage,
  formattingLocale,
  resolveComputerLanguage,
  type Language,
  type LanguageEnvironment,
  type LanguagePreference,
} from '@shared/i18n/languages'
import { createTranslator, type Translator } from '@shared/i18n/translate'
import { LANGUAGE_ENVIRONMENT_CHANNEL } from '@shared/i18n/environment'
import { describeError } from '@shared/error'
import { readSavedLanguagePreference } from './core/saved-language'
import { installApplicationMenu } from './menu'
import { log } from './io/logger'
import { paths } from './paths'

/**
 * The main process's half of the interface language (localization-conventions).
 * It reads the saved choice before the app is ready and the computer's
 * languages once it is, draws its own surfaces (the menu, the recovery dialogs,
 * the file dialogs' filters, the text it sends the window) from the shared
 * catalogues, hands each window what it needs to agree, and follows a choice
 * saved in Settings.
 */

let systemLanguage: Language = 'en'
let systemLocale: string | null = null
let preference: LanguagePreference = 'system'

function readConfigText(): string | null {
  try {
    return readFileSync(paths.config, 'utf8')
  } catch {
    return null
  }
}

// macOS draws some menu items itself (Emoji & Symbols, Start Dictation, AutoFill,
// Writing Tools, Services) in the language AppKit settles on before any
// JavaScript runs, from AppleLanguages. Electron offers no volatile argument
// domain, so TapeBox keeps the interface language in its own defaults domain
// (never the global one), as macOS's own per-app language setting does: AppKit,
// and Chromium's own strings, pick it up at the next launch, which the
// conventions allow for a language saved mid-session. System removes the entry,
// so the computer's own list applies again. Only the packaged app does this:
// an unpackaged run shares the Electron runtime's own domain with every other
// app in development.
const APPLE_LANGUAGES = 'AppleLanguages'

function ownsAppKitLanguages(): boolean {
  return process.platform === 'darwin' && app.isPackaged
}

function computerLanguages(): string[] {
  if (ownsAppKitLanguages()) {
    // The entry this app wrote shadows the computer's list; clear it first so
    // System reads what the computer prefers, then write it back below.
    systemPreferences.removeUserDefault(APPLE_LANGUAGES)
  }
  return app.getPreferredSystemLanguages()
}

function alignAppKit(next: LanguagePreference): void {
  if (!ownsAppKitLanguages()) return
  try {
    if (next === 'system') systemPreferences.removeUserDefault(APPLE_LANGUAGES)
    else systemPreferences.setUserDefault(APPLE_LANGUAGES, 'array', [next])
  } catch (error) {
    log.warn('AppKit language could not be recorded', { error: describeError(error) })
  }
}

/**
 * Before the app is ready: read the saved choice, and point Chromium's own
 * strings (the video player's controls) at an explicit one; System leaves them
 * to the computer, as it leaves AppKit.
 */
export function settleLanguageBeforeReady(): void {
  preference = readSavedLanguagePreference(readConfigText())
  if (preference !== 'system') app.commandLine.appendSwitch('lang', chromiumLocale(preference))
}

/**
 * Once ready, before any window or menu exists: read the computer's languages
 * and regional format, record the choice for AppKit's next launch, and install
 * the menu, so even a failure to load settings shows it in the saved language.
 */
export function settleLanguageWhenReady(): void {
  systemLanguage = resolveComputerLanguage(computerLanguages())
  systemLocale = app.getSystemLocale() || null
  alignAppKit(preference)
  installApplicationMenu(mainTranslator())
}

export function currentLanguage(): Language {
  return effectiveLanguage(preference, systemLanguage)
}

/** Text main draws itself: the menu, the recovery dialogs. */
export function mainTranslator(): Translator {
  const language = currentLanguage()
  return createTranslator(language, formattingLocale(language, systemLocale))
}

/** Follow the saved choice: at launch once settings load, and on every Save. */
export function applyLanguagePreference(next: LanguagePreference): void {
  if (next !== preference) {
    preference = next
    alignAppKit(next)
  }
  installApplicationMenu(mainTranslator())
}

export function languageEnvironment(): LanguageEnvironment {
  return { preference, systemLanguage, systemLocale }
}

/** A window's preload reads the environment synchronously, before it draws. */
export function registerLanguageHandlers(): void {
  ipcMain.on(LANGUAGE_ENVIRONMENT_CHANNEL, (event) => {
    event.returnValue = languageEnvironment()
  })
}
