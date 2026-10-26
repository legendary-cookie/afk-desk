// The React Native side (App.tsx engineCommand) sends a numeric, incrementing
// requestId. Accept that, plus non-empty strings, and echo it back unchanged
// so the app can resolve its pending promise.
function isRequestId(value) {
  return (Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && value.length > 0)
}

function validateCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Engine command must be an object.')
  if (!isRequestId(value.requestId)) throw new Error('Engine command requestId must be a positive integer or non-empty string.')
  if (typeof value.action !== 'string' || !value.action) throw new Error('Engine command action must be a non-empty string.')
  return value
}

module.exports = { validateCommand, isRequestId }
