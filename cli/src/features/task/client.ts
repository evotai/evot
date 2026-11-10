/** Native Task RPC adapter: the task operations cross the boundary as JSON
 *  strings and are decoded by `native-result.ts`.
 *
 *  Importing this module loads the native addon, so host modules that only
 *  need Task logic must not import it at module scope. */
import {
  taskCreate as nativeCreate,
  taskDelete as nativeDelete,
  taskDeliveryDefaults as nativeDeliveryDefaults,
  taskGet as nativeGet,
  taskList as nativeList,
  taskRun as nativeRun,
  taskShare as nativeShare,
  taskShareFetch as nativeShareFetch,
  taskUpdate as nativeUpdate,
} from '../../native/index.js'
import type {
  CreatedTaskResponse,
  ScheduledTask,
  TaskDeliveryDefaults,
  TaskListResponse,
  TaskRunSummary,
  TaskShareCreated,
  TaskShareSnapshot,
} from './types.js'
import { nativeJson } from './native-result.js'

export async function taskDeliveryDefaults(envFile?: string): Promise<TaskDeliveryDefaults> {
  return nativeJson('Resolve task delivery', nativeDeliveryDefaults(envFile ?? null))
}

export async function listTasks(): Promise<TaskListResponse> {
  return nativeJson('List tasks', nativeList())
}

export async function getTask(id: string): Promise<ScheduledTask & { runs: TaskRunSummary[] }> {
  return nativeJson('Get task', nativeGet(id))
}

export async function createTask(
  input: Record<string, unknown>,
  envFile?: string,
): Promise<CreatedTaskResponse> {
  return nativeJson('Create task', nativeCreate(JSON.stringify(input), envFile ?? null))
}

export async function updateTask(
  id: string,
  input: Record<string, unknown>,
  envFile?: string,
): Promise<CreatedTaskResponse> {
  return nativeJson('Update task', nativeUpdate(id, JSON.stringify(input), envFile ?? null))
}

export async function deleteTask(id: string): Promise<void> {
  await nativeDelete(id)
}

export async function runTask(id: string): Promise<void> {
  await nativeRun(id, crypto.randomUUID())
}

/** Publish a task's definition as an unlisted link. Masked server-side. */
export async function shareTask(id: string): Promise<TaskShareCreated> {
  return nativeJson('Share task', nativeShare(id))
}

/** Read a shared task by link or id, from this client's own server. */
export async function fetchTaskShare(link: string): Promise<TaskShareSnapshot> {
  return nativeJson('Fetch shared task', nativeShareFetch(link))
}
