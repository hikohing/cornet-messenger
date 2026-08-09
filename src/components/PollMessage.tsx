import type { Poll } from '../types'
import { CheckIcon } from './icons'

interface PollMessageProps {
  poll: Poll
  isOwn: boolean
  onVote: (optionId: number) => void
  onClose: () => void
}

function votesLabel(count: number) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} голос`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} голоса`
  return `${count} голосов`
}

export function PollMessage({ poll, isOwn, onVote, onClose }: PollMessageProps) {
  const hasVoted = poll.options.some((o) => o.chosen)
  // Доли считаем от числа проголосовавших, а не от суммы голосов: в опросе с
  // несколькими вариантами один человек может выбрать сразу несколько, и
  // проценты по сумме голосов давали бы вводящие в заблуждение цифры.
  const denominator = Math.max(1, poll.totalVoters)
  // Результаты открыты после своего голоса или когда опрос завершён — до этого
  // цифры скрыты, чтобы чужие ответы не влияли на выбор.
  const showResults = hasVoted || poll.closed

  return (
    <div className="poll">
      <div className="poll__header">
        <strong className="poll__question">{poll.question}</strong>
        <span className="poll__meta">
          {poll.anonymous ? 'Анонимный опрос' : 'Открытый опрос'}
          {poll.multipleChoice && ' · несколько вариантов'}
          {poll.closed && ' · завершён'}
        </span>
      </div>

      <ul className="poll__options">
        {poll.options.map((option) => {
          const percent = showResults ? Math.round((option.votes / denominator) * 100) : 0
          return (
            <li key={option.id}>
              <button
                type="button"
                className={`poll__option${option.chosen ? ' is-chosen' : ''}`}
                disabled={poll.closed}
                aria-pressed={option.chosen}
                onClick={() => onVote(option.id)}
              >
                <span className={`poll__marker${poll.multipleChoice ? ' poll__marker--box' : ''}`}>
                  {option.chosen && <CheckIcon width={11} height={11} />}
                </span>
                <span className="poll__option-text">{option.text}</span>
                {showResults && <span className="poll__percent">{percent}%</span>}
              </button>
              {showResults && (
                <div className="poll__bar" aria-hidden="true">
                  <div className="poll__bar-fill" style={{ width: `${percent}%` }} />
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="poll__footer">
        <span>{poll.totalVoters === 0 ? 'Пока никто не проголосовал' : votesLabel(poll.totalVoters)}</span>
        {isOwn && !poll.closed && (
          <button type="button" className="poll__close-button" onClick={onClose}>
            Завершить
          </button>
        )}
      </div>
    </div>
  )
}
