/**
 * Result类型 - 用于函数式错误处理
 * 灵感来自Rust的Result<T, E>类型
 */

export type Result<T, E = Error> = Success<T> | Failure<E>;

export interface Success<T> {
  ok: true;
  value: T;
}

export interface Failure<E> {
  ok: false;
  error: E;
}

/**
 * 创建成功的Result
 */
export function Ok<T>(value: T): Success<T> {
  return { ok: true, value };
}

/**
 * 创建失败的Result
 */
export function Err<E>(error: E): Failure<E> {
  return { ok: false, error };
}

/**
 * 检查Result是否成功
 */
export function isOk<T, E>(result: Result<T, E>): result is Success<T> {
  return result.ok === true;
}

/**
 * 检查Result是否失败
 */
export function isErr<T, E>(result: Result<T, E>): result is Failure<E> {
  return result.ok === false;
}

/**
 * 从Result中安全地提取值，失败时返回默认值
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return isOk(result) ? result.value : defaultValue;
}

/**
 * 从Result中提取值，失败时抛出错误
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.value;
  }
  throw result.error;
}

/**
 * 映射Result的成功值
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  return isOk(result) ? Ok(fn(result.value)) : result;
}

/**
 * 映射Result的错误值
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  return isErr(result) ? Err(fn(result.error)) : result;
}

/**
 * 链式调用，用于连续的可能失败的操作
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return isOk(result) ? fn(result.value) : result;
}

/**
 * 将Promise包装为Result
 */
export async function fromPromise<T>(
  promise: Promise<T>
): Promise<Result<T, Error>> {
  try {
    const value = await promise;
    return Ok(value);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * 将可能抛出错误的函数包装为返回Result的函数
 */
export function tryCatch<T, A extends any[]>(
  fn: (...args: A) => T
): (...args: A) => Result<T, Error> {
  return (...args: A) => {
    try {
      return Ok(fn(...args));
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/**
 * 将可能抛出错误的异步函数包装为返回Result的函数
 */
export function tryAsync<T, A extends any[]>(
  fn: (...args: A) => Promise<T>
): (...args: A) => Promise<Result<T, Error>> {
  return async (...args: A) => {
    try {
      const value = await fn(...args);
      return Ok(value);
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/**
 * 组合多个Result，全部成功才返回成功
 */
export function all<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];

  for (const result of results) {
    if (isErr(result)) {
      return result;
    }
    values.push(result.value);
  }

  return Ok(values);
}

/**
 * 组合多个Result，返回第一个成功的，或最后一个错误
 */
export function any<T, E>(results: Result<T, E>[]): Result<T, E[]> {
  const errors: E[] = [];

  for (const result of results) {
    if (isOk(result)) {
      return result;
    }
    errors.push(result.error);
  }

  return Err(errors);
}

/**
 * 对Result执行副作用，不修改Result本身
 */
export function tap<T, E>(
  result: Result<T, E>,
  onOk?: (value: T) => void,
  onErr?: (error: E) => void
): Result<T, E> {
  if (isOk(result) && onOk) {
    onOk(result.value);
  } else if (isErr(result) && onErr) {
    onErr(result.error);
  }
  return result;
}

/**
 * 匹配Result的成功或失败情况并执行相应的处理
 */
export function match<T, E, U>(
  result: Result<T, E>,
  handlers: {
    ok: (value: T) => U;
    err: (error: E) => U;
  }
): U {
  return isOk(result) ? handlers.ok(result.value) : handlers.err(result.error);
}

/**
 * 使用示例：
 *
 * // 基本使用
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) {
 *     return Err('除数不能为0');
 *   }
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (isOk(result)) {
 *   console.log('结果:', result.value); // 5
 * } else {
 *   console.error('错误:', result.error);
 * }
 *
 * // 链式调用
 * const finalResult = divide(10, 2)
 *   .pipe(map(x => x * 2))
 *   .pipe(andThen(x => divide(x, 5)))
 *   .pipe(unwrapOr(0));
 *
 * // 异步操作
 * const asyncResult = await fromPromise(fetch('/api/data'));
 * match(asyncResult, {
 *   ok: data => console.log('成功:', data),
 *   err: error => console.error('失败:', error)
 * });
 */
