import type { CsvRow, QualityIssue } from './types.js'

export interface CsvParseResult {
  rows: CsvRow[]
  issues: Map<number, QualityIssue[]>
}

function addIssue(
  issues: Map<number, QualityIssue[]>,
  recordNumber: number,
  code: string,
  message: string,
): void {
  const rowIssues = issues.get(recordNumber) ?? []
  rowIssues.push({ code, message, severity: 'error' })
  issues.set(recordNumber, rowIssues)
}

/**
 * Parses RFC 4180-style CSV, including commas, escaped quotes and newlines in
 * quoted values. Parsing errors are attached to their record instead of
 * throwing, so an upload can still report all recoverable quality problems.
 */
export function parseCsv(input: string): CsvParseResult {
  const rows: CsvRow[] = []
  const issues = new Map<number, QualityIssue[]>()
  let values: string[] = []
  let field = ''
  let quoted = false
  let quoteClosed = false
  let recordNumber = 1
  let atFieldStart = true
  let hasContent = false

  const finishRow = (): void => {
    values.push(field)
    rows.push({ recordNumber, values })
    values = []
    field = ''
    quoted = false
    quoteClosed = false
    atFieldStart = true
    hasContent = false
    recordNumber += 1
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          quoteClosed = true
        }
      } else {
        field += character
      }
      hasContent = true
      continue
    }

    if (quoteClosed) {
      if (character === ',') {
        values.push(field)
        field = ''
        quoteClosed = false
        atFieldStart = true
        hasContent = true
        continue
      }
      if (character === '\n' || character === '\r') {
        if (character === '\r' && input[index + 1] === '\n') index += 1
        finishRow()
        continue
      }
      addIssue(issues, recordNumber, 'invalid_csv_quote', 'Unexpected text after a closing CSV quote.')
      quoteClosed = false
      field += character
      atFieldStart = false
      hasContent = true
      continue
    }

    if (character === '"') {
      if (!atFieldStart) {
        addIssue(issues, recordNumber, 'invalid_csv_quote', 'A CSV quote must begin a field.')
        field += character
      } else {
        quoted = true
      }
      hasContent = true
      continue
    }
    if (character === ',') {
      values.push(field)
      field = ''
      atFieldStart = true
      hasContent = true
      continue
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index += 1
      finishRow()
      continue
    }

    field += character
    atFieldStart = false
    hasContent = true
  }

  if (quoted) {
    addIssue(issues, recordNumber, 'unterminated_csv_quote', 'CSV field has an opening quote without a closing quote.')
  }
  if (hasContent || values.length > 0 || field.length > 0) finishRow()

  if (rows[0]?.values[0]?.charCodeAt(0) === 0xfeff) {
    rows[0].values[0] = rows[0].values[0].slice(1)
  }

  return { rows, issues }
}
