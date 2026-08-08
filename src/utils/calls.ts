import type { CallMeta } from '../types'

/** Длительность разговора в формате м:сс (и ч:мм:сс для длинных звонков). */
export function formatCallDuration(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Короткое описание звонка: одинаково используется в чате и в списке чатов. */
export function callMessageSummary(meta: CallMeta | null | undefined, isOwn: boolean) {
  const kind = meta?.video ? 'Видеозвонок' : 'Звонок'
  switch (meta?.outcome) {
    case 'answered':
      return isOwn ? `Исходящий ${kind.toLowerCase()}` : `Входящий ${kind.toLowerCase()}`
    case 'missed':
      return isOwn ? 'Нет ответа' : `Пропущенный ${kind.toLowerCase()}`
    case 'declined':
      return isOwn ? `${kind} отклонён` : `Вы отклонили ${kind.toLowerCase()}`
    case 'cancelled':
      return isOwn ? `Отменённый ${kind.toLowerCase()}` : `Пропущенный ${kind.toLowerCase()}`
    default:
      return `${kind} не состоялся`
  }
}
