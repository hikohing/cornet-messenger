import { useState } from 'react'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { CloseIcon, PlusIcon, TrashIcon } from './icons'

const MIN_OPTIONS = 2
const MAX_OPTIONS = 10

interface CreatePollModalProps {
  onCreate: (poll: { question: string; options: string[]; anonymous: boolean; multipleChoice: boolean }) => void
  onClose: () => void
}

export function CreatePollModal({ onCreate, onClose }: CreatePollModalProps) {
  useEscapeToClose(onClose)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [anonymous, setAnonymous] = useState(true)
  const [multipleChoice, setMultipleChoice] = useState(false)
  const [error, setError] = useState('')

  const filled = options.map((o) => o.trim()).filter(Boolean)
  const hasDuplicates = new Set(filled).size !== filled.length
  const canSubmit = question.trim().length > 0 && filled.length >= MIN_OPTIONS && !hasDuplicates

  function updateOption(index: number, value: string) {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)))
    setError('')
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (hasDuplicates) {
      setError('Варианты не должны повторяться')
      return
    }
    if (!canSubmit) return
    onCreate({ question: question.trim(), options: filled, anonymous, multipleChoice })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Создать опрос">
        <div className="modal-header">
          <h2>Создать опрос</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <CloseIcon width={17} height={17} />
          </button>
        </div>

        <form className="poll-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="poll-question">Вопрос</label>
            <input
              id="poll-question"
              className="text-input"
              value={question}
              maxLength={255}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="О чём спрашиваем?"
              autoFocus
            />
          </div>

          <div className="field">
            <label>Варианты ответа</label>
            {options.map((option, index) => (
              <div className="poll-form__option" key={index}>
                <input
                  className="text-input"
                  value={option}
                  maxLength={100}
                  placeholder={`Вариант ${index + 1}`}
                  onChange={(e) => updateOption(index, e.target.value)}
                />
                {options.length > MIN_OPTIONS && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Удалить вариант ${index + 1}`}
                    onClick={() => setOptions((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <TrashIcon width={15} height={15} />
                  </button>
                )}
              </div>
            ))}
            {options.length < MAX_OPTIONS && (
              <button type="button" className="poll-form__add" onClick={() => setOptions((prev) => [...prev, ''])}>
                <PlusIcon width={14} height={14} /> Добавить вариант
              </button>
            )}
          </div>

          <label className="poll-form__toggle">
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            <span>Анонимный опрос</span>
          </label>
          <label className="poll-form__toggle">
            <input type="checkbox" checked={multipleChoice} onChange={(e) => setMultipleChoice(e.target.checked)} />
            <span>Несколько вариантов ответа</span>
          </label>

          {error && <div className="form-banner form-banner--error">{error}</div>}

          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            Отправить опрос
          </button>
        </form>
      </div>
    </div>
  )
}
