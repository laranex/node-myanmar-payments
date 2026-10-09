/**
 * A JSON number kept as the exact text the gateway sent, so `1000.50` stays `1000.50` and large
 * integers keep every digit. Only used internally while verifying signatures and reading values.
 *
 * @internal
 */
export class JsonNumber {
  constructor(readonly text: string) {}
}

/** A value decoded by {@link parseJson}: numbers are {@link JsonNumber}s. @internal */
export type LosslessValue =
  string | boolean | null | JsonNumber | LosslessValue[] | { [key: string]: LosslessValue };

/** A decoded JSON object whose numbers are {@link JsonNumber}s. @internal */
export type LosslessObject = { [key: string]: LosslessValue };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Parses strict JSON (RFC 8259) without passing numbers through a float. Returns `undefined` when
 * the text is not valid JSON.
 *
 * @internal
 */
export function parseJson(text: string): LosslessValue | undefined {
  const parser = new Parser(text);
  try {
    parser.skipWhitespace();
    const value = parser.value();
    parser.skipWhitespace();
    return parser.done() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses JSON and returns it only when it is an object (not an array, string or null).
 *
 * @internal
 */
export function parseJsonObject(text: string): LosslessObject | undefined {
  const value = parseJson(text);
  return isLosslessObject(value) ? value : undefined;
}

/** @internal */
export function isLosslessObject(value: unknown): value is LosslessObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
  );
}

/**
 * Converts a lossless value to plain JavaScript values for the `raw` fields of results. Numbers
 * become their exact text as a string (`1000.50` stays `"1000.50"`), so no precision is lost.
 *
 * @internal
 */
export function toPlain(value: LosslessValue): unknown {
  if (value instanceof JsonNumber) {
    return value.text;
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (value !== null && typeof value === 'object') {
    return toPlainObject(value);
  }
  return value;
}

/** @internal */
export function toPlainObject(value: LosslessObject): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    setKey(result, key, toPlain(value[key] as LosslessValue));
  }
  return result;
}

/** Sets a key without letting `__proto__` change the object's prototype. @internal */
export function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.index === this.text.length;
  }

  skipWhitespace(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
        return;
      }
      this.index++;
    }
  }

  value(): LosslessValue {
    const char = this.text[this.index];
    switch (char) {
      case '{':
        return this.object();
      case '[':
        return this.array();
      case '"':
        return this.string();
      case 't':
        return this.literal('true', true);
      case 'f':
        return this.literal('false', false);
      case 'n':
        return this.literal('null', null);
      default:
        return this.number();
    }
  }

  private object(): LosslessObject {
    this.index++;
    const result: LosslessObject = {};
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        throw new SyntaxError('Expected a string key');
      }
      const key = this.string();
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      setKey(result, key, this.value());
      this.skipWhitespace();
      if (this.text[this.index] === ',') {
        this.index++;
        continue;
      }
      this.expect('}');
      return result;
    }
  }

  private array(): LosslessValue[] {
    this.index++;
    const result: LosslessValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.value());
      this.skipWhitespace();
      if (this.text[this.index] === ',') {
        this.index++;
        continue;
      }
      this.expect(']');
      return result;
    }
  }

  private string(): string {
    this.index++;
    let result = '';
    for (;;) {
      if (this.index >= this.text.length) {
        throw new SyntaxError('Unterminated string');
      }
      const char = this.text[this.index] as string;
      if (char === '"') {
        this.index++;
        return result;
      }
      if (char === '\\') {
        result += this.escape();
        continue;
      }
      if (char < ' ') {
        throw new SyntaxError('Control character in string');
      }
      result += char;
      this.index++;
    }
  }

  private escape(): string {
    const char = this.text[this.index + 1];
    this.index += 2;
    switch (char) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new SyntaxError('Invalid unicode escape');
        }
        this.index += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        throw new SyntaxError('Invalid escape');
    }
  }

  private literal<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.index)) {
      throw new SyntaxError(`Expected ${word}`);
    }
    this.index += word.length;
    return value;
  }

  private number(): JsonNumber {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (match === null) {
      throw new SyntaxError('Unexpected token');
    }
    this.index += match[0].length;
    return new JsonNumber(match[0]);
  }

  private expect(char: string): void {
    if (this.text[this.index] !== char) {
      throw new SyntaxError(`Expected ${char}`);
    }
    this.index++;
  }
}
