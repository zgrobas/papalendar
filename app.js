const IS_MOBILE = typeof window !== 'undefined' && window.innerWidth < 768

const state = {
  icalUrl: '',
  icalEvents: [],
  manualEvents: [],
  eventOverrides: {},
  currentDate: new Date(),
  view: 'weekly',
  weekStartsOn: 1,
  isLoading: false,
  error: null,
  initialized: false,
}

const PROXY = '/api/proxy?url='

const STORAGE_KEY = 'papalendar_data'
const DAYS_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const DAYS_LONG = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

// ---- Helpers ----

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function getMinutes(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDate(date) {
  return `${DAYS_LONG[date.getDay()]}, ${date.getDate()} de ${MONTHS[date.getMonth()]}`
}

function generateId() {
  return 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

function normalizeToMidnight(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function createDate(year, month, day) {
  return new Date(year, month, day)
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year, month) {
  return new Date(year, month, 1).getDay()
}

function eventsOverlap(a, b) {
  return a.start < b.end && b.start < a.end
}

function mergeOverlapping(ranges) {
  if (!ranges.length) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end)
    } else {
      merged.push({ ...sorted[i] })
    }
  }
  return merged
}

// ---- Storage ----

function saveState() {
  const data = {
    icalUrl: state.icalUrl,
    manualEvents: state.manualEvents,
    eventOverrides: state.eventOverrides,
  }

  // Local cache
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch (_) {}

  // Server persist
  const tok = localStorage.getItem('papalendar_token') || ''
  fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
    body: JSON.stringify(data),
  }).catch(() => {})
}

function loadState() {
  // Try server first
  const tok = localStorage.getItem('papalendar_token') || ''
  return fetch('/api/data', { headers: { 'Authorization': 'Bearer ' + tok } })
    .then(r => {
      if (r.status === 401) {
        localStorage.removeItem('papalendar_token')
        window.location.href = '/login.html'
        throw new Error('No autorizado')
      }
      return r.json()
    })
    .then(data => {
      if (data.icalUrl) state.icalUrl = data.icalUrl
      if (data.manualEvents) {
        state.manualEvents = data.manualEvents.map(e => ({
          ...e, start: new Date(e.start), end: new Date(e.end),
        }))
      }
      if (data.eventOverrides) state.eventOverrides = data.eventOverrides
      return true
    })
    .catch(() => {
      // Fallback to localStorage
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return false
        const data = JSON.parse(raw)
        if (data.icalUrl) state.icalUrl = data.icalUrl
        if (data.manualEvents) {
          state.manualEvents = data.manualEvents.map(e => ({
            ...e, start: new Date(e.start), end: new Date(e.end),
          }))
        }
        if (data.eventOverrides) state.eventOverrides = data.eventOverrides
        return true
      } catch (_) { return false }
    })
}

// ---- iCal Loading ----

function icalUrlFromGoogleUrl(input) {
  const trimmed = input.trim()

  // Already a direct iCal URL
  if (trimmed.includes('/ical/') && trimmed.endsWith('.ics')) {
    return trimmed
  }

  // Extract cid parameter from Google Calendar web URL
  const match = trimmed.match(/[?&]cid=([^&]+)/)
  if (match) {
    try {
      const decoded = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'))
      if (decoded.includes('@')) {
        return `https://calendar.google.com/calendar/ical/${encodeURIComponent(decoded)}/public/basic.ics`
      }
    } catch (_) { /* not base64, try raw */ }
    // Maybe cid is already the email
    if (match[1].includes('@')) {
      return `https://calendar.google.com/calendar/ical/${encodeURIComponent(match[1])}/public/basic.ics`
    }
  }

  return null
}

async function fetchICS(url) {
  const proxyUrl = PROXY + encodeURIComponent(url)
  const tok = localStorage.getItem('papalendar_token') || ''
  const resp = await fetch(proxyUrl, { headers: { 'Authorization': 'Bearer ' + tok } })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text.slice(0, 200) || `Error HTTP ${resp.status}`)
  }
  return await resp.text()
}

function parseICSEvents(icsText) {
  const events = []
  const blocks = icsText.split(/(?=BEGIN:VEVENT)/)

  for (const block of blocks) {
    if (!block.startsWith('BEGIN:VEVENT')) continue

    const props = {}
    const lines = block.split(/\r?\n/)

    let currentKey = null
    for (const line of lines) {
      if (line.startsWith(' ')) {
        if (currentKey) props[currentKey] += line.trim()
        continue
      }
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx)
      const value = line.slice(colonIdx + 1)
      currentKey = key
      props[key] = value
    }

    const dtstartRaw = props['DTSTART'] || ''
    const dtendRaw = props['DTEND'] || ''
    const summary = props['SUMMARY'] || 'Sin título'

    if (!dtstartRaw) continue

    const start = parseICSDate(dtstartRaw)
    const end = dtendRaw ? parseICSDate(dtendRaw) : new Date(start.getTime() + 3600000)

    if (!start || !end) continue

    events.push({
      id: props['UID'] || generateId(),
      title: summary,
      start,
      end,
      source: 'ical',
    })
  }

  return events
}

