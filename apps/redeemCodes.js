/**
 * 三游戏兑换码：手动兑换 + 自动订阅。
 *
 * 移植自 xhh-TL（cchanlan）的 apps/redeemCodes.js（提交 4ae715d + 23eae30）。
 * 与上游的差异集中在两处，兑换流程与风控细节保持原样：
 *   · 账号：消息里直接用 e.user，定时任务用 NoteUser.create(qq)（master 的既有做法，
 *     见 system/sign.js 的 zd_MysSign），不引入 TL 的 userBind/signAccounts。
 *   · 推送：优先用订阅时记录的 bot（Bot[sub.bot]），取不到才退回全局 Bot；TL 直接用 root[sub.bot]。
 *   · 补 cookie_token：用 utils/ckRefresh.js 的 findStokenEntry + stokenToCookie
 *     （那份代码本身就是从 TL 的 auth.js 裁剪来的，注释里写着）。
 *   · redis 键换成 xhh: 前缀，跟 master 其他模块一致。
 *   · 开关走 config().redeem，提示语用 master 的 #扫码登录。
 *
 * 兑换是写操作，冷却与锁按 uid 粒度跨消息、跨手动/自动共享——同一账号并发撞接口
 * 会直接吃风控，比兑换失败更难恢复。
 */
import crypto from 'node:crypto'
import { config, sleep, pluginPriority } from '#xhh'
import NoteUser from '../../genshin/model/mys/NoteUser.js'
import { findStokenEntry, stokenToCookie, cookiePart } from '../utils/ckRefresh.js'
import {
  GAMES, SEEN_TTL, TERMINAL, MESSAGES, COMMAND_REG,
  parseCommand, getCodes, getAutoCodes, getRoles, redeemCode,
} from '../utils/redeemClient.js'

/** 订阅表：hash，field = [bot, qq, game]，value = 订阅 JSON */
const SUBS = 'xhh:ycdk:auto:subs'
/** 已兑换状态：key = xhh:ycdk:seen:<game>:<uid>:<code> */
const SEEN = 'xhh:ycdk:seen'
/** 单账号锁 15 分钟，够跑完一轮；进程被杀也不会永久锁死 */
const LOCK_TTL = 900
/** 两次兑换之间的冷却，跨请求共享；短了会被判定频繁操作 */
const COOLDOWN_MS = 6500
const NEXT_TTL = 30
/** 自动任务里同一账号最多试三次，超过就等下一批新码 */
const MAX_ATTEMPTS = 3
/** 登录失效类返回码：这个号剩下的码不用再试 */
const AUTH_FAILED = [-1071, -1033, -1035, -100, -2016]
const REPORT_CHUNK = 12

const inflight = new Set()
let polling = false

/** 引用开关：与 apps/captchaNotice.js 同一判定，配置里没这一项时默认引用 */
const quoteEnabled = () => {
  try { return config().reply_quote !== false } catch { return true }
}

/** 模块开关：默认开，锅巴里能一键关掉 */
const enabled = () => {
  try { return config().redeem !== false } catch { return true }
}

function safeParse(raw) {
  try { return JSON.parse(raw) || {} } catch { return {} }
}

/**
 * redis v4 的解锁：先比 value 再删，锁过期后不能把别人的锁删掉。
 * （上游同款实现，撤锁的原子性靠 Lua 保证）
 */
async function unlock(key, value) {
  await redis.eval(
    'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
    { keys: [key], arguments: [value] },
  )
}

/**
 * 收集某游戏下该用户的全部「uid + 归属通行证」。
 * 只认 mysUsers 里有归属的 uid：只注册没绑 CK 的 UID 不进列表，
 * 也不会把别人的 CK 混进来（上游 getSignAccounts 的同一约束）。
 */
