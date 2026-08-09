/**
 * Чистая строковая часть разметки сообщений — без React, чтобы её можно было
 * покрыть обычными node-тестами (JSX в них не разбирается).
 * Рендер живёт в formatting.tsx.
 */

export type MarkKind = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler'

export const MARKERS: Record<MarkKind, string> = {
  bold: '**',
  italic: '*',
  underline: '__',
  strike: '~~',
  code: '`',
  spoiler: '||',
}

/** Длина цепочки одинаковых символов `ch` в конце строки. */
function trailingRun(s: string, ch: string): number {
  let n = 0
  for (let i = s.length - 1; i >= 0 && s[i] === ch; i--) n++
  return n
}

/** Длина цепочки одинаковых символов `ch` в начале строки. */
function leadingRun(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length && s[i] === ch; i++) n++
  return n
}

/**
 * Оборачивает выделенный фрагмент маркерами или снимает их, если стиль уже
 * применён. Возвращает новый текст и границы выделения, чтобы курсор не прыгал
 * и стили можно было накладывать подряд.
 */
export function toggleMarker(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  kind: MarkKind,
): { text: string; selectionStart: number; selectionEnd: number } {
  const marker = MARKERS[kind]
  const selected = text.slice(selectionStart, selectionEnd)
  if (!selected) return { text, selectionStart, selectionEnd }

  const before = text.slice(0, selectionStart)
  const after = text.slice(selectionEnd)

  // Маркеры из одного символа образуют «семейство» (`*` курсив / `**` жирный /
  // `***` оба), поэтому смотреть надо не на точное совпадение, а на длину
  // цепочки — как в CommonMark. Одиночный маркер активен при нечётной длине,
  // парный — при длине от двух. Наивная проверка «before заканчивается на
  // маркер» приводила к тому, что курсив съедал половину жирного.
  const ch = marker[0]
  const runBefore = trailingRun(before, ch)
  const runAfter = leadingRun(after, ch)
  const symmetric = runBefore > 0 && runBefore === runAfter
  const alreadyApplied = symmetric && (marker.length === 1 ? runBefore % 2 === 1 : runBefore >= 2)

  if (alreadyApplied) {
    return {
      text: before.slice(0, -marker.length) + selected + after.slice(marker.length),
      selectionStart: selectionStart - marker.length,
      selectionEnd: selectionEnd - marker.length,
    }
  }

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
    const stripped = selected.slice(marker.length, -marker.length)
    return {
      text: before + stripped + after,
      selectionStart,
      selectionEnd: selectionStart + stripped.length,
    }
  }

  return {
    text: `${before}${marker}${selected}${marker}${after}`,
    selectionStart: selectionStart + marker.length,
    selectionEnd: selectionEnd + marker.length,
  }
}

/**
 * Отрезает у найденного адреса хвост, который на деле принадлежит предложению,
 * а не ссылке. Закрывающую скобку убираем только если она непарная — иначе
 * ломались бы адреса вида `/wiki/Кот_(значения)`.
 */
export function trimUrlTail(url: string): string {
  let result = url
  for (;;) {
    const last = result[result.length - 1]
    if (last === ')') {
      const opens = (result.match(/\(/g) ?? []).length
      const closes = (result.match(/\)/g) ?? []).length
      if (closes <= opens) break
      result = result.slice(0, -1)
      continue
    }
    if (last && '.,!?;:'.includes(last)) {
      result = result.slice(0, -1)
      continue
    }
    break
  }
  return result
}

/** Текст без маркеров разметки — для превью в списке чатов, ответах и уведомлениях. */
export function stripFormatting(text: string): string {
  return text
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
}