function parseICSDate(raw) {
  // UTC datetime: 20260612T082000Z
  const utcMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (utcMatch) {
    return new Date(Date.UTC(
      parseInt(utcMatch[1]),
      parseInt(utcMatch[2]) - 1,
      parseInt(utcMatch[3]),
      parseInt(utcMatch[4]),
      parseInt(utcMatch[5]),
      parseInt(utcMatch[6])
    ))
  }

  // Local datetime: 20260612T082000
  const localMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/)
  if (localMatch) {
    return new Date(
      parseInt(localMatch[1]),
      parseInt(localMatch[2]) - 1,
      parseInt(localMatch[3]),
      parseInt(localMatch[4]),
      parseInt(localMatch[5]),
      parseInt(localMatch[6])
    )
  }

  // All-day: 20260612
  const dateMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (dateMatch) {
    return new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]))
  }

  return null
}

async function refreshCalendar() {
  if (!state.icalUrl || state.icalUrl === '(archivo local)') {
    if (!state.manualEvents.length) {
      openModal('modal-settings')
    }
    return
  }
  const btn = document.getElementById('btn-refresh')
  const mBtn = document.getElementById('mobile-btn-refresh')
  btn.style.transform = 'rotate(360deg)'
  btn.style.transition = 'transform 0.4s'
  if (mBtn) mBtn.textContent = '↻ Actualizando...'
  setTimeout(() => { btn.style.transform = '' }, 500)
  await loadICAL(state.icalUrl)
  if (mBtn) mBtn.textContent = '↻ Actualizar'
}

async function loadICAL(rawUrl) {
  const icalUrl = icalUrlFromGoogleUrl(rawUrl)
  if (!icalUrl) {
    setError('No se pudo interpretar esa URL. Pega la URL del calendario público de Google (con cid=...) o una URL iCal directa.')
    return
  }

  setLoading(true)
  clearError()
  showToast('Descargando calendario...')

  try {
    const icsText = await fetchICS(icalUrl)
    state.icalEvents = parseICSEvents(icsText)
    state.icalUrl = rawUrl
    setLoading(false)
    showBanner(false)
    saveState()
    render()
    showToast(`✓ ${state.icalEvents.length} eventos cargados`)
  } catch (e) {
    setLoading(false)
    setError('Error al conectar: ' + e.message)
  }
}

function loadICSFromFile(file) {
  setLoading(true)
  clearError()

  const reader = new FileReader()
  reader.onload = function (e) {
    try {
      state.icalEvents = parseICSEvents(e.target.result)
      state.icalUrl = '(archivo local)'
      setLoading(false)
      showBanner(false)
      saveState()
      render()
      showToast(`Archivo cargado: ${state.icalEvents.length} eventos.`)
      closeModal('modal-settings')
    } catch (err) {
      setLoading(false)
      setError(err.message)
    }
  }
  reader.onerror = function () {
    setLoading(false)
    setError('Error al leer el archivo.')
  }
  reader.readAsText(file)
}

// ---- Event Queries ----

function getAllEvents() {
  return [...state.icalEvents, ...state.manualEvents]
}

function getEventsForDay(date) {
  const dayStart = normalizeToMidnight(date)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  return getAllEvents().filter(e =>
    e.start < dayEnd && e.end > dayStart
  )
}

function getCoveredMinutesForDay(date) {
  const dayStart = normalizeToMidnight(date)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  const dayEvents = getAllEvents().filter(e => {
    return e.start < dayEnd && e.end > dayStart
  })

  if (!dayEvents.length) return 0

  const ranges = dayEvents.map(e => ({
    start: Math.max(e.start, dayStart),
    end: Math.min(e.end, dayEnd),
  }))

  const merged = mergeOverlapping(ranges)
  return merged.reduce((sum, r) => sum + (r.end - r.start), 0) / (1000 * 60)
}

function getEventsForWeek(date) {
  const start = getWeekStart(date)
  const end = addDays(start, 7)
  return getAllEvents().filter(e => e.start < end && e.end > start)
}

