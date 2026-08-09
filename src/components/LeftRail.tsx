import type { ComponentType } from 'react'
import { ArchiveIcon, BookmarkIcon, ChatBubbleIcon, HomeIcon, PlusIcon, UsersIcon } from './icons'

export type RailView = 'all' | 'direct' | 'group' | 'saved' | 'archive'

interface LeftRailProps {
  activeView: RailView
  createOpen: boolean
  onSelectView: (view: RailView) => void
  onCreateNew: () => void
}

const ITEMS: { view: RailView; label: string; icon: ComponentType<{ width: number; height: number }> }[] = [
  { view: 'all', label: 'Главная', icon: HomeIcon },
  { view: 'direct', label: 'Личные', icon: ChatBubbleIcon },
  { view: 'group', label: 'Группы', icon: UsersIcon },
  { view: 'saved', label: 'Избранное', icon: BookmarkIcon },
  { view: 'archive', label: 'Архив', icon: ArchiveIcon },
]

export function LeftRail({ activeView, createOpen, onSelectView, onCreateNew }: LeftRailProps) {
  return (
    <nav className="left-rail" aria-label="Разделы CorNet">
      <div className="left-rail__items">
        {ITEMS.map(({ view, label, icon: Icon }) => (
          <button
            key={view}
            className={`left-rail__item${activeView === view ? ' active' : ''}`}
            onClick={() => onSelectView(view)}
            title={label}
          >
            <Icon width={20} height={20} />
            <span className="left-rail__label">{label}</span>
          </button>
        ))}
      </div>
      <button
        className={`left-rail__create${createOpen ? ' active' : ''}`}
        onClick={onCreateNew}
        title={createOpen ? 'Закрыть' : 'Новое пространство'}
      >
        <PlusIcon width={20} height={20} />
      </button>
    </nav>
  )
}
