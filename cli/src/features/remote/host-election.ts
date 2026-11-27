import { Database } from 'bun:sqlite'
import { connect } from 'node:net'
import { join } from 'node:path'

/** Ephemeral, per-profile coordination in the existing uid-private socket directory.
 * The small ballot transaction never spans an await. A separate kernel-backed
 * SQLite writer lock covers the *physical* start/drain of both listeners, even
 * if a newer ballot arrives in the middle. Process death releases that lock. */
interface Ballot { epoch: number; target: string | null; previous: string | null; reserved: number; port: number; error: string | null }
export class HostElection {
  private readonly db: Database
  private readonly lock: Database
  private locked = false
  constructor(dir: string, scope: string, readonly id: string, private port = 0) {
    if (!/^[a-f0-9]{24}$/.test(scope)) throw Error('Invalid host scope.')
    const prefix = join(dir, `host-v1-${scope}`)
    this.db = new Database(prefix + '.db')
    this.lock = new Database(prefix + '.lease')
    this.lock.exec('PRAGMA busy_timeout=0')
    this.db.exec(`PRAGMA busy_timeout=500; CREATE TABLE IF NOT EXISTS election (
      singleton INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, target TEXT, previous TEXT, reserved INTEGER NOT NULL, port INTEGER NOT NULL, error TEXT);
      INSERT OR IGNORE INTO election VALUES (1,0,NULL,NULL,0,0,NULL)`)
  }
  ballot(): Ballot { return this.db.query<Ballot, []>('SELECT * FROM election').get()! }
  request(explicit: boolean) {
    return this.db.transaction(() => {
      const b = this.ballot()
      if (explicit && b.target && b.port !== this.port) throw Error('Host uses different Console port settings.')
      if (explicit || !b.target) this.db.query('UPDATE election SET epoch=epoch+1,target=?,port=?,error=NULL').run(this.id,this.port)
      return this.ballot()
    }).immediate()
  }
  acquire() {
    if (this.locked) return true
    try { this.lock.exec('BEGIN IMMEDIATE'); this.locked = true; return true }
    catch (err) { if ((err as {code?:string}).code === 'SQLITE_BUSY') return false; throw err }
  }
  release() { if (this.locked) { this.lock.exec('ROLLBACK'); this.locked = false } }
  ready(epoch: number) {
    return !!this.db.query(`UPDATE election SET epoch=epoch+(previous IS NOT target OR reserved!=0),
      previous=target,reserved=0 WHERE epoch=? AND target=?`).run(epoch,this.id).changes
  }
  /** A failed/dead target restores the last *committed* owner, never another speculative starter. */
  reject(b: Ballot, error: string | null = null) {
    return !!this.db.query(`UPDATE election SET epoch=epoch+1,target=NULLIF(previous,target),
      previous=NULLIF(previous,target),reserved=CASE WHEN previous=target THEN 0 ELSE reserved END,error=? WHERE epoch=? AND target=?`).run(error,b.epoch,b.target).changes
  }
  /** Bump the fence before closing the terminal socket: a peer may already be probing it. */
  reserve(now: number) {
    this.db.query('UPDATE election SET epoch=epoch+(target=previous),reserved=? WHERE previous=?').run(now + 30_000,this.id)
  }
  leave() {
    this.db.transaction(() => {
      this.db.query('UPDATE election SET previous=NULL,reserved=0 WHERE previous=?').run(this.id)
      const b = this.ballot()
      if (b.target === this.id) this.reject(b)
    }).immediate()
  }
  close() { this.release(); this.lock.close(); this.db.close() }
}

/** A timeout or an unresponsive event loop is not evidence of death. */
export function windowGone(dir: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid host window.')
  return new Promise<boolean>(resolve => {
    const socket = connect(join(dir,id + '.sock'))
    const finish = (gone: boolean) => { socket.destroy(); resolve(gone) }
    socket.once('connect', () => finish(false)).once('error', e => finish(['ENOENT','ECONNREFUSED'].includes((e as NodeJS.ErrnoException).code ?? '')))
      .setTimeout(500, () => finish(false))
  })
}