function getWeekStart(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day < state.weekStartsOn ? 7 : 0) + day - state.weekStartsOn
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function getWeekEnd(date) {
  return addDays(getWeekStart(date), 7)
}

function getCoveredHoursThisWeek() {
  const start = getWeekStart(state.currentDate)
  const end = getWeekEnd(state.currentDate)
  const weekEvents = getAllEvents().filter(e => e.start < end && e.end > start)

  if (!weekEvents.length) return 0

  const ranges = weekEvents.map(e => ({
    start: Math.max(e.start, start),
    end: Math.min(e.end, end),
  }))

  const merged = mergeOverlapping(ranges)
  return Math.round(merged.reduce((sum, r) => sum + (r.end - r.start), 0) / (1000 * 60 * 60) * 10) / 10
}

// ---- Rendering ----

function render() {
  if (state.view === 'daily') renderDaily()
  else if (state.view === 'monthly') renderMonthly()
  else renderWeekly()
  updatePeriodLabel()
  updateStats()
}

function updatePeriodLabel() {
  const label = document.getElementById('period-label')
  const d = state.currentDate

  if (state.view === 'daily') {
    label.textContent = `${DAYS_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  } else if (state.view === 'monthly') {
    label.textContent = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  } else {
    const start = getWeekStart(d)
    const end = addDays(start, 6)
    const monthsMatch = start.getMonth() === end.getMonth()
    if (monthsMatch) {
      label.textContent = `${start.getDate()} – ${end.getDate()} ${MONTHS[start.getMonth()]} ${start.getFullYear()}`
    } else {
      label.textContent = `${start.getDate()} ${MONTHS[start.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`
    }
  }
}

function renderMonthly() {
  const grid = document.getElementById('monthly-grid')
  const year = state.currentDate.getFullYear()
  const month = state.currentDate.getMonth()

  const firstDay = getFirstDayOfMonth(year, month)
  const daysInMonth = getDaysInMonth(year, month)
  const daysInPrev = getDaysInMonth(year, month - 1)

  const cells = []
  const today = new Date()

  const isMobileMonth = window.innerWidth < 480
  for (let i = 0; i < 7; i++) {
    const dayIndex = (state.weekStartsOn + i) % 7
    cells.push(`<div class="day-name-header">${isMobileMonth ? DAYS_SHORT[dayIndex].charAt(0) : DAYS_SHORT[dayIndex]}</div>`)
  }

  let startOffset = (firstDay - state.weekStartsOn + 7) % 7

  for (let i = startOffset - 1; i >= 0; i--) {
    const day = daysInPrev - i
    cells.push(`<div class="day-cell other-month"><div class="day-number">${day}</div></div>`)
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = createDate(year, month, day)
    const dateStr = dateKey(date)
    const events = getEventsForDay(date)
    const isToday = isSameDay(date, today)
    const cls = ['day-cell']
    if (isToday) cls.push('today')
    if (events.length > 0) cls.push('covered')

    let indicatorHTML = ''
    if (events.length > 0) {
      const colors = events.map(e => eventColor(e))
      const uniqueColors = [...new Set(colors)]
      const dots = uniqueColors.map(c => `<div class="coverage-dot" style="background:${c}"></div>`).join('')
      indicatorHTML = `<div class="coverage-indicator">${dots}</div>`
    }

    cells.push(`<div class="${cls.join(' ')}" data-date="${dateStr}">
      <div class="day-number">${day}</div>
      ${indicatorHTML}
      ${events.length > 0 && !isMobileMonth ? `<div class="day-event-count">${events.length} evento${events.length !== 1 ? 's' : ''}</div>` : ''}
    </div>`)
  }

  const totalCells = cells.length - 7
  const remaining = 7 - (totalCells % 7)
  if (remaining < 7) {
    for (let day = 1; day <= remaining; day++) {
      cells.push(`<div class="day-cell other-month"><div class="day-number">${day}</div></div>`)
    }
  }

  grid.innerHTML = cells.join('')

  grid.querySelectorAll('.day-cell[data-date]').forEach(el => {
    el.addEventListener('click', () => {
      const dateStr = el.dataset.date
      const parts = dateStr.split('-')
      state.currentDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
      state.view = 'weekly'
      switchView('weekly')
    })
  })
}

function renderWeekly() {
  const container = document.getElementById('weekly-container')
  const start = getWeekStart(state.currentDate)
  const today = new Date()
  const isMobile = window.innerWidth < 480

  const HOUR_HEIGHT = isMobile ? 56 : 72
  const TOTAL_HEIGHT = HOUR_HEIGHT * 24
  const HEADER_H = isMobile ? 44 : 56
  const sidebarW = isMobile ? 48 : 64

  // Build day headers
  let dayHeadersHtml = ''
  for (let d = 0; d < 7; d++) {
    const day = addDays(start, d)
    const iToday = isSameDay(day, today)
    dayHeadersHtml += `<div class="ww-top-day${iToday ? ' ww-today' : ''}">
      <span class="ww-top-name">${isMobile ? DAYS_SHORT[day.getDay()].charAt(0) : DAYS_SHORT[day.getDay()]}</span>
      <span class="ww-top-num">${day.getDate()}</span>
    </div>`
  }

  // Build hour sidebar
  let sideHtml = ''
  for (let h = 0; h < 24; h++) {
    const label = String(h).padStart(2, '0')
    sideHtml += `<div class="ww-hlbl" style="top:${(h/24)*100}%">${label}:00</div>`
  }

  // Build day columns
  let colsHtml = ''
  for (let d = 0; d < 7; d++) {
    const day = addDays(start, d)
    const dayStr = dateKey(day)
    const iToday = isSameDay(day, today)
    const events = getEventsForDay(day)
    const dayStart = normalizeToMidnight(day)

    let evHtml = ''
    for (const evt of events) {
      const startPct = Math.max(0, (evt.start - dayStart) / (24 * 60 * 60 * 1000)) * 100
      const endPct = Math.min(100, (evt.end - dayStart) / (24 * 60 * 60 * 1000)) * 100
      const height = Math.max(1.8, endPct - startPct)
      const col = eventColor(evt)
      const isManual = evt.source === 'manual'
      const note = eventNotes(evt)
      evHtml += `<div class="ww-ev${isManual ? ' ww-ev-manual' : ''}"
        style="top:${startPct}%;height:${height}%;background:${col}"
        data-event-id="${evt.id}"
        title="${evt.title} — ${formatTime(evt.start)}–${formatTime(evt.end)}${note ? '\n' + note : ''}">
        <span class="ww-ev-title">${evt.title}</span>
        <span class="ww-ev-time">${formatTime(evt.start)}</span>
        ${note ? `<span class="ww-ev-note">${note}</span>` : ''}
      </div>`
    }

    // Grid lines
    let gridHtml = ''
    for (let h = 0; h < 24; h++) {
      gridHtml += `<div class="ww-hline${h % 3 === 0 ? ' ww-hline-major' : ''}" style="top:${(h/24)*100}%"></div>`
    }

    colsHtml += `<div class="ww-col${iToday ? ' ww-today' : ''}" data-date="${dayStr}" style="height:${TOTAL_HEIGHT}px">
      ${gridHtml}${evHtml}</div>`
  }

  // CSS Grid: corner | day-headers
  //           sidebar | day-columns
  container.innerHTML = `<div class="ww-grid" style="grid-template-columns:${sidebarW}px 1fr;grid-template-rows:${HEADER_H}px 1fr">
    <div class="ww-corner" style="width:${sidebarW}px;height:${HEADER_H}px">${isMobile ? 'H' : 'Hora'}</div>
    <div class="ww-top-days" style="height:${HEADER_H}px">${dayHeadersHtml}</div>
    <div class="ww-hour-sidebar" style="width:${sidebarW}px;height:${TOTAL_HEIGHT}px">${sideHtml}</div>
    <div class="ww-daycols" style="height:${TOTAL_HEIGHT}px;min-width:400px">${colsHtml}</div>
  </div>`

  // Click events
  container.querySelectorAll('.ww-ev').forEach(el => {
    el.addEventListener('click', function (e) {
      e.stopPropagation()
      const id = this.dataset.eventId
      if (id) showEventDetail(id)
    })
  })

  container.querySelectorAll('.ww-col').forEach(el => {
    el.addEventListener('click', function (e) {
      const dateStr = this.dataset.date
      if (!dateStr) return
      const rect = this.getBoundingClientRect()
      const y = e.clientY - rect.top
      const hour = Math.min(23, Math.max(0, Math.floor(y / HOUR_HEIGHT)))
      const date = new Date(dateStr + 'T00:00:00')
      showNewEvent(date, hour)
    })
  })

  // Scroll to 7:00 AM
  setTimeout(() => {
    const g = container.querySelector('.ww-grid')
    if (g) g.scrollTop = Math.round(7 / 24 * TOTAL_HEIGHT)
  }, 30)
}

function renderDaily() {
  const container = document.getElementById('daily-container')
  const day = state.currentDate
  const today = new Date()
  const isToday = isSameDay(day, today)
  const isMobile = window.innerWidth < 480

  const HOUR_HEIGHT = isMobile ? 60 : 72
  const TOTAL_HEIGHT = HOUR_HEIGHT * 24
  const HEADER_H = isMobile ? 48 : 60
  const sidebarW = isMobile ? 50 : 64
  const dayStr = dateKey(day)

  // Hour sidebar
  let sideHtml = ''
  for (let h = 0; h < 24; h++) {
    sideHtml += `<div class="ww-hlbl" style="top:${(h/24)*100}%">${String(h).padStart(2,'0')}:00</div>`
  }

  // Day column content
  const dayStart = normalizeToMidnight(day)
  const events = getEventsForDay(day)
  let evHtml = ''
  for (const evt of events) {
    const startPct = Math.max(0, (evt.start - dayStart) / (24 * 60 * 60 * 1000)) * 100
    const endPct = Math.min(100, (evt.end - dayStart) / (24 * 60 * 60 * 1000)) * 100
    const height = Math.max(2.5, endPct - startPct)
    const col = eventColor(evt)
    const isManual = evt.source === 'manual'
    const note = eventNotes(evt)
    evHtml += `<div class="ww-ev${isManual ? ' ww-ev-manual' : ''}"
      style="top:${startPct}%;height:${height}%;background:${col}"
      data-event-id="${evt.id}"
      title="${evt.title} — ${formatTime(evt.start)}–${formatTime(evt.end)}${note ? '\n' + note : ''}">
      <span class="ww-ev-title">${evt.title}</span>
      <span class="ww-ev-time">${formatTime(evt.start)}</span>
      ${note ? `<span class="ww-ev-note">${note}</span>` : ''}
    </div>`
  }
  let gridHtml = ''
  for (let h = 0; h < 24; h++) {
    gridHtml += `<div class="ww-hline${h % 3 === 0 ? ' ww-hline-major' : ''}" style="top:${(h/24)*100}%"></div>`
  }

  container.innerHTML = `<div class="ww-grid" style="grid-template-columns:${sidebarW}px 1fr;grid-template-rows:${HEADER_H}px 1fr">
    <div class="ww-corner" style="width:${sidebarW}px;height:${HEADER_H}px">${isMobile ? 'H' : 'Hora'}</div>
    <div class="ww-top-days" style="height:${HEADER_H}px">
      <div class="ww-top-day${isToday ? ' ww-today' : ''}">
        <span class="ww-top-name">${isMobile ? DAYS_SHORT[day.getDay()].charAt(0) : DAYS_LONG[day.getDay()]}</span>
        <span class="ww-top-num">${day.getDate()}</span>
      </div>
    </div>
    <div class="ww-hour-sidebar" style="width:${sidebarW}px;height:${TOTAL_HEIGHT}px">${sideHtml}</div>
    <div class="ww-daycols" style="height:${TOTAL_HEIGHT}px">
      <div class="ww-col${isToday ? ' ww-today' : ''}" data-date="${dayStr}" style="height:${TOTAL_HEIGHT}px">
        ${gridHtml}${evHtml}
      </div>
    </div>
  </div>`

  // Click events
  container.querySelectorAll('.ww-ev').forEach(el => {
    el.addEventListener('click', function (e) {
      e.stopPropagation()
      const id = this.dataset.eventId
      if (id) showEventDetail(id)
    })
  })

  container.querySelectorAll('.ww-col').forEach(el => {
    el.addEventListener('click', function (e) {
      const dateStr = this.dataset.date
      if (!dateStr) return
      const rect = this.getBoundingClientRect()
      const y = e.clientY - rect.top
      const hour = Math.min(23, Math.max(0, Math.floor(y / HOUR_HEIGHT)))
      const date = new Date(dateStr + 'T00:00:00')
      showNewEvent(date, hour)
    })
  })

  // Scroll to 7:00 AM
  setTimeout(() => {
    const g = container.querySelector('.ww-grid')
    if (g) g.scrollTop = Math.round(7 / 24 * TOTAL_HEIGHT)
  }, 30)
}

function updateStats() {
  const covered = document.getElementById('stats-covered')
  const total = document.getElementById('stats-total')
  const statsRow = document.getElementById('stats-row')

  if (state.view === 'daily') {
    const mins = getCoveredMinutesForDay(state.currentDate)
    const hours = Math.round(mins / 6) / 10
    covered.textContent = hours
    statsRow.innerHTML = `<span id="stats-covered">${hours}</span> horas cubiertas hoy &middot; <span id="stats-total">${getAllEvents().length}</span> eventos`
  } else if (state.view === 'weekly') {
    const hours = getCoveredHoursThisWeek()
    covered.textContent = hours
    statsRow.innerHTML = `<span id="stats-covered">${hours}</span> horas cubiertas esta semana &middot; <span id="stats-total">${getAllEvents().length}</span> eventos`
  } else {
    const d = state.currentDate
    const month = d.getMonth()
    const year = d.getFullYear()
    const days = getDaysInMonth(year, month)
    let totalCovered = 0
    for (let day = 1; day <= days; day++) {
      const mins = getCoveredMinutesForDay(createDate(year, month, day))
      if (mins > 0) totalCovered++
    }
    covered.textContent = totalCovered + ' días'
    statsRow.innerHTML = `<span id="stats-covered">${totalCovered} días</span> cubiertos este mes &middot; <span id="stats-total">${getAllEvents().length}</span> eventos`
  }
}

// ---- Navigation ----

function prevPeriod() {
  if (state.view === 'daily') {
    state.currentDate = addDays(state.currentDate, -1)
  } else if (state.view === 'monthly') {
    state.currentDate = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth() - 1, 1)
  } else {
    state.currentDate = addDays(getWeekStart(state.currentDate), -7)
  }
  render()
}

function nextPeriod() {
  if (state.view === 'daily') {
    state.currentDate = addDays(state.currentDate, 1)
  } else if (state.view === 'monthly') {
    state.currentDate = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth() + 1, 1)
  } else {
    state.currentDate = addDays(getWeekStart(state.currentDate), 7)
  }
  render()
}

function goToToday() {
  state.currentDate = new Date()
  render()
}

// ---- View Switching ----

function switchView(view) {
  state.view = view

  document.querySelectorAll('.btn-toggle').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view)
  })

  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === view + '-view')
  })

  render()
}

// ---- Manual Events ----

function addManualEvent(data) {
  const event = {
    id: generateId(),
    title: data.title,
    start: data.start,
    end: data.end,
    color: data.color || '#B5EAD7',
    source: 'manual',
    description: '',
    location: '',
  }

  if (event.end <= event.start) {
    showToast('La hora de fin debe ser posterior a la de inicio.', true)
    return false
  }

  state.manualEvents.push(event)
  saveState()
  render()
  showToast(`Evento "${event.title}" añadido.`)
  return true
}

function deleteManualEvent(id) {
  const idx = state.manualEvents.findIndex(e => e.id === id)
  if (idx === -1) return
  const title = state.manualEvents[idx].title
  state.manualEvents.splice(idx, 1)
  saveState()
  render()
  closeModal('modal-detail')
  showToast(`Evento "${title}" eliminado.`)
}

// ---- Event Helpers ----

function eventColor(evt) {
  const o = state.eventOverrides[evt.id]
  return (o && o.color) || evt.color || '#B5EAD7'
}

function eventNotes(evt) {
  const o = state.eventOverrides[evt.id]
  return (o && o.notes) || ''
}

function populateTimeSelects() {
  for (const prefix of ['event-start', 'event-end']) {
    const hSel = document.getElementById(prefix + '-h')
    const mSel = document.getElementById(prefix + '-m')
    if (!hSel || hSel.options.length > 1) continue
    for (let h = 0; h < 24; h++) {
      const v = String(h).padStart(2, '0')
      hSel.appendChild(new Option(v, v))
    }
    for (let m = 0; m < 60; m += 15) {
      const v = String(m).padStart(2, '0')
      mSel.appendChild(new Option(v, v))
    }
  }
}

function getTimeVal(prefix) {
  return document.getElementById(prefix + '-h').value + ':' + document.getElementById(prefix + '-m').value
}

function setTimeVal(prefix, val) {
  const [h, m] = val.split(':')
  document.getElementById(prefix + '-h').value = h.padStart(2, '0')
  document.getElementById(prefix + '-m').value = (m || '00').padStart(2, '0')
}

function showNewEvent(date, hour) {
  const hh = String(hour).padStart(2, '0')
  document.getElementById('event-date').value = dateKey(date)
  setTimeVal('event-start', hh + ':00')
  setTimeVal('event-end', hh + ':30')
  document.getElementById('event-title').value = ''
  openModal('modal-add')
}

// ---- Event Detail ----

const DETAIL_COLORS = [
  '#B5EAD7', '#F4C2C2', '#D5B5EB', '#B5D8EB', '#FAD5B5', '#FDF5B5',
  '#C2E0F4', '#E8C2F4', '#F4E0C2', '#C2F4E0', '#F4C2E0', '#E0F4C2',
]

function showEventDetail(id) {
  const allEvents = getAllEvents()
  const event = allEvents.find(e => e.id === id)
  if (!event) return

  const modal = document.getElementById('modal-detail')
  document.getElementById('detail-title').textContent = event.title

  const body = document.getElementById('detail-body')
  const isManual = event.source === 'manual'

  let hours = (event.end - event.start) / (1000 * 60 * 60)
  hours = Math.round(hours * 100) / 100

  const currentColor = eventColor(event)
  const currentNotes = eventNotes(event)

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${currentColor}"></span>
      <span style="font-weight:600;color:var(--text-primary)">${formatDate(event.start)}</span>
    </div>
    <p style="margin-bottom:6px">🕐 <strong>${formatTime(event.start)}</strong> — <strong>${formatTime(event.end)}</strong> (${hours}h)</p>
    ${event.description ? `<p style="margin-top:6px">📝 ${event.description}</p>` : ''}
    ${event.location ? `<p style="margin-top:4px">📍 ${event.location}</p>` : ''}
    <p style="margin-top:8px;font-size:12px;color:var(--text-muted)">
      ${isManual ? '📝 Evento manual' : '📅 Calendario sincronizado'}
    </p>

    <hr style="margin:14px 0;border:none;border-top:1px solid var(--border)">

    <div style="margin-bottom:12px">
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Color personalizado</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px" id="detail-colors">${DETAIL_COLORS.map(c =>
        `<button class="dc-swatch${c === currentColor ? ' dc-active' : ''}" data-color="${c}" style="background:${c};width:28px;height:28px;border-radius:50%;border:3px solid ${c === currentColor ? 'var(--text-primary)' : 'transparent'};cursor:pointer"></button>`
      ).join('')}</div>
    </div>

    <div style="margin-bottom:12px">
      <label for="detail-notes" style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Nota personal</label>
      <textarea id="detail-notes" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-family:var(--font);font-size:13px;resize:vertical;min-height:50px">${currentNotes}</textarea>
    </div>

    <div style="display:flex;gap:6px">
      <button class="btn btn-primary" id="btn-save-override" style="flex:1">Guardar cambios</button>
      ${isManual ? `<button class="btn btn-ghost" id="btn-delete-event" style="color:#B05050">🗑</button>` : ''}
    </div>
  `

  // Color swatch click
  body.querySelectorAll('.dc-swatch').forEach(sw => {
    sw.addEventListener('click', function () {
      body.querySelectorAll('.dc-swatch').forEach(s => {
        s.classList.remove('dc-active')
        s.style.borderColor = 'transparent'
      })
      this.classList.add('dc-active')
      this.style.borderColor = 'var(--text-primary)'
    })
  })

  // Save overrides
  document.getElementById('btn-save-override').addEventListener('click', () => {
    const activeSwatch = body.querySelector('.dc-swatch.dc-active')
    const newColor = activeSwatch ? activeSwatch.dataset.color : currentColor
    const newNotes = document.getElementById('detail-notes').value.trim()

    if (newColor !== currentColor || newNotes !== currentNotes) {
      state.eventOverrides[event.id] = { color: newColor, notes: newNotes }
      saveState()
      render()
      showToast('Cambios guardados')
    }
    closeModal('modal-detail')
  })

  // Delete manual event
  const delBtn = document.getElementById('btn-delete-event')
  if (delBtn) {
    delBtn.addEventListener('click', () => deleteManualEvent(id))
  }

  modal.classList.remove('hidden')
}

// ---- Modals ----

function openModal(id) {
  document.getElementById(id).classList.remove('hidden')
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden')
}

// ---- UI Helpers ----

function setLoading(isLoading) {
  state.isLoading = isLoading
  document.getElementById('loading').classList.toggle('hidden', !isLoading)
}

function setError(msg) {
  state.error = msg
  const el = document.getElementById('error')
  if (msg) {
    el.textContent = msg
    el.classList.remove('hidden')
  } else {
    el.classList.add('hidden')
  }
}

function clearError() {
  setError(null)
}

function showToast(msg, isError) {
  let toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = `
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      padding:12px 20px;border-radius:8px;font-size:13px;font-weight:500;
      background:#3D3D3D;color:white;z-index:200;
      transition:opacity 0.3s,transform 0.3s;
      opacity:0;pointer-events:none;
      max-width:90vw;text-align:center;
      font-family:var(--font);
    `
    document.body.appendChild(toast)
  }

  toast.textContent = msg
  toast.style.background = isError ? '#C0392B' : '#3D3D3D'
  toast.style.opacity = '1'
  toast.style.transform = 'translateX(-50%) translateY(0)'

  clearTimeout(toast._hideTimeout)
  toast._hideTimeout = setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transform = 'translateX(-50%) translateY(10px)'
  }, 3000)
}

