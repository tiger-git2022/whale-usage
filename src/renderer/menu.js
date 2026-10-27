// Draws the rows main.js sends:
//   { type: 'header', text }                         the app name and version
//   { type: 'item', id, text, icon, checked?, enabled? }
//   { type: 'chips', text, icon, chips: [{ id, text, selected }] }
//   { type: 'separator' }
// `icon` is a Segoe Fluent Icons code point, like "E8BD".

const list = document.getElementById('list')

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function icon(code) {
  return el('span', 'icon', code ? String.fromCodePoint(parseInt(code, 16)) : '')
}

function row(entry) {
  if (entry.type === 'separator') return el('div', 'separator')

  if (entry.type === 'header') {
    const head = el('div', 'row header')
    head.append(icon(entry.icon), el('span', 'text', entry.text))
    return head
  }

  if (entry.type === 'chips') {
    const line = el('div', 'row')
    const chips = el('div', 'chips')
    for (const chip of entry.chips) {
      const button = el('button', `chip${chip.selected ? ' selected' : ''}`, chip.text)
      button.setAttribute('role', 'menuitemradio')
      button.setAttribute('aria-checked', String(Boolean(chip.selected)))
      button.addEventListener('click', () => window.menu.choose(chip.id))
      chips.append(button)
    }
    line.append(icon(entry.icon), el('span', 'text', entry.text), chips)
    return line
  }

  const button = el('button', `row${entry.checked ? ' checked' : ''}`)
  button.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox')
  if (entry.checked !== undefined) button.setAttribute('aria-checked', String(entry.checked))
  button.disabled = entry.enabled === false
  button.append(icon(entry.icon), el('span', 'text', entry.text), el('span', 'check', ''))
  button.addEventListener('click', () => window.menu.choose(entry.id))
  return button
}

// Arrow keys move between everything clickable, Enter/Space runs it (the button default), Esc closes.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return window.menu.close()
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const targets = [...list.querySelectorAll('button:not(:disabled)')]
  if (targets.length === 0) return
  const current = targets.indexOf(document.activeElement)
  const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
  const next =
    e.key === 'Home' ? 0
    : e.key === 'End' ? targets.length - 1
    : current < 0 ? (forward ? 0 : targets.length - 1)
    : (current + (forward ? 1 : -1) + targets.length) % targets.length
  targets[next].focus()
})

window.menu.onEntries(({ entries, dark, acrylic, accent }) => {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('acrylic', acrylic)
  document.documentElement.style.setProperty('--accent', accent)
  list.replaceChildren(...entries.map(row))
  // Size the window to the list's natural size
  requestAnimationFrame(() => {
    const box = list.getBoundingClientRect()
    window.menu.size(Math.ceil(box.width), Math.ceil(box.height))
  })
})
