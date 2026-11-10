/** Native Compute RPC adapter. Results cross the boundary as JSON strings.
 *
 *  Importing this module loads the native addon, so modules that only need
 *  Compute logic must not import it at module scope. */
import {
  computeCheck as nativeCheck,
  computeCreate as nativeCreate,
  computeDelete as nativeDelete,
  computeDiscover as nativeDiscover,
  computeList as nativeList,
  computeProbe as nativeProbe,
  computeUpdate as nativeUpdate,
} from '../../native/index.js'
import { nativeJson } from '../task/native-result.js'
import type { ComputeCandidate, ComputeMachine, MachinePatch, NewMachine, ProbeResult } from './types.js'

function available(fn: unknown): void {
  if (typeof fn !== 'function') throw new Error('This evot build has no compute support; run /update')
}

/** Rust validation errors arrive as `conf error: …`; the prefix is noise. */
function clean<T>(operation: string, result: () => Promise<unknown>): Promise<T> {
  return nativeJson<T>(operation, result()).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error)
    throw new Error(text.replace(/^(?:conf|store) error:\s*/i, ''))
  })
}

export async function listMachines(): Promise<ComputeMachine[]> {
  available(nativeList)
  return clean('List compute machines', () => nativeList())
}

export async function discoverMachines(): Promise<ComputeCandidate[]> {
  available(nativeDiscover)
  return clean('Discover machines', () => nativeDiscover())
}

export async function probeMachine(target: string): Promise<ProbeResult> {
  available(nativeProbe)
  return clean('Check machine', () => nativeProbe(target))
}

export async function createMachine(input: NewMachine): Promise<ComputeMachine> {
  available(nativeCreate)
  return clean('Add machine', () => nativeCreate(JSON.stringify(input)))
}

export async function updateMachine(id: string, patch: MachinePatch): Promise<ComputeMachine> {
  available(nativeUpdate)
  return clean('Update machine', () => nativeUpdate(id, JSON.stringify(patch)))
}

export async function deleteMachine(id: string): Promise<boolean> {
  available(nativeDelete)
  // Async addon failures resolve to an Error value rather than rejecting.
  const result: unknown = await nativeDelete(id)
  if (result instanceof Error) throw new Error(result.message.replace(/^(?:conf|store) error:\s*/i, ''))
  return result === true
}

export async function checkMachine(id: string): Promise<ComputeMachine> {
  available(nativeCheck)
  return clean('Check machine', () => nativeCheck(id))
}
