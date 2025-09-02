import { InstanceBase, InstanceStatus, Regex, runEntrypoint } from '@companion-module/base'
import WebSocket from 'ws'
import crypto from 'crypto'

class SidusInstance extends InstanceBase {
  async init(config) {
    this.config = config
    this.updateStatus(InstanceStatus.Disconnected)
    this.setActionDefinitions({
      test_ping: {
        name: 'Test: get_protocol_versions',
        options: [],
        callback: async () => {
          try {
            const resp = await this.#send('get_protocol_versions')
            this.updateStatus(InstanceStatus.Ok, `Protocol: ${JSON.stringify(resp.data)}`)
          } catch (e) {
            this.updateStatus(InstanceStatus.UnknownError, String(e))
            this.log('error', String(e))
          }
        },
      },
    })
  }
  getConfigFields() {
    return [
      { type: 'textinput', id: 'apiKey', label: 'API Secret Key (base64, 32 bytes)', width: 12, default: '', regex: Regex.SOMETHING },
      { type: 'textinput', id: 'wsUrl', label: 'WebSocket URL', width: 12, default: 'ws://127.0.0.1:12345', regex: Regex.SOMETHING },
    ]
  }
  async configUpdated(config) { this.config = config }
  #lastTokenSecond = -1
  async #token() {
    const now = Math.floor(Date.now() / 1000)
    if (now === this.#lastTokenSecond) {
      const msLeft = 1020 - (Date.now() - now * 1000)
      if (msLeft > 0) await new Promise(r => setTimeout(r, msLeft))
    }
    this.#lastTokenSecond = Math.floor(Date.now() / 1000)
    const key = Buffer.from((this.config?.apiKey || '').trim(), 'base64')
    if (key.length !== 32) throw new Error('Invalid API key (base64 32 bytes)')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ts = String(this.#lastTokenSecond)
    const ciphertext = Buffer.concat([cipher.update(ts, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ciphertext]).toString('base64')
  }
  async #send(action, { node_id, args } = {}) {
    const url = this.config?.wsUrl || 'ws://127.0.0.1:12345'
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    try {
      const token = await this.#token()
      const request_id = crypto.randomUUID()
      const req = { version: 2, type: 'request', client_id: 1, request_id, action, token }
      if (node_id) req.node_id = node_id
      if (args) req.args = args
      const wait = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('Timeout')), 6000)
        const onMsg = (raw) => {
          try {
            const m = JSON.parse(raw.toString())
            let rid = m.request_id
            if (!rid && m.request && typeof m.request === 'object') rid = m.request.request_id
            if (m.type === 'response' && rid === request_id) {
              clearTimeout(to); ws.off('message', onMsg); resolve(m)
            }
          } catch {}
        }
        ws.on('message', onMsg)
      })
      ws.send(JSON.stringify(req))
      const resp = await wait
      if (Number(resp?.code) !== 0) throw new Error(`API error on '${action}': ${resp?.code} ${resp?.message}`)
      return resp
    } finally { try { ws.close() } catch {} }
  }
}
runEntrypoint(SidusInstance)
