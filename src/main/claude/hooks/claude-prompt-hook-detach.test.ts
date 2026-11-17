import { runProcess } from '@orca/process-host'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { getManagedScript } from './hook-script'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('Claude prompt hook', () => {
  it('returns before Orca answers its post, and a later event still posts after it', async () => {
    const received: string[] = []
    const held: ServerResponse[] = []
    let promptPostAborted = false
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const event = /"hook_event_name":"(\w+)"/.exec(body)?.[1] ?? '?'
        received.push(event)
        if (event === 'UserPromptSubmit') {
          res.on('close', () => (promptPostAborted = !res.writableEnded))
          held.push(res)
          return
        }
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const dir = mkdtempSync(join(tmpdir(), 'orca-prompt-hook-'))
    dirs.push(dir)
    const script = join(dir, 'claude-hook.sh')
    writeFileSync(script, getManagedScript('posix', { decidesPreToolUse: true }))
    const endpoint = join(dir, 'endpoint.env')
    writeFileSync(
      endpoint,
      `ORCA_AGENT_HOOK_PORT=${port}\nORCA_AGENT_HOOK_TOKEN=t\nORCA_AGENT_HOOK_TRANSPORT=raw-json-v1\n`
    )
    const run = (event: string) =>
      runProcess({
        program: '/bin/sh',
        args: [script],
        env: {
          PATH: '/usr/bin:/bin',
          ORCA_AGENT_HOOK_ENDPOINT: endpoint,
          ORCA_PANE_KEY: 'tab-1:1',
          ORCA_TAB_ID: 'tab-1'
        },
        input: `{"session_id":"s","hook_event_name":"${event}"}`,
        timeoutMs: 10_000
      })

    try {
      const prompt = await run('UserPromptSubmit')
      expect(prompt.stdout).toBe('{}\n')
      // The hook exited while Orca still held its post open, so Claude never waited on it.
      expect(promptPostAborted).toBe(false)

      const stop = run('Stop')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(received).toEqual(['UserPromptSubmit'])
      held.forEach((res) => res.writeHead(204).end())
      expect((await stop).stdout).toBe('{}\n')
      expect(received).toEqual(['UserPromptSubmit', 'Stop'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
