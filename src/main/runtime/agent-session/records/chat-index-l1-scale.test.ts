// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
// Scratch benchmark for chat-index-l1 PR1 (not committed). Same file runs on base and head.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  storedTestAgentSessionRecord,
  withTestAgentSessionDatabase
} from './agent-session-record-store-persistence.test-fixture'
import { openTestAgentSessionDatabase, closeTestAgentSessionDatabase } from './agent-session-record-store-test-harness'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { StructuredAgentSessionLeaseRenewer } from '../../../native-chat/agent-session-wire/host/structured-agent-session-lease-renewer'
import { structuredAgentSessionNamingSnapshot } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed-deps'

const SIZES = (process.env.L1_SIZES ?? '1000,10000,18000').split(',').map(Number)
const LIVE = 150
const SAVED_AT = 1000

function seedRow(index: number, live: boolean) {
  const sessionId = `${live ? 'live' : 'idle'}-${String(index).padStart(6, '0')}`
  const lease = agentSessionLeaseFixture(
    live
      ? { sessionId }
      : { sessionId, claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null }
  )
  return storedTestAgentSessionRecord({
    ...agentSessionRecordFixture(lease),
    conversationName: `Chat ${index} about a reasonably long topic name`,
    updatedAt: SAVED_AT
  })
}

async function seeded(total: number, live: number) {
  const root = await mkdtemp(join(tmpdir(), 'l1-bench-'))
  const journalDatabase = await openTestAgentSessionDatabase(root)
  const liveIds: string[] = []
  await withTestAgentSessionDatabase(root, (db) => {
    const insert = db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
    db.exec('BEGIN')
    for (let i = 0; i < total; i++) {
      const row = seedRow(i, i < live)
      if (i < live) liveIds.push(row.sessionId)
      insert.run(row.sessionId, JSON.stringify(row))
    }
    db.exec('COMMIT')
  })
  let effects = 0
  const original = journalDatabase.effects.bind(journalDatabase)
  journalDatabase.effects = (async (...args: Parameters<typeof original>) => {
    effects++
    return original(...args)
  }) as typeof journalDatabase.effects
  return { root, journalDatabase, liveIds, effects: () => effects }
}

const count = (root: string, where: string) =>
  withTestAgentSessionDatabase(root, (db) =>
    Number(db.prepare(`SELECT count(*) AS n FROM agent_session_records WHERE ${where}`).get()!.n)
  )

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never

it('chat-index-l1 scale', { timeout: 1_800_000 }, async () => {
  const results: unknown[] = []
  for (const total of SIZES) {
    // Startup: install + restart reconciliation, every recorded owner gone.
    const a = await seeded(total, LIVE)
    let t = performance.now()
    const records = await a.journalDatabase.installRecords()
    const installMs = performance.now() - t
    const markedRows = await count(a.root, "json_extract(record_json,'$.lease.unreconciled')=1")
    const store = AgentSessionRecordStore.open({
      journalDatabase: a.journalDatabase,
      records,
      hostId: 'local',
      legacySessionTabIds: []
    })
    const unreconciledInMemory = store.listRecords().filter((r) => r.lease.unreconciled).length
    let probed = 0
    const effectsBefore = a.effects()
    t = performance.now()
    await store.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      probeMany: async (list) => {
        probed += list.length
        return new Map(list.map((r) => [r.sessionId, { outcome: 'pid-absent' as const }]))
      },
      now: 5000
    })
    const reconcileMs = performance.now() - t
    const reconcileWriterCalls = a.effects() - effectsBefore
    const rewrittenByReconcile = await count(a.root, `json_extract(record_json,'$.updatedAt')<>${SAVED_AT}`)
    // Naming snapshot: what each status subscribe sends (wire unchanged by PR1).
    t = performance.now()
    const naming = structuredAgentSessionNamingSnapshot({
      getConversation: store.getConversation,
      listConversations: store.listConversations,
      namingActiveSessionIds: () => [],
      namingFailure: () => undefined
    } as never)
    const namingBuildMs = performance.now() - t
    const namingBytes = Buffer.byteLength(JSON.stringify(naming))
    // Renewer with nothing held (all evicted above).
    const idleRenewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'pid-absent' }),
      holdsLiveChild: () => false,
      now: () => 6000,
      logger
    })
    const idleTicks = 50
    const idleEffects0 = a.effects()
    t = performance.now()
    for (let i = 0; i < idleTicks; i++) await idleRenewer.renewNow()
    const idleTickMs = (performance.now() - t) / idleTicks
    const idleWriterCallsPerTick = (a.effects() - idleEffects0) / idleTicks
    await closeTestAgentSessionDatabase(a.root)
    await rm(a.root, { recursive: true, force: true })

    // Renewer with 150 live, reconciled leases (persisted state, no install).
    const b = await seeded(total, LIVE)
    const liveStore = AgentSessionRecordStore.open({
      journalDatabase: b.journalDatabase,
      records: await b.journalDatabase.loadRecords(),
      hostId: 'local',
      legacySessionTabIds: []
    })
    const liveSet = new Set(b.liveIds)
    let now = 10_000
    const liveRenewer = new StructuredAgentSessionLeaseRenewer({
      store: liveStore,
      probe: async () => ({ outcome: 'pid-absent' }),
      holdsLiveChild: (id) => liveSet.has(id),
      now: () => (now += 1000),
      logger
    })
    const liveTicks = 20
    const liveEffects0 = b.effects()
    const cpu0 = process.cpuUsage()
    t = performance.now()
    for (let i = 0; i < liveTicks; i++) await liveRenewer.renewNow()
    const liveTickMs = (performance.now() - t) / liveTicks
    const cpu = process.cpuUsage(cpu0)
    const liveWriterCallsPerTick = (b.effects() - liveEffects0) / liveTicks
    const renewedRows = await count(b.root, `json_extract(record_json,'$.lease.lastRenewedAt')>10000`)
    await closeTestAgentSessionDatabase(b.root)
    await rm(b.root, { recursive: true, force: true })

    results.push({
      total,
      live: LIVE,
      installMs: +installMs.toFixed(1),
      markedRows,
      unreconciledInMemory,
      probed,
      reconcileMs: +reconcileMs.toFixed(1),
      reconcileWriterCalls,
      rewrittenByReconcile,
      namingBytes,
      namingBuildMs: +namingBuildMs.toFixed(2),
      idleTickMs: +idleTickMs.toFixed(3),
      idleWriterCallsPerTick,
      liveTickMs: +liveTickMs.toFixed(2),
      liveMainCpuUsPerTick: Math.round((cpu.user + cpu.system) / liveTicks),
      liveWriterCallsPerTick,
      renewedRows
    })
  }
  console.log('L1-BENCH ' + JSON.stringify(results))
})
