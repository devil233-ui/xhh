/**
 * #过码服务状态 —— 过码链路体检
 *
 * 补上游 v3 那套运维能力的短板（它是围绕自己内置 service 写的，这里对着我们本机的
 * /root/geetest-solver，pm2 名 geetest-solver）。回答三件事：
 *   1 服务在不在（配置的地址能不能连上）
 *   2 是不是我们的服务（pm2 进程表里有没有同名进程，别把别人占的端口当自己的）
 *   3 现在能不能用（熔断状态）
 * 顺带报一下手动过码的远端兜底地址与端口，出问题时一眼看清链路。
 */
import plugin from '../../../lib/plugins/plugin.js'
import net from 'node:net'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '#xhh'
import { breakerState } from '../utils/captchaVerify.js'

const execAsync = promisify(exec)
const PM2_NAME = 'geetest-solver'

function parseAddr(addr = '') {
  try {
    const u = new URL(addr)
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }
  } catch (_) {
    return null
  }
}

async function portOpen(host, port, timeout = 2000) {
  return await new Promise(resolve => {
    const sock = net.connect({ host, port })
    const done = v => {
      try { sock.destroy() } catch (_) {}
      resolve(v)
    }
    sock.setTimeout(timeout, () => done(false))
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

async function pm2Status(name) {
  try {
    const { stdout } = await execAsync('pm2 jlist', { timeout: 8000 })
    const list = JSON.parse(stdout.slice(stdout.indexOf('[')))
    const hit = list.find(p => p.name === name)
    return hit ? hit.pm2_env?.status || 'unknown' : null
  } catch (_) {
    return undefined // pm2 不可用/输出异常：说不准
  }
}

export class geetestStatus extends plugin {
  constructor() {
    super({
      name: '过码服务状态',
      dsc: '过码链路体检（服务在不在 / 是不是我们的 / 能不能用）',
      event: 'message',
      priority: 200,
      rule: [{ reg: '^#过码服务状态$', fnc: 'status' }],
    })
  }

  async status(e) {
    if (!e.isMaster) return false
    const addr = String(config().auto_verify_addr || '').trim()
    const target = parseAddr(addr)
    const lines = ['【过码服务状态】']
    if (!addr) {
      lines.push('✗ 没配 auto_verify_addr：撞码时只会提示等待重试，不会自动过码')
    } else if (!target) {
      lines.push(`✗ auto_verify_addr 不是合法地址：${addr}`)
    } else {
      const open = await portOpen(target.host, target.port)
      lines.push(`${open ? '✓' : '✗'} 服务端口 ${target.host}:${target.port} ${open ? '可连接' : '连不上（服务没起或被挡）'}`)
      const st = await pm2Status(PM2_NAME)
      if (st === null) lines.push(`✗ pm2 里没有 ${PM2_NAME}：端口可能被别的进程占着，或服务是手工起的（重启会丢）`)
      else if (st === undefined) lines.push('? pm2 状态读不到（没装 pm2 或输出异常），无法判断进程归属')
      else lines.push(`${st === 'online' ? '✓' : '✗'} pm2 进程 ${PM2_NAME}: ${st}`)
    }
    const b = breakerState()
    lines.push(
      b.open
        ? `⚡ 熔断中：连续失败 ${b.fails} 次，约 ${b.retryAfter} 秒后自动半开重试`
        : `✓ 未熔断${b.fails ? `（上次连续失败 ${b.fails} 次）` : ''}`,
    )
    const manual = String(config().manual_gt_remote_addr || '').trim()
    if (manual) lines.push(`· 手动过码远端兜底：${manual.slice(0, 60)}`)
    const mport = Number(config().manual_gt_port || 8767)
    lines.push(`· 手动过码端口 ${mport}：${(await portOpen('127.0.0.1', mport)) ? '在监听' : '没监听'}`)
    await e.reply(lines.join('\n'))
    return true
  }
}
