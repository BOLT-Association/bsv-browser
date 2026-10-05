// expo-sqlite -> node:sqlite shim for the live tests (the real engine, in memory), so the
// real StorageExpoSQLite and its schema run headlessly. Same shape as the shim in
// __tests__/manual/restoreRepro.test.ts.
const { DatabaseSync } = require('node:sqlite')

const toParams = params =>
  (params ?? []).map(p => {
    if (p === undefined) return null
    if (p instanceof Uint8Array) return p
    if (Array.isArray(p)) return Uint8Array.from(p)
    if (p instanceof Date) return p.toISOString()
    if (typeof p === 'boolean') return p ? 1 : 0
    return p
  })

class Db {
  constructor() {
    this.d = new DatabaseSync(':memory:')
  }
  async execAsync(sql) {
    this.d.exec(sql)
  }
  async runAsync(sql, params) {
    const r = this.d.prepare(sql).run(...toParams(params))
    return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) }
  }
  async getFirstAsync(sql, params) {
    return this.d.prepare(sql).get(...toParams(params)) ?? null
  }
  async getAllAsync(sql, params) {
    return this.d.prepare(sql).all(...toParams(params))
  }
  async withExclusiveTransactionAsync(fn) {
    this.d.exec('BEGIN')
    try {
      await fn(this)
      this.d.exec('COMMIT')
    } catch (e) {
      this.d.exec('ROLLBACK')
      throw e
    }
  }
  async closeAsync() {
    this.d.close()
  }
}

module.exports = {
  openDatabaseAsync: async () => new Db(),
  deleteDatabaseAsync: async () => {}
}