function collectAccounts(user, game) {
  const mysUsers = user?.mysUsers || {}
  const accounts = new Map()
  const add = (uid, ltuid) => {
    if (!uid || !ltuid) return
    uid = String(uid)
    ltuid = String(ltuid)
    const mys = mysUsers[ltuid]
    if (!/^\d+$/.test(uid) || !mys) return
    const owned = (mys.uids?.[game] || []).map(String)
    if (owned.length && !owned.includes(uid)) return
    const existing = accounts.get(uid)
    // 同一 uid 挂在两个通行证下是数据异常，跳过这条而不是抛错炸掉整批兑换
    if (existing && existing.ltuid !== ltuid) return
    accounts.set(uid, { uid, ltuid, ck: mys.ck || '' })
  }
  for (const [ltuid, mys] of Object.entries(mysUsers)) {
    for (const uid of mys?.uids?.[game] || []) add(uid, ltuid)
  }
  return [...accounts.values()]
}

export class redeemCodes extends plugin {
  constructor() {
    super({
      name: '[小花火]兑换码',
      dsc: '三游戏国服手动兑换与自动订阅',
      event: 'message',
      priority: pluginPriority('redeem', -100),
      rule: [{ reg: COMMAND_REG, fnc: 'handle' }],
    })
    this.task = {
      // 每 10 分钟一次，避开整点风控高峰
      cron: '17 */10 * * * *',
      name: '[小花火]自动兑换码',
      fnc: () => this.runAll(),
      log: false,
    }
  }

  /** 同一个人在同一游戏同一条线下的订阅键 */
  subKey(e, game) {
    return JSON.stringify([String(e.self_id || e.bot?.uin || ''), String(e.user_id), game])
  }

  /** 消息里有 e.user 就用；定时任务没有 e，按 QQ 号现造一个 */
  async userOf(e, qq) {
    if (e?.user?.mysUsers) return e.user
    const id = String(qq || e?.user_id || '')
    if (!id) return null
    try {
      return await NoteUser.create(id)
    } catch (err) {
      logger.warn(`[xhh][兑换码] 读取用户 ${id} 失败: ${err.message}`)
      return null
    }
  }

  async handle(e) {
    const cmd = parseCommand(e.msg)
    if (!cmd) return false
    const game = GAMES[cmd.game]
    const prefix = ({ gs: '#', sr: '*', zzz: '%' })[cmd.game]
    const reply = msg => e.reply(msg, quoteEnabled())
    try {
      const key = this.subKey(e, cmd.game)

      // 关闭与查状态：功能被管理员关掉时也要能用，否则用户没法把自己摘出去
      if (cmd.action === 'off') {
        await redis.hDel(SUBS, key)
        await reply(`已关闭${game.name}自动兑换码`)
        return true
      }
      if (cmd.action === 'status') {
        const on = !!(await redis.hGet(SUBS, key))
        const off = enabled() ? '' : '（功能已被管理员关闭）'
        await reply(`${game.name}自动兑换码：${on ? '已开启' : '未开启'}${off}`)
        return true
      }
      if (!enabled()) {
        await reply('兑换码功能已被管理员关闭')
        return true
      }
      if (cmd.action === 'usage') {
        await reply([
          `${prefix}使用兑换码：兑换近期收录的码`,
          `${prefix}使用兑换码 兑换码：使用指定的码，多个码用空格分隔，最多 20 个`,
          `${prefix}自动兑换码开启 / ${prefix}自动兑换码关闭 / ${prefix}自动兑换码状态`,
          `三游戏通用：#原神使用兑换码 / #星铁使用兑换码 / #绝区零使用兑换码`,
        ].join('\n'))
        return true
      }

      const user = await this.userOf(e)
      const accounts = user ? collectAccounts(user, cmd.game) : []
      if (!accounts.length) {
        await reply(`请先发送 #扫码登录 绑定${game.name}账号后再试`)
        return true
      }

      if (cmd.action === 'on') {
        const sub = {
          qq: String(e.user_id),
          bot: String(e.self_id || e.bot?.uin || ''),
          group: e.isGroup ? String(e.group_id) : '',
          game: cmd.game,
        }
        await redis.hSet(SUBS, key, JSON.stringify(sub))
        await reply(`已开启${game.name}自动兑换码，仅兑换官方前瞻直播码，每 10 分钟检查一次；结果发到${sub.group ? '本群' : '私聊'}`)
        return true
      }

      if (inflight.has(key)) {
        await reply('兑换进行中，请稍后再试')
        return true
      }
      inflight.add(key)
      try {
        let codes = cmd.codes
        if (!codes) {
          const list = await getCodes(cmd.game)
          codes = list.map(x => x.code)
        }
        if (!codes.length) {
          await reply('暂无近期收录的兑换码')
          return true
        }
        await reply(`开始兑换${game.name}兑换码，请稍候`)
        const results = await this.exchange({ game: cmd.game, qq: String(e.user_id), accounts, codes })
        await this.report(reply, cmd.game, results)
      } finally {
        inflight.delete(key)
      }
    } catch (err) {
      logger.error(`[xhh][兑换码] 指令处理失败: ${err.message}`)
      await reply('兑换码操作失败，请稍后再试')
    }
    return true
  }

