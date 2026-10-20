// Chrome 111 (the Leaf5C browser) predates Promise.withResolvers, so keep a
// small local helper instead of relying on it at runtime.
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
