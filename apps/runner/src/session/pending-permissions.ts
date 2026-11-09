/**
 * Counts `session/request_permission` requests that are waiting for an answer. The permission
 * handler calls `begin()` when a request arrives and the returned function when it is answered;
 * the Session watches the count so its idle timer never runs while a request is pending
 * (agent-runner Requirement 9.18).
 */
export class PendingPermissions {
  readonly #listeners = new Set<() => void>();
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /** Marks one request pending; the returned function ends it (calling it twice is harmless). */
  begin(): () => void {
    this.#count += 1;
    this.#notify();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#count -= 1;
      this.#notify();
    };
  }

  /** Called after every change of the count. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