  /**
   * 拿到可兑换的 ck：兑换接口只认 Cookie，没有 cookie_token 时用 stoken 现换。
   * 换出来的 ck 必须确实属于这个通行证，否则查角色会串号。
   */
  async credentials(qq, account, game) {
    const { uid, ltuid } = account
    let ck = account.ck
    if (!/cookie_token(?:_v2)?=/.test(ck)) {
      for (const probe of [uid, ltuid]) {
        try {
          const entry = findStokenEntry(qq, probe)
          if (!entry) continue
          const owner = String(entry.stuid || entry.ltuid || '')
          if (owner && owner !== ltuid) continue
          const full = await stokenToCookie(entry)
          if (/cookie_token(?:_v2)?=/.test(full || '')) {
            ck = full
            break
          }
        } catch (err) {
          logger.debug?.(`[xhh][兑换码] ${qq}/${probe} stoken→ck 失败: ${err.message}`)
        }
      }
    }
    const owner = cookiePart(ck, 'account_id_v2') || cookiePart(ck, 'account_id')
      || cookiePart(ck, 'ltuid_v2') || cookiePart(ck, 'ltuid')
    if (!/cookie_token(?:_v2)?=/.test(ck) || (owner && owner !== ltuid)) {
      return { ck: '', retcode: -1071, roles: [] }
    }
    try {
      const { roles, retcode } = await getRoles(game, ck)
      return { ck, retcode, roles }
    } catch (err) {
      logger.warn(`[xhh][兑换码] ${game}/${uid} 查角色失败: ${err.message}`)
      return { ck, retcode: null, roles: [] }
    }
  }

  async exchange({ game, qq, accounts, codes, subscription = null }) {
    const results = []
    const credCache = new Map()
    for (const account of accounts) {
      const { uid } = account
      const lockKey = `${SEEN}:lock:${game}:${uid}`
      const token = crypto.randomBytes(16).toString('hex')
      if (!await redis.set(lockKey, token, { NX: true, EX: LOCK_TTL })) {
        if (!subscription) results.push(`${uid}：兑换进行中，请稍后再试`)
        continue
      }
      try {
        // 已兑换 / 超过三次尝试的码不再打接口；手动兑换不受此限，每次都试
        const pending = []
        for (const code of codes) {
          const stateKey = `${SEEN}:${game}:${uid}:${code}`
          const state = safeParse(await redis.get(stateKey))
          if (!subscription || (!state.done && (state.attempts || 0) < MAX_ATTEMPTS)) {
            pending.push({ code, stateKey, state })
          }
        }
        if (!pending.length) continue

        let cred = credCache.get(account.ltuid)
        if (!cred) {
          cred = await this.credentials(qq, account, game)
          credCache.set(account.ltuid, cred)
        }
        const role = cred.roles.find(r => String(r.game_uid) === uid)
        if (cred.retcode !== 0 || !role) {
          results.push(`${uid}：${MESSAGES[cred.retcode] || '请发送 #扫码登录 重新绑定账号'}`)
          // 登录失效不算「已兑换」；自动任务最多三轮，手动不受影响
          for (const p of pending) {
            await redis.set(p.stateKey, JSON.stringify({ attempts: (p.state.attempts || 0) + 1 }), { EX: SEEN_TTL })
          }
          continue
        }

        for (const { code, stateKey, state } of pending) {
          if (!enabled()) break
          if (subscription && await redis.hGet(SUBS, subscription.key) !== subscription.raw) break

          // 冷却跨消息、跨自动/手动共享，不只在单批 sleep
          const nextKey = `${SEEN}:next:${game}:${uid}`
          const wait = Math.min(COOLDOWN_MS, Math.max(0, Number(await redis.get(nextKey) || 0) - Date.now()))
          if (wait) await sleep(wait)

          // 等冷却期间可能被别的请求抢了锁，或被取消订阅 / 关掉模块
          if (await redis.get(lockKey) !== token || !enabled()) break
          if (subscription && await redis.hGet(SUBS, subscription.key) !== subscription.raw) break

          let result
          try {
            result = await redeemCode(game, role, cred.ck, code)
          } catch (err) {
            logger.warn(`[xhh][兑换码] ${game}/${uid}/${code} 请求失败: ${err.message}`)
            result = { retcode: null, msg: '兑换失败，请稍后再试' }
          }
          await redis.set(nextKey, String(Date.now() + COOLDOWN_MS), { EX: NEXT_TTL })
          await redis.set(stateKey, JSON.stringify({
            done: TERMINAL.has(result.retcode),
            attempts: (state.attempts || 0) + 1,
            retcode: result.retcode,
          }), { EX: SEEN_TTL })
          results.push(`${uid} · ${code}：${result.msg}`)

          if (AUTH_FAILED.includes(result.retcode)) break
        }
      } catch (err) {
        logger.error(`[xhh][兑换码] ${game}/${uid} 处理失败: ${err.message}`)
        results.push(`${uid}：兑换失败，请稍后再试`)
      } finally {
        try { await unlock(lockKey, token) } catch (_) {}
      }
    }
    return results
  }

