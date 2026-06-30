// =============================================================================
// CSV builders for History / export (pure functions, easy to unit test)
// -----------------------------------------------------------------------------
// Produce spreadsheet-friendly CSV from a dataset's order line items and
// shipments. RFC-4180-ish quoting: wrap a field in double quotes if it contains
// a comma, quote, or newline, and double any embedded quotes.
// =============================================================================

function csvField(value) {
  const s = value == null ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')]
  for (const row of rows) lines.push(row.map(csvField).join(','))
  // CRLF line endings are the most spreadsheet-compatible.
  return lines.join('\r\n')
}

/** Orders (line items) CSV. `src` = { event:{name,date}, orders:[...] }. */
function ordersCsv(src) {
  const event = (src && src.event) || {}
  const orders = (src && src.orders) || []
  const headers = ['Event', 'Event Date', 'Order ID', 'Customer', 'Handle', 'New', 'Break', 'Team', 'Price', 'Type']
  const rows = orders.map((o) => [
    event.name || '',
    event.date || '',
    o.orderId,
    (o.customer && o.customer.realName) || '',
    (o.customer && o.customer.handle) || '',
    o.customer && o.customer.isNew ? 'yes' : 'no',
    o.breakNumber,
    o.teamName,
    (Number(o.price) || 0).toFixed(2),
    o.isGiveaway ? 'Giveaway' : 'Paid',
  ])
  return toCsv(headers, rows)
}

/** Shipping CSV. `src` = { event, shipments:[...] }. */
function shippingCsv(src) {
  const event = (src && src.event) || {}
  const shipments = (src && src.shipments) || []
  const headers = ['Event', 'Event Date', 'Customer', 'Handle', 'Tracking', 'Service', 'Weight (oz)', 'Status', 'Status Set By', 'Notes', 'Breaks / Teams']
  const rows = shipments.map((s) => {
    const breaks = (s.breaks || []).map((b) => `Break #${b.breakNumber}: ${(b.teams || []).join(' / ')}`).join(' | ')
    return [
      event.name || '',
      event.date || '',
      (s.customer && s.customer.realName) || '',
      (s.customer && s.customer.handle) || '',
      s.trackingNumber || '',
      s.serviceType || '',
      s.weightOz != null ? s.weightOz : '',
      (s.manualStatus && s.manualStatus.code) || '',
      (s.manualStatus && s.manualStatus.setBy) || '',
      s.notes || '',
      breaks,
    ]
  })
  return toCsv(headers, rows)
}

module.exports = { csvField, toCsv, ordersCsv, shippingCsv }
