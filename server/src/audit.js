function cleanDetails(details) {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  )
}

export function audit(event, details = {}) {
  const record = {
    level: 'audit',
    time: new Date().toISOString(),
    event,
    ...cleanDetails(details),
  }
  console.log(JSON.stringify(record))
}
