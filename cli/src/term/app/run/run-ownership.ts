/**
 * Serial ownership token for asynchronous REPL runs.
 *
 * Native stream abort settles asynchronously. Revoking the current token
 * before aborting prevents the old Promise's catch/finally blocks from
 * mutating state owned by a newer run.
 */
export class RunOwnership {
  private generation = 0

  /** Stable from setup through streaming, including the pre-stream await. */
  get owner(): number { return this.generation }

  begin(): number {
    this.generation++
    return this.generation
  }

  owns(generation: number): boolean {
    return generation === this.generation
  }

  revoke(): void {
    this.generation++
  }
}
