import type { BackgroundProcess } from '../../../native/contracts/results.js'

/** Display-only run scope: never removes retained engine tasks or output. */
export class BackgroundVisibility {
  private hidden = new Set<string>()
  begin(processes: BackgroundProcess[]): void {
    this.hidden = new Set(processes.filter(process => !this.live(process)).map(process => process.task_id))
  }
  visible(processes: BackgroundProcess[]): BackgroundProcess[] {
    return processes.filter(process => this.live(process) || !this.hidden.has(process.task_id))
  }
  private live(process: BackgroundProcess): boolean {
    return process.status === 'running' || process.status === 'running_foreground'
  }
}
