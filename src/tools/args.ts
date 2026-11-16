// Tool arguments come from the model and are untrusted. These readers validate one field each and
// throw InvalidArgumentError, which the executor turns into an `input.invalid` tool error.

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

type Input = Record<string, unknown>;

const describe = (value: unknown): string => (Array.isArray(value) ? 'array' : typeof value);

export const requireString = (input: Input, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`'${key}' must be a string, got ${describe(value)}`);
  }
  return value;
};

export const requireNonEmptyString = (input: Input, key: string): string => {
  const value = requireString(input, key);
  if (value.length === 0) throw new InvalidArgumentError(`'${key}' must not be empty`);
  return value;
};

export const optionalString = (input: Input, key: string): string | undefined => {
  if (input[key] === undefined || input[key] === null) return undefined;
  return requireString(input, key);
};

export const optionalBoolean = (input: Input, key: string): boolean | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new InvalidArgumentError(`'${key}' must be a boolean, got ${describe(value)}`);
  }
  return value;
};

export const optionalInteger = (
  input: Input,
  key: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidArgumentError(`'${key}' must be an integer, got ${describe(value)}`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new InvalidArgumentError(`'${key}' must be >= ${bounds.min}, got ${value}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new InvalidArgumentError(`'${key}' must be <= ${bounds.max}, got ${value}`);
  }
  return value;
};

export const optionalStringArray = (input: Input, key: string): string[] | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new InvalidArgumentError(`'${key}' must be an array of strings`);
  }
  return value;
};
