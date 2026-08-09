import test from 'node:test'
import assert from 'node:assert/strict'
import { toggleMarker, stripFormatting, trimUrlTail } from '../src/utils/markup.ts'

/** Удобная обёртка: возвращает текст и то, что осталось выделенным. */
function apply(text: string, start: number, end: number, kind: Parameters<typeof toggleMarker>[3]) {
  const r = toggleMarker(text, start, end, kind)
  return { text: r.text, selected: r.text.slice(r.selectionStart, r.selectionEnd) }
}

test('toggleMarker: применение стиля', async (t) => {
  await t.test('оборачивает выделение', () => {
    assert.equal(apply('привет мир', 0, 6, 'bold').text, '**привет** мир')
    assert.equal(apply('привет', 0, 6, 'italic').text, '*привет*')
    assert.equal(apply('привет', 0, 6, 'underline').text, '__привет__')
    assert.equal(apply('привет', 0, 6, 'strike').text, '~~привет~~')
    assert.equal(apply('секрет', 0, 6, 'spoiler').text, '||секрет||')
    assert.equal(apply('код', 0, 3, 'code').text, '`код`')
  })

  await t.test('сохраняет выделение, чтобы стили можно было накладывать подряд', () => {
    assert.equal(apply('привет мир', 0, 6, 'bold').selected, 'привет')
    assert.equal(apply('**привет** мир', 2, 8, 'bold').selected, 'привет')
  })

  await t.test('пустое выделение ничего не меняет', () => {
    assert.equal(apply('привет', 3, 3, 'bold').text, 'привет')
  })
})

test('toggleMarker: снятие стиля', async (t) => {
  await t.test('снимает свой же маркер', () => {
    assert.equal(apply('**привет** мир', 2, 8, 'bold').text, 'привет мир')
    assert.equal(apply('*привет*', 1, 7, 'italic').text, 'привет')
    assert.equal(apply('__привет__', 2, 8, 'underline').text, 'привет')
    assert.equal(apply('~~привет~~', 2, 8, 'strike').text, 'привет')
    assert.equal(apply('||секрет||', 2, 8, 'spoiler').text, 'секрет')
    assert.equal(apply('`код`', 1, 4, 'code').text, 'код')
  })
})

// Курсив (`*`) и жирный (`**`) — один и тот же символ, поэтому наивная проверка
// «текст слева заканчивается маркером» принимала половину `**` за курсив и
// разрушала уже расставленную разметку. Длина цепочки решает это по правилам
// CommonMark: одиночный маркер активен при нечётной длине, парный — от двух.
test('toggleMarker: семейство одинаковых символов не разрушается', async (t) => {
  await t.test('курсив поверх жирного вкладывается, а не съедает его', () => {
    assert.equal(apply('**привет** мир', 2, 8, 'italic').text, '***привет*** мир')
  })

  await t.test('жирный поверх курсива вкладывается', () => {
    assert.equal(apply('*привет*', 1, 7, 'bold').text, '***привет***')
  })

  await t.test('из тройного маркера снимается ровно запрошенный стиль', () => {
    assert.equal(apply('***привет*** мир', 3, 9, 'italic').text, '**привет** мир')
    assert.equal(apply('***привет*** мир', 3, 9, 'bold').text, '*привет* мир')
  })

  await t.test('несимметричные маркеры не считаются применённым стилем', () => {
    assert.equal(apply('**привет* мир', 2, 8, 'italic').text, '***привет** мир')
  })
})

test('trimUrlTail отделяет ссылку от пунктуации предложения', async (t) => {
  await t.test('убирает финальную пунктуацию', () => {
    assert.equal(trimUrlTail('https://example.com/page.'), 'https://example.com/page')
    assert.equal(trimUrlTail('https://example.com/a,'), 'https://example.com/a')
    assert.equal(trimUrlTail('https://example.com/a?!'), 'https://example.com/a')
  })

  // Скобки в адресах реально встречаются (Википедия), поэтому убирать их
  // огулом нельзя — только непарную закрывающую от «(см. ссылка)».
  await t.test('сохраняет парные скобки внутри адреса', () => {
    assert.equal(
      trimUrlTail('https://ru.wikipedia.org/wiki/Кот_(значения)'),
      'https://ru.wikipedia.org/wiki/Кот_(значения)',
    )
  })

  await t.test('отрезает непарную закрывающую скобку', () => {
    assert.equal(trimUrlTail('https://example.com/page)'), 'https://example.com/page')
  })

  await t.test('обычный адрес не трогает', () => {
    assert.equal(trimUrlTail('https://example.com/a/b'), 'https://example.com/a/b')
  })
})

test('stripFormatting убирает маркеры для превью', () => {
  assert.equal(stripFormatting('**жирный** и *курсив*'), 'жирный и курсив')
  assert.equal(stripFormatting('***оба***'), 'оба')
  assert.equal(stripFormatting('||спойлер||'), 'спойлер')
  assert.equal(stripFormatting('`код` и ```блок```'), 'код и блок')
  assert.equal(stripFormatting('~~зачёркнуто~~ __подчёркнуто__'), 'зачёркнуто подчёркнуто')
  assert.equal(stripFormatting('без разметки'), 'без разметки')
})