  async report(reply, game, lines) {
    if (!lines.length) return
    // 多账号、多码的结果会超消息长度限制，按条切片发
    for (let i = 0; i < lines.length; i += REPORT_CHUNK) {
      await reply(`${GAMES[game].name}兑换结果：\n${lines.slice(i, i + REPORT_CHUNK).join('\n')}`)
    }
  }

  /** 把自动兑换结果发回订阅时的群 / 私聊 */
  async push(sub, lines) {
    const text = `自动兑换码 · ${sub.qq}\n${lines.join('\n')}`
    try {
      const bot = (sub.bot && Bot?.[sub.bot]) || Bot
      const target = sub.group
        ? bot?.pickGroup?.(Number(sub.group))
        : bot?.pickFriend?.(Number(sub.qq))
      if (!target?.sendMsg) {
        logger.warn(`[xhh][兑换码] 目标不可用: ${sub.group || sub.qq}`)
        return
      }
      await target.sendMsg(text)
    } catch (err) {
      logger.warn(`[xhh][兑换码] 自动结果推送失败: ${err.message}`)
    }
  }

  /** 每 10 分钟：遍历订阅，只兑官方前瞻码 */
  async runAll() {
    if (polling || !enabled()) return
    polling = true
    try {
      const subs = (await redis.hGetAll(SUBS)) || {}
      for (const [key, raw] of Object.entries(subs)) {
        if (!enabled()) break
        if (inflight.has(key)) continue
        inflight.add(key)
        try {
          const sub = safeParse(raw)
          if (!sub.game || !GAMES[sub.game] || !sub.qq) continue
          // 遍历期间订阅可能被关掉或改过
          if (await redis.hGet(SUBS, key) !== raw) continue
          const codes = (await getAutoCodes(sub.game)).map(x => x.code)
          if (!codes.length) continue
          const user = await this.userOf(null, sub.qq)
          const accounts = user ? collectAccounts(user, sub.game) : []
          // 解绑后不复活旧账号；订阅保留，重新绑定就能接着跑
          if (!accounts.length) continue
          const results = await this.exchange({
            game: sub.game, qq: String(sub.qq), accounts, codes, subscription: { key, raw },
          })
          if (results.length && await redis.hGet(SUBS, key) === raw) {
            await this.push(sub, results)
          }
        } catch (err) {
          logger.error(`[xhh][兑换码] 自动任务失败: ${err.message}`)
        } finally {
          inflight.delete(key)
        }
      }
    } catch (err) {
      logger.error(`[xhh][兑换码] 读取订阅失败: ${err.message}`)
    } finally {
      polling = false
    }
  }
}
