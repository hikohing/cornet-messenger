#!/usr/bin/env node
/**
 * Разбор жалоб из командной строки: `npm run reports` в папке server.
 *
 * Отдельной админки в приложении нет намеренно — для этого нужна роль
 * администратора, отдельный вход и отдельная поверхность атаки. Оператор и так
 * ходит на сервер (`railway ssh`), а жалоб на таком масштабе единицы.
 *
 *   node src/moderation.js              — нерассмотренные жалобы
 *   node src/moderation.js --all        — все, включая закрытые
 *   node src/moderation.js --close 12   — пометить жалобу №12 рассмотренной
 */
import { many, one, pool, run } from './db.js'

const REASON_LABELS = {
  spam: 'спам',
  abuse: 'оскорбления',
  sexual: 'сексуализированный контент',
  violence: 'насилие или угрозы',
  illegal: 'противозаконное',
  other: 'другое',
}

function formatDate(value) {
  return new Date(Number(value)).toISOString().replace('T', ' ').slice(0, 16)
}

function printReport(report) {
  console.log(`\n#${report.id}  ${formatDate(report.created_at)}  [${report.status}]`)
  console.log(`  причина:  ${REASON_LABELS[report.reason] ?? report.reason}`)
  console.log(`  на кого:  ${report.target_username ?? '— (аккаунт удалён)'}`)
  console.log(`  от кого:  ${report.reporter_username ?? '— (аккаунт удалён)'}`)
  if (report.chat_id) console.log(`  чат:      ${report.chat_id}`)
  if (report.message_id) console.log(`  сообщение: ${report.message_id}`)
  if (report.comment) console.log(`  комментарий: ${report.comment}`)
  if (report.excerpt) {
    // Текст снят на устройстве жалующегося: в зашифрованных чатах у сервера
    // его нет и проверить подлинность нечем.
    console.log(`  текст (со слов жалующегося): ${report.excerpt}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const closeIndex = args.indexOf('--close')

  if (closeIndex !== -1) {
    const id = Number(args[closeIndex + 1])
    if (!Number.isInteger(id)) {
      console.error('Укажите номер жалобы: --close <id>')
      process.exitCode = 1
      return
    }
    const result = await run("UPDATE reports SET status = 'closed' WHERE id = $1", [id])
    console.log(result.rowCount > 0 ? `Жалоба #${id} помечена рассмотренной.` : `Жалоба #${id} не найдена.`)
    return
  }

  const showAll = args.includes('--all')
  const reports = await many(
    `SELECT r.*, reporter.username AS reporter_username, target.username AS target_username
       FROM reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       LEFT JOIN users target ON target.id = r.target_user_id
      ${showAll ? '' : "WHERE r.status = 'open'"}
      ORDER BY r.created_at DESC
      LIMIT 200`,
  )

  if (reports.length === 0) {
    console.log(showAll ? 'Жалоб нет.' : 'Нерассмотренных жалоб нет.')
    return
  }

  for (const report of reports) printReport(report)

  const open = await one("SELECT COUNT(*)::int AS total FROM reports WHERE status = 'open'", [])
  console.log(`\nВсего нерассмотренных: ${open?.total ?? 0}`)
  console.log('Закрыть: node src/moderation.js --close <id>')
}

main()
  .catch((err) => {
    console.error('Не удалось получить жалобы:', err.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
