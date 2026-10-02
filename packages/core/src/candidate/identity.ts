import type { JsonValue } from '#internal/contracts/json';
import { isJsonArray } from '#internal/validation/json';

/** Canonical JSON preserves array order and sorts object keys by UTF-16 code units. */
export function canonicalJson(value: JsonValue): string {
  const parts: string[] = [];
  const pending: ({ value: JsonValue } | { text: string })[] = [{ value }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if ('text' in item) {
      parts.push(item.text);
      continue;
    }
    const current = item.value;
    if (current === null || typeof current !== 'object') {
      parts.push(JSON.stringify(current));
    } else if (isJsonArray(current)) {
      const items: readonly JsonValue[] = current;
      parts.push('[');
      pending.push({ text: ']' });
      for (let index = items.length - 1; index >= 0; index -= 1) {
        pending.push({ value: items[index]! });
        if (index > 0) pending.push({ text: ',' });
      }
    } else {
      const object = current;
      const keys = Object.keys(object).sort();
      parts.push('{');
      pending.push({ text: '}' });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        pending.push({ value: object[key]! });
        pending.push({ text: `${JSON.stringify(key)}:` });
        if (index > 0) pending.push({ text: ',' });
      }
    }
  }
  return parts.join('');
}
