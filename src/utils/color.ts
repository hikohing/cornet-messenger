/** Преобразования цвета для палитры: HEX ↔ HSV. */

export interface Hsv {
  h: number
  s: number
  v: number
}

export function hexToHsv(hex: string): Hsv {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return { h: 0, s: 0, v: 0 }
  const int = parseInt(match[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }
  // Оттенок не округляем: иначе HEX после обратного преобразования уезжает на единицу.
  h *= 60
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

export function hsvToHex(h: number, s: number, v: number) {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x]
  const to255 = (channel: number) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')
  return `#${to255(r)}${to255(g)}${to255(b)}`
}