function showBanner(show) {
  document.getElementById('info-banner').classList.toggle('hidden', !show)
}

// ---- Initialization ----

async function init() {
  const hasData = await loadState()

  showBanner(false)
  if (state.icalUrl && state.icalUrl !== '(archivo local)') {
    loadICAL(state.icalUrl)
  } else {
    if (!state.icalUrl && !state.manualEvents.length) showBanner(true)
    render()
  }

  // Desktop fallback: no daily view
  if (!IS_MOBILE && state.view === 'daily') {
    state.view = 'weekly'
  }

  // Populate time selects and set defaults
  populateTimeSelects()
  const today = new Date()
  document.getElementById('event-date').value = dateKey(today)
  setTimeVal('event-start', '09:00')
  setTimeVal('event-end', '10:00')

  if (state.icalUrl && state.icalUrl !== '(archivo local)') {
    document.getElementById('ical-url').value = state.icalUrl
  }

  // Activate the current view toggle
  document.querySelectorAll('.btn-toggle').forEach(b => {
    b.classList.toggle('active', b.dataset.view === state.view)
  })
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === state.view + '-view')
  })

  // ---- Event Listeners ----

  document.getElementById('btn-prev').addEventListener('click', prevPeriod)
  document.getElementById('btn-next').addEventListener('click', nextPeriod)
  document.getElementById('btn-today').addEventListener('click', goToToday)

  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('active')) {
        switchView(btn.dataset.view)
        document.getElementById('mobile-menu').classList.add('hidden')
      }
    })
  })

  document.getElementById('btn-add').addEventListener('click', () => {
    showNewEvent(new Date(), 9)
  })

  document.getElementById('btn-settings').addEventListener('click', () => {
    openModal('modal-settings')
  })

  document.getElementById('btn-refresh').addEventListener('click', () => {
    refreshCalendar()
  })

  // Hamburger menu
  const menuEl = document.getElementById('mobile-menu')
  document.getElementById('btn-menu').addEventListener('click', () => {
    menuEl.classList.toggle('hidden')
  })
  menuEl.addEventListener('click', (e) => {
    if (e.target === menuEl) menuEl.classList.add('hidden')
  })
  document.getElementById('mobile-btn-add').addEventListener('click', () => {
    menuEl.classList.add('hidden')
    showNewEvent(new Date(), 9)
  })
  document.getElementById('mobile-btn-refresh').addEventListener('click', () => {
    menuEl.classList.add('hidden')
    refreshCalendar()
  })
  document.getElementById('mobile-btn-settings').addEventListener('click', () => {
    menuEl.classList.add('hidden')
    openModal('modal-settings')
  })

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.dataset.modal
      if (modal) closeModal(modal)
    })
  })

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.add('hidden')
      }
    })
  })

  document.getElementById('form-add-event').addEventListener('submit', (e) => {
    e.preventDefault()

    const title = document.getElementById('event-title').value.trim()
    const dateStr = document.getElementById('event-date').value
    const startTime = getTimeVal('event-start')
    const endTime = getTimeVal('event-end')
    const colorEl = document.querySelector('input[name="event-color"]:checked')
    const color = colorEl ? colorEl.value : '#B5EAD7'

    if (!title) {
      showToast('El título es obligatorio.', true)
      return
    }

    const start = new Date(`${dateStr}T${startTime}:00`)
    const end = new Date(`${dateStr}T${endTime}:00`)

    if (addManualEvent({ title, start, end, color })) {
      document.getElementById('form-add-event').reset()
      populateTimeSelects()
      const today = new Date()
      document.getElementById('event-date').value = dateKey(today)
      setTimeVal('event-start', '09:00')
      setTimeVal('event-end', '10:00')
      closeModal('modal-add')
    }
  })

  document.getElementById('form-settings').addEventListener('submit', (e) => {
    e.preventDefault()
    const url = document.getElementById('ical-url').value.trim()
    if (url) {
      closeModal('modal-settings')
      loadICAL(url)
    }
  })

  document.getElementById('ical-file').addEventListener('change', (e) => {
    const file = e.target.files[0]
    if (!file) return
    loadICSFromFile(file)
  })

  document.getElementById('btn-banner-start').addEventListener('click', () => {
    showBanner(false)
    openModal('modal-settings')
  })

  document.getElementById('btn-banner-dismiss').addEventListener('click', () => {
    showBanner(false)
  })

  document.querySelectorAll('.color-option').forEach(opt => {
    opt.addEventListener('click', function () {
      document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'))
      this.classList.add('selected')
      this.querySelector('input').checked = true
    })
  })

  state.initialized = true
}

document.addEventListener('DOMContentLoaded', init)
