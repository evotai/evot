/* Runtime loader — kept separate from napi's generated package entry point. */
import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { loadNativeBinding } from './binding-loader.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const binding = loadNativeBinding({
  platform: process.platform,
  arch: process.arch,
  moduleDir: __dirname,
  execPath: process.execPath,
  evotHome: process.env.EVOT_HOME || join(homedir(), '.evotai'),
  exists: existsSync,
  load: require,
})

export const NapiAgent = binding.NapiAgent
export const version = binding.version
export const startServer = binding.startServer
export const startServerBackground = binding.startServerBackground
export const stopServerBackground = binding.stopServerBackground
export const fastExit = binding.fastExit
export const reapExitedChildren = binding.reapExitedChildren
export const authBegin = binding.authBegin
export const authPoll = binding.authPoll
export const authLogout = binding.authLogout
export const authSyncModels = binding.authSyncModels
export const authSyncNotices = binding.authSyncNotices
export const authWhoami = binding.authWhoami
export const authRefreshSession = binding.authRefreshSession
export const authNotices = binding.authNotices
export const taskList = binding.taskList
export const taskDeliveryDefaults = binding.taskDeliveryDefaults
export const taskGet = binding.taskGet
export const taskCreate = binding.taskCreate
export const taskUpdate = binding.taskUpdate
export const taskDelete = binding.taskDelete
export const taskRun = binding.taskRun
export const taskShare = binding.taskShare
export const taskShareFetch = binding.taskShareFetch
export const taskShareId = binding.taskShareId
