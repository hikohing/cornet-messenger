import { Fragment, type ReactNode } from 'react'
import { Spoiler } from '../components/Spoiler'
import { trimUrlTail, type MarkKind } from './markup'

/**
 * Telegram-подобная разметка сообщений.
 *
 * Парсер строит React-узлы напрямую и никогда не собирает HTML-строку, поэтому
 * `dangerouslySetInnerHTML` не нужен: текст пользователя не может превратиться
 * в разметку. Ссылки дополнительно проходят проверку протокола — `javascript:`
 * и `data:` в href не попадают.
 *
 * Строковая часть (маркеры, toggleMarker, stripFormatting) вынесена в markup.ts,
 * чтобы её можно было покрыть node-тестами.
 */

/** `bolditalic` не выносится в панель — это только форма записи `***текст***`. */
type ParsedKind = MarkKind | 'bolditalic'

interface InlineRule {
  kind: ParsedKind
  /** Открывающий и закрывающий маркер (одинаковые). */
  marker: string
  /** Внутри такой разметки вложенное форматирование не разбирается. */
  raw?: boolean
}

/** Порядок важен: более длинные маркеры проверяются первыми, иначе `**` съест `*`. */
const INLINE_RULES: InlineRule[] = [
  { kind: 'spoiler', marker: '||' },
  { kind: 'bolditalic', marker: '***' },
  { kind: 'bold', marker: '**' },
  { kind: 'strike', marker: '~~' },
  { kind: 'underline', marker: '__' },
  { kind: 'code', marker: '`', raw: true },
  { kind: 'italic', marker: '*' },
  { kind: 'italic', marker: '_' },
]

const MAX_DEPTH = 6

/**
 * Ссылки распознаём только с явной схемой http(s) — иначе слишком много ложных
 * срабатываний. Скобки внутри пути разрешены (адреса Википедии вида
 * `/wiki/Кот_(значения)`), непарную закрывающую отрезаем отдельно ниже.
 */
const URL_PATTERN = /https?:\/\/[^\s<>[\]{}"']+/gi


function isSafeHref(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Разбирает текст на ссылки и всё остальное. Вызывается ПЕРЕД инлайновой
 * разметкой: подчёркивания и звёздочки сплошь и рядом встречаются в адресах
 * (`/get_user_by_id`), и если сначала искать разметку, то пара `_` внутри
 * ссылки превращалась в курсив и рвала адрес на куски.
 */
function parseWithLinks(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  URL_PATTERN.lastIndex = 0

  while ((match = URL_PATTERN.exec(text)) !== null) {
    const raw = match[0]
    const url = trimUrlTail(raw)
    if (!url) continue
    if (match.index > lastIndex) {
      nodes.push(...parseInline(text.slice(lastIndex, match.index), `${keyPrefix}-t${lastIndex}`, 0))
    }
    if (isSafeHref(url)) {
      nodes.push(
        <a
          key={`${keyPrefix}-a-${match.index}`}
          className="message-link"
          href={url}
          target="_blank"
          // noreferrer обязателен вместе с noopener: без него целевая страница
          // получает доступ к window.opener и может подменить нашу вкладку.
          rel="noopener noreferrer nofollow"
        >
          {url}
        </a>,
      )
    } else {
      nodes.push(url)
    }
    lastIndex = match.index + url.length
  }
  if (lastIndex < text.length) {
    nodes.push(...parseInline(text.slice(lastIndex), `${keyPrefix}-t${lastIndex}`, 0))
  }
  return nodes
}

function wrapMark(kind: ParsedKind, key: string, children: ReactNode): ReactNode {
  switch (kind) {
    case 'bold': return <strong key={key}>{children}</strong>
    case 'italic': return <em key={key}>{children}</em>
    case 'bolditalic': return <strong key={key}><em>{children}</em></strong>
    case 'underline': return <u key={key}>{children}</u>
    case 'strike': return <s key={key}>{children}</s>
    case 'code': return <code key={key} className="message-code">{children}</code>
    case 'spoiler': return <Spoiler key={key}>{children}</Spoiler>
  }
}

/** Ссылки здесь уже вырезаны — на этом уровне остаётся только разметка. */
function parseInline(text: string, keyPrefix: string, depth: number): ReactNode[] {
  if (depth > MAX_DEPTH) return [text]

  for (const rule of INLINE_RULES) {
    const open = text.indexOf(rule.marker)
    if (open === -1) continue
    const close = text.indexOf(rule.marker, open + rule.marker.length)
    if (close === -1) continue
    // Пустая пара маркеров (`**`) — это просто текст, а не форматирование.
    if (close === open + rule.marker.length) continue

    const before = text.slice(0, open)
    const inner = text.slice(open + rule.marker.length, close)
    const after = text.slice(close + rule.marker.length)

    return [
      ...(before ? parseInline(before, `${keyPrefix}-b`, depth + 1) : []),
      wrapMark(
        rule.kind,
        `${keyPrefix}-m${open}`,
        rule.raw ? inner : <Fragment>{parseInline(inner, `${keyPrefix}-i`, depth + 1)}</Fragment>,
      ),
      ...(after ? parseInline(after, `${keyPrefix}-a`, depth + 1) : []),
    ]
  }

  return [text]
}

/**
 * Многострочные код-блоки (```) выделяются до инлайновой разметки, чтобы
 * содержимое кода не разбиралось как форматирование.
 */
function parseBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const parts = text.split(/```/g)

  parts.forEach((part, index) => {
    const isCodeBlock = index % 2 === 1
    if (isCodeBlock) {
      // Непарный ``` в конце — возвращаем как обычный текст, а не «съедаем».
      if (index === parts.length - 1 && parts.length % 2 === 0) {
        nodes.push(...parseWithLinks('```' + part, `p${index}`))
        return
      }
      const body = part.replace(/^\n/, '').replace(/\n$/, '')
      nodes.push(<pre key={`pre-${index}`} className="message-code-block"><code>{body}</code></pre>)
      return
    }
    if (part) nodes.push(...parseWithLinks(part, `p${index}`))
  })

  return nodes
}

export function renderFormattedText(text: string): ReactNode {
  if (!text) return null
  return <>{parseBlocks(text)}</>
}


