import { useState } from 'react'
import type { Chat, ChatFolder } from '../types'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { showToast } from '../hooks/useToast'
import { CloseIcon, PlusIcon, TrashIcon } from './icons'

interface FoldersModalProps {
  folders: ChatFolder[]
  chats: Chat[]
  onSave: (name: string, chatIds: number[], folderId?: number) => Promise<void>
  onDelete: (folderId: number) => Promise<void>
  onClose: () => void
}

export function FoldersModal({ folders, chats, onSave, onDelete, onClose }: FoldersModalProps) {
  useEscapeToClose(onClose)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  const isEditing = editingId !== null
  const canSave = name.trim().length > 0 && selected.length > 0

  function startNew() {
    setEditingId(null)
    setName('')
    setSelected([])
  }

  function startEdit(folder: ChatFolder) {
    setEditingId(folder.id)
    setName(folder.name)
    setSelected(folder.chatIds)
  }

  async function handleSave() {
    if (!canSave || busy) return
    setBusy(true)
    try {
      await onSave(name.trim(), selected, editingId ?? undefined)
      showToast(isEditing ? 'Папка обновлена' : 'Папка создана')
      startNew()
    } catch (err) {
      showToast((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(folderId: number) {
    setBusy(true)
    try {
      await onDelete(folderId)
      if (editingId === folderId) startNew()
      showToast('Папка удалена')
    } catch (err) {
      showToast((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Папки">
        <div className="modal-header">
          <h2>Папки</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <CloseIcon width={17} height={17} />
          </button>
        </div>

        <div className="folders-modal">
          {folders.length > 0 && (
            <ul className="folders-modal__list">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    className={`folders-modal__item${editingId === folder.id ? ' is-active' : ''}`}
                    onClick={() => startEdit(folder)}
                  >
                    <span>{folder.name}</span>
                    <small>{folder.chatIds.length}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Удалить папку ${folder.name}`}
                    disabled={busy}
                    onClick={() => void handleDelete(folder.id)}
                  >
                    <TrashIcon width={15} height={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="field">
            <label htmlFor="folder-name">{isEditing ? 'Название папки' : 'Новая папка'}</label>
            <input
              id="folder-name"
              className="text-input"
              value={name}
              maxLength={32}
              placeholder="Например, Работа"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Чаты в папке</label>
            <ul className="folders-modal__chats">
              {chats.filter((c) => c.type !== 'saved').map((chat) => (
                <li key={chat.id}>
                  <label className="folders-modal__chat">
                    <input
                      type="checkbox"
                      checked={selected.includes(chat.id)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, chat.id] : prev.filter((id) => id !== chat.id),
                        )
                      }
                    />
                    <span>{chat.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className="folders-modal__actions">
            {isEditing && (
              <button type="button" className="settings-button" onClick={startNew} disabled={busy}>
                <PlusIcon width={14} height={14} /> Новая папка
              </button>
            )}
            <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={!canSave || busy}>
              {isEditing ? 'Сохранить' : 'Создать папку'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
