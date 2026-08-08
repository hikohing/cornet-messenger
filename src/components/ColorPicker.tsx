import { useCallback, useEffect, useRef, useState } from 'react'
import { hexToHsv, hsvToHex } from '../utils/color'

interface ColorPickerProps {
  color: string
  onChange: (hex: string) => void
  /** Быстрые образцы под пикером. */
  presets?: string[]
  label?: string
}

type EyeDropperCapableWindow = Window & {
  EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
}

const DEFAULT_PRESETS = [
  '#5865f2', '#3390ec', '#22d3ee', '#10b981', '#4ade80',
  '#facc15', '#f59e0b', '#f97316', '#ef4444', '#ec4899',
  '#a855f7', '#6e56cf', '#64748b', '#0f172a', '#ffffff',
]

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** Тянущаяся область: возвращает долю указателя внутри элемента. */
function useDragRatio(onRatio: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const apply = useCallback(
    (clientX: number, clientY: number) => {
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      onRatio(clamp01((clientX - rect.left) / rect.width), clamp01((clientY - rect.top) / rect.height))
    },
    [onRatio],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Захват указателя недоступен — перетаскивание всё равно работает.
    }
    apply(e.clientX, e.clientY)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) apply(e.clientX, e.clientY)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Захвата могло и не быть.
    }
  }

  return { ref, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } }
}

/**
 * Палитра: квадрат насыщенности и яркости, полоса оттенка, поле HEX,
 * системная пипетка (где браузер её поддерживает) и быстрые образцы.
 */
export function ColorPicker({ color, onChange, presets = DEFAULT_PRESETS, label }: ColorPickerProps) {
  const [hsv, setHsv] = useState(() => hexToHsv(color))
  const [hexDraft, setHexDraft] = useState(color.toUpperCase())
  const lastEmittedRef = useRef(color.toLowerCase())

  // Внешнее изменение цвета подхватываем, собственное — игнорируем,
  // иначе оттенок «прыгал» бы при перетаскивании в чёрный угол.
  useEffect(() => {
    if (color.toLowerCase() === lastEmittedRef.current.toLowerCase()) return
    lastEmittedRef.current = color
    setHsv(hexToHsv(color))
    setHexDraft(color.toUpperCase())
  }, [color])

  const emit = useCallback(
    (next: { h: number; s: number; v: number }) => {
      setHsv(next)
      const hex = hsvToHex(next.h, next.s, next.v)
      lastEmittedRef.current = hex
      setHexDraft(hex.toUpperCase())
      onChange(hex)
    },
    [onChange],
  )

  const area = useDragRatio(
    useCallback((x: number, y: number) => emit({ h: hsv.h, s: x, v: 1 - y }), [emit, hsv.h]),
  )
  const hueBar = useDragRatio(
    useCallback((x: number) => emit({ h: Math.round(x * 360), s: hsv.s, v: hsv.v }), [emit, hsv.s, hsv.v]),
  )

  function commitHex(value: string) {
    const normalized = value.startsWith('#') ? value : `#${value}`
    if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
      setHexDraft(hsvToHex(hsv.h, hsv.s, hsv.v).toUpperCase())
      return
    }
    lastEmittedRef.current = normalized
    setHsv(hexToHsv(normalized))
    setHexDraft(normalized.toUpperCase())
    onChange(normalized.toLowerCase())
  }

  async function pickFromScreen() {
    const EyeDropperCtor = (window as EyeDropperCapableWindow).EyeDropper
    if (!EyeDropperCtor) return
    try {
      const { sRGBHex } = await new EyeDropperCtor().open()
      commitHex(sRGBHex)
    } catch {
      // Пользователь отменил выбор — ничего не делаем.
    }
  }

  const current = hsvToHex(hsv.h, hsv.s, hsv.v)
  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window

  return (
    <div className="cpicker">
      <div
        ref={area.ref}
        className="cpicker__area"
        style={{ backgroundColor: hsvToHex(hsv.h, 1, 1) }}
        role="application"
        aria-label={label ? `${label}: насыщенность и яркость` : 'Насыщенность и яркость'}
        {...area.handlers}
      >
        <span className="cpicker__thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }} />
      </div>

      <div className="cpicker__row">
        <span className="cpicker__preview" style={{ background: current }} />
        <div className="cpicker__sliders">
          <div
            ref={hueBar.ref}
            className="cpicker__hue"
            role="application"
            aria-label={label ? `${label}: оттенок` : 'Оттенок'}
            {...hueBar.handlers}
          >
            <span className="cpicker__thumb cpicker__thumb--hue" style={{ left: `${(hsv.h / 360) * 100}%`, background: hsvToHex(hsv.h, 1, 1) }} />
          </div>
          <div className="cpicker__inputs">
            <label className="cpicker__hex">
              <span>#</span>
              <input
                value={hexDraft.replace('#', '')}
                onChange={(e) => setHexDraft(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
                onBlur={(e) => commitHex(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitHex((e.target as HTMLInputElement).value)}
                maxLength={6}
                spellCheck={false}
                aria-label={label ? `${label}: HEX` : 'HEX'}
              />
            </label>
            {hasEyeDropper && (
              <button type="button" className="cpicker__eyedropper" onClick={() => void pickFromScreen()} title="Взять цвет с экрана">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3l6 6" />
                  <path d="M17.5 5.5L9 14v3h3l8.5-8.5" />
                  <path d="M8 15l-4 4a2 2 0 0 0 3 3l4-4" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {presets.length > 0 && (
        <div className="cpicker__presets">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`cpicker__preset${preset.toLowerCase() === current.toLowerCase() ? ' is-active' : ''}`}
              style={{ background: preset }}
              onClick={() => commitHex(preset)}
              aria-label={preset}
            />
          ))}
        </div>
      )}
    </div>
  )
}
