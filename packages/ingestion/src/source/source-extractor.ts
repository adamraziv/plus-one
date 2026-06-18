import { PlusOneError } from '@plus-one/contracts';
import { canonicalizeJson } from '@plus-one/runtime';

export interface ExtractedRawRow {
  sourceRowNumber: number;
  sourceRowIdentity: string;
  rawPayload: unknown;
}

export class SourceExtractor {
  extract(input: { mediaType: string; parserVersion: string; bytes: Buffer }): ExtractedRawRow[] {
    if (input.mediaType === 'application/json' && input.parserVersion === 'json-v1') {
      const parsed = JSON.parse(input.bytes.toString('utf8')) as unknown;
      if (!Array.isArray(parsed)) return this.fail('JSON source must be an array');
      return parsed.map((rawPayload, index) => ({
        sourceRowNumber: index + 1,
        sourceRowIdentity: `json-row-${index + 1}`,
        rawPayload: JSON.parse(canonicalizeJson(rawPayload)) as unknown,
      }));
    }

    if (input.mediaType === 'text/csv' && input.parserVersion === 'csv-v1') {
      const lines = input.bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
      if (lines.length < 2) return this.fail('CSV source must contain a header and a row');
      const headers = this.csvLine(lines[0]!);
      return lines.slice(1).map((line, index) => {
        const values = this.csvLine(line);
        if (values.length !== headers.length) return this.fail(`CSV row ${index + 2} width mismatch`);
        return {
          sourceRowNumber: index + 2,
          sourceRowIdentity: `csv-row-${index + 2}`,
          rawPayload: Object.fromEntries(headers.map((header, column) => [header, values[column]!])),
        };
      });
    }

    return this.fail('Unsupported source media type or parser version');
  }

  private csvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (char === '"' && line[index + 1] === '"' && quoted) {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (quoted) return this.fail('Unterminated CSV quote');
    result.push(current);
    return result;
  }

  private fail(message: string): never {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'source_extraction_invalid',
      message,
      retry: 'never',
      receiptLookupRequired: false,
      details: {},
    });
  }
}
