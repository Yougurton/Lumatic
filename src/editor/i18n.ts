import { EN } from './i18n-en';
import { settings, type Language } from './settings';

/**
 * The editor in English. The editor's text is written in Russian; in English it's put through the
 * dictionary (i18n-en.ts: the Russian text → its English) where it's shown: whatever the page puts on
 * screen (text, tooltips, placeholders — a MutationObserver), what's drawn on canvases (fillText,
 * measureText), the browser's own questions (confirm, alert, prompt). Text with numbers and names in
 * it is matched by the dictionary's patterns ("Выбрано: {0}"), the parts put in translated too.
 * Names people gave things themselves aren't in the dictionary and stay as they are.
 */

export const language = (): Language => settings().language;

const CYRILLIC = /[А-Яа-яЁё]/u;

interface Pattern {
  regex: RegExp;
  english: string;
  /** Its fixed text's length: the longer ones are tried first. */
  weight: number;
}

let exact: Map<string, string> | null = null;
/** The same without the marks around the words (◆, ·, …, ▾, ✳…): "· by rings" found for "по кольцам". */
let bare: Map<string, string> | null = null;
let patterns: Pattern[] = [];

/** Marks around the words: the words themselves, and what's before and after them. */
// (any symbol or emoji — ● ≋ ∞ ⟲ ⇋ 🗑… — and the usual punctuation round them)
const MARKS = /^([\s\p{So}\p{Sm}\p{Sk}\uFE0F\u200D·•…:;,.—–-]*)([\s\S]*?)([\s\p{So}\p{Sm}\p{Sk}\uFE0F·•…:;,.—–-]*)$/u;

function load() {
  if (exact !== null) return;
  exact = new Map();
  bare = new Map();
  for (const [russian, english] of Object.entries(EN)) {
    if (!/\{\d+\}/u.test(russian)) {
      exact.set(russian, english);
      const words = MARKS.exec(russian)![2]!;
      if (words !== russian && !bare.has(words)) bare.set(words, MARKS.exec(english)![2]!);
      continue;
    }
    const parts = russian.split(/\{\d+\}/u);
    const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('([\\s\\S]*?)');
    patterns.push({ regex: new RegExp(`^${source}$`, 'u'), english, weight: parts.join('').length });
  }
  patterns = patterns.sort((a, b) => b.weight - a.weight);
}

const cache = new Map<string, string>();

/** Separators text is often put together with: a whole that isn't in the dictionary is tried part
 *  by part. */
const JOINS = [' · ', ' — ', '\n', '. ', ': ', ', ', ' ('];

/** A pattern's match with what's put in translated; `strict`: only if every part in Russian is in the
 *  dictionary (so "Метка {0}" doesn't take "Метка у курсора"). */
function byPattern(text: string, depth: number, strict: boolean): string | null {
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (match === null) continue;
    const parts = match.slice(1).map((part) => (depth < 3 ? translateText(part, depth + 1) : part));
    if (strict && parts.some((part) => CYRILLIC.test(part))) continue;
    return pattern.english.replace(/\{(\d+)\}/gu, (_, index: string) => parts[Number(index)] ?? '');
  }
  return null;
}

function lookup(text: string, depth: number): string | null {
  load();
  const found = exact!.get(text);
  if (found !== undefined) return found;
  const [, before, words, after] = MARKS.exec(text)!;
  if (words !== text && words !== '') {
    const inner = exact!.get(words) ?? bare!.get(words);
    if (inner !== undefined) return before! + inner + after!;
  } else {
    const inner = bare!.get(text);
    if (inner !== undefined) return inner;
  }
  const strict = byPattern(text, depth, true);
  if (strict !== null) return strict;
  if (words !== text && words !== '') {
    const inner = byPattern(words, depth, true);
    if (inner !== null) return before! + inner + after!;
  }
  if (depth < 3) {
    for (const join of JOINS) {
      if (!text.includes(join)) continue;
      const parts = text.split(join);
      const done = parts.map((part) => translateText(part, depth + 1));
      if (done.some((part, index) => part !== parts[index])) return done.join(join);
    }
  }
  return byPattern(text, depth, false);
}

function translateText(text: string, depth = 0): string {
  if (!CYRILLIC.test(text)) return text;
  const start = /^\s*/u.exec(text)![0];
  const end = /\s*$/u.exec(text)![0];
  const core = text.slice(start.length, text.length - end.length).replace(/\s+/gu, ' ');
  const found = lookup(core, depth);
  return found === null ? text : start + found + end;
}

/** Text in the language picked (the editor's Russian text as it is in Russian). */
export function translate(text: string): string {
  if (language() === 'ru' || !CYRILLIC.test(text)) return text;
  const known = cache.get(text);
  if (known !== undefined) return known;
  const done = translateText(text);
  if (cache.size > 20000) cache.clear();
  cache.set(text, done);
  return done;
}

/** Russian text with its {0}, {1}… filled in, in the language picked. */
export function tr(text: string, ...values: (string | number)[]): string {
  const filled = (template: string) => template.replace(/\{(\d+)\}/gu, (_, index: string) => String(values[Number(index)] ?? ''));
  if (language() === 'ru') return filled(text);
  // (what's put in translated too, when it's the editor's own text — names of groups, of effects…)
  values = values.map((value) => (typeof value === 'string' ? translate(value) : value));
  load();
  const english = exact!.get(text) ?? EN[text];
  return english !== undefined ? filled(english) : translate(filled(text));
}

// ----- the page in English ------------------------------------------------------------------------

const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);

function translateNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (parent === null || SKIP.has(parent.tagName)) return;
    const text = node.nodeValue ?? '';
    const done = translate(text);
    if (done === text) return;
    // (an option without a value of its own is worth its text: keep that)
    if (parent instanceof HTMLOptionElement && !parent.hasAttribute('value')) parent.value = text;
    node.nodeValue = done;
    return;
  }
  if (!(node instanceof Element)) return;
  for (const name of ATTRIBUTES) {
    const value = node.getAttribute(name);
    if (value === null) continue;
    const done = translate(value);
    if (done !== value) node.setAttribute(name, done);
  }
  if (SKIP.has(node.tagName)) return;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) translateNode(child);
}

/** In English: the page, the canvases and the browser's questions from now on. */
export function installTranslation() {
  if (language() === 'ru') return;
  document.documentElement.lang = 'en';
  translateNode(document.body);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      else if (record.type === 'attributes') translateNode(record.target);
      else for (const node of record.addedNodes) translateNode(node);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });

  const context = CanvasRenderingContext2D.prototype;
  const fillText = context.fillText;
  const strokeText = context.strokeText;
  const measureText = context.measureText;
  context.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
    if (maxWidth === undefined) fillText.call(this, translate(text), x, y);
    else fillText.call(this, translate(text), x, y, maxWidth);
  };
  context.strokeText = function (text: string, x: number, y: number, maxWidth?: number) {
    if (maxWidth === undefined) strokeText.call(this, translate(text), x, y);
    else strokeText.call(this, translate(text), x, y, maxWidth);
  };
  context.measureText = function (text: string) {
    return measureText.call(this, translate(text));
  };

  const confirm = window.confirm.bind(window);
  const alert = window.alert.bind(window);
  const prompt = window.prompt.bind(window);
  window.confirm = (message?: string) => confirm(message === undefined ? undefined : translate(message));
  window.alert = (message?: unknown) => alert(typeof message === 'string' ? translate(message) : message);
  window.prompt = (message?: string, value?: string) => prompt(message === undefined ? undefined : translate(message), value === undefined ? undefined : translate(value));
}
