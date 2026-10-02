/**
 * 米游社请求封装：优先走云崽 lib/common/mys.js 的 mysFetch（节点优选 + 失败自动换 IP），
 * 其它域名回退全局 fetch，行为不变。
 *
 * 背景：米游社各 API 域名（bbs-api.miyoushe.com、api-takumi.mihoyo.com、
 * public-operation-common.mihoyo.com 等）指向国内 CDN，海外机器命中坏节点会一直挂到超时，
 * 表现为「米游社访问失败」「卡池公告获取失败」等。mysFetch 会并发测速选节点并按序重试。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { mysFetch } from '../../../lib/common/mys.js'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { config } from '#xhh'

// ───────────────────────── 图鉴数据磁盘缓存 ─────────────────────────
// 目的：图鉴的列表/详情来自米游社与 nanoka，内容按版本更新、几乎不变，
// 但每次查询都要打网络（还常撞 CDN 坏节点）。这里在统一入口上缓存 GET 响应：
//   · 命中且未过期 → 直接用本地副本，零网络；
//   · 取数失败（超时/坏节点）→ 退回本地旧副本，图鉴不至于查不出来。
// 只缓存白名单域名、只缓存 GET、且跳过任何带 Cookie/DS/签名的请求（那些与账号相关）。
const CACHE_DIR = './plugins/xhh/data/cache/http'
const CACHE_MAX_BYTES = 2 * 1024 * 1024
const CACHE_MAX_FILES = 3000
const CACHE_RULES = [
  // nanoka 静态数据是按版本分目录的（/gi/7.1.51/...），同版本内容不变 → 长缓存
  { name: 'nanoka', host: /(^|\.)static\.nanoka\.cc$/, ttl: 7 * 24 * 3600 * 1000 },
  // 米游社图鉴 blackboard（列表与详情，免鉴权）→ 12 小时
  { name: 'mihoyo-wiki', host: /(^|\.)(mihoyo|miyoushe)\.com$/, path: /\/common\/blackboard\//, ttl: 12 * 3600 * 1000 },
]
const cacheInflight = new Map()

function cacheRuleFor(url, options) {
  if (String(options?.method || 'GET').toUpperCase() !== 'GET') return null
  const headers = options?.headers || {}
  // 带账号相关的头一律不缓存（结果因人而异）
  for (const k of Object.keys(headers)) {
    if (/^(cookie|authorization|ds)$/i.test(k) || /^x-rpc-/i.test(k)) return null
  }
  let u
  try {
    u = new URL(url)
  } catch (_) {
    return null
  }
  return CACHE_RULES.find(r => r.host.test(u.hostname) && (!r.path || r.path.test(u.pathname))) || null
}

function cacheFileOf(url) {
  return path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)}.json`)
}

function readCache(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    return entry && typeof entry.body === 'string' ? entry : null
  } catch (_) {
    return null
  }
}

function pruneCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))
    if (files.length <= CACHE_MAX_FILES) return
    const stat = files.map(f => {
      const full = path.join(CACHE_DIR, f)
      return { full, at: fs.statSync(full).mtimeMs }
    }).sort((a, b) => a.at - b.at)
    for (const f of stat.slice(0, Math.floor(files.length * 0.2))) fs.unlinkSync(f.full)
  } catch (_) {
    /* 清理失败不影响主流程 */
  }
}

function writeCache(file, url, status, headers, body) {
  if (Buffer.byteLength(body) > CACHE_MAX_BYTES) return
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ url, at: Date.now(), status, headers, body }))
    pruneCache()
  } catch (_) {
    /* 写缓存失败不影响主流程 */
  }
}

function cachedResponse(entry) {
  const buf = Buffer.from(entry.body, 'utf8')
  return {
    ok: entry.status >= 200 && entry.status < 300,
    status: entry.status,
    statusText: '',
    url: entry.url,
    headers: new Headers(entry.headers || {}),
    text: () => Promise.resolve(entry.body),
    json: () => Promise.resolve().then(() => JSON.parse(entry.body)),
    arrayBuffer: () => Promise.resolve().then(() => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  }
}

// 只对国内米游社/米哈游系域名做节点优选；
// hoyolab / hoyoverse 是境外服务，走直连（不参与国内 CDN 测速）
const MYS_HOST = /(^|\.)(miyoushe\.com|mihoyo\.com)$/i

export function isMysHost(url) {
  try {
    return MYS_HOST.test(new URL(typeof url === 'string' ? url : String(url?.url || url)).hostname)
  } catch (_) {
    return false
  }
}

/**
 * mysFetch 的响应对象里 headers 是 Node 原始头对象（没有 .get()），
 * 这里包一层 Headers 实例，让 res.headers.get('content-encoding') 这类写法照常可用。
 */
function wrapResponse(res) {
  let headers
  try {
    headers = new Headers(res.headers || {})
  } catch (_) {
    headers = res.headers || {}
  }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    headers,
    text: () => res.text(),
    json: () => res.json(),
    arrayBuffer: () => res.arrayBuffer(),
    blob: typeof res.blob === 'function' ? () => res.blob() : undefined,
  }
}

/** 从入参里取主机名（URL 字符串 / URL 对象都支持） */
function hostOf(input) {
  try {
    return new URL(typeof input === 'string' ? input : String(input?.url || input)).hostname
  } catch (_) {
    return ''
  }
}

// 失败记忆：同一域名刚失败过时，短时间内的后续请求用更短的超时/更少的节点，
// 避免每个请求都等满 8s×N 才失败（图鉴一次查询会连打好几个接口，曾把一条指令拖到 4 分钟）。
const FAIL_TTL = 3 * 60 * 1000
const failedAt = new Map()

// ───────────────────────── 米游社风控兜底（换出口 IP） ─────────────────────────
// 米游社对单个出口 IP 有频次风控：触发时不给错误码，而是返回一整页 HTML「已阻断」
// （实测表现为 HTTP 405），一轮签到里所有接口一起挂。
// 云崽 mysFetch 只做「节点优选 + 连接类失败换 IP」，注释明说拿到 HTTP 响应（含 4xx/5xx）
// 就直接返回——风控打的是本机出口 IP，换米游社节点救不了，只能换出口。
// 这里在统一入口上补一次兜底：识别到阻断页时，用 config.mhy_proxy 指定的 HTTP 代理
// 重试一次。伊涅芙上默认指向本机 WARP 桥接 http://127.0.0.1:8118（只绑回环，
// Cookie 不出本机）；代理没配、填错或自己挂了，就按原样返回，不假装成功。
const BLOCKED_HINT = /已阻断|阻断页面|安全威胁/
let _proxyAgent = null
let _proxyAgentFor = ''
function proxyUrl() {
  try {
    return String(config?.().mhy_proxy || '').trim()
  } catch (_) {
    return ''
  }
}
function proxyAgent(url) {
  if (_proxyAgentFor !== url) {
    _proxyAgent = new HttpsProxyAgent(url)
    _proxyAgentFor = url
  }
  return _proxyAgent
}

/**
 * 经代理请求一次；失败返回 null，由调用方按原样处理。
 *
 * 用原生 https + HttpsProxyAgent，不用 node-fetch：实测 node-fetch 传 agent 时
 * 依然直连（出口 IP 没变），原生 https.request 才真正走 CONNECT。
 * 一律剥掉 Accept-Encoding，让米游社返回明文，省掉解压这一步。
 */
async function viaProxy(input, options, proxy) {
  const url = String(typeof input === 'string' ? input : input?.url || input)
  if (!/^https:/i.test(url)) return null
  const method = String(options?.method || 'GET').toUpperCase()
  const headers = { ...(options?.headers || {}) }
  delete headers['Accept-Encoding']
  delete headers['accept-encoding']
  const body = options?.body
  return await new Promise(resolve => {
    let done = false
    const finish = v => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    let req
    try {
      req = https.request(
        url,
        { method, headers, agent: proxyAgent(proxy), timeout: 20000 },
        res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            logger?.mark?.(`[xhh][proxy] 直连被拦，已改走代理：${url.slice(0, 80)}`)
            finish(
              rebuildResponse(
                {
                  ok: res.statusCode >= 200 && res.statusCode < 300,
                  status: res.statusCode,
                  statusText: res.statusMessage,
                  url,
                },
                res.headers,
                text,
              ),
            )
          })
        },
      )
    } catch (err) {
      logger?.mark?.(`[xhh][proxy] 代理请求失败，按原样返回：${err?.message || err}`)
      return finish(null)
    }
    req.on('timeout', () => req.destroy(new Error('代理超时')))
    req.on('error', err => {
      logger?.mark?.(`[xhh][proxy] 代理请求失败，按原样返回：${err?.message || err}`)
      finish(null)
    })
    if (body && method !== 'GET' && method !== 'HEAD') {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

/**
 * 读到「已阻断」页就换出口重试一次。
 * 不是阻断页也要把响应还回去 —— text() 会被消费掉，所以读完用快照重建，
 * 否则调用方的 .json() 会报「Body is unusable」。
 */
async function retryIfBlocked(input, options, res) {
  const proxy = proxyUrl()
  if (!proxy || !isMysHost(input) || !res) return res
  if (res.status !== 200 && res.status !== 405) return res
  let body
  try {
    body = await res.text()
  } catch (_) {
    return res
  }
  const headers = Object.fromEntries(new Headers(res.headers || {}).entries())
  if (!BLOCKED_HINT.test(body)) return rebuildResponse(res, headers, body)
  const retried = await viaProxy(input, options, proxy)
  return retried || rebuildResponse(res, headers, body)
}

/** 用已读到的 body 快照重建响应（与缓存层 cachedResponse 同形） */
function rebuildResponse(res, headers, body) {
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    headers: new Headers(headers || {}),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve().then(() => JSON.parse(body)),
    arrayBuffer: () => Promise.resolve().then(() => Buffer.from(body, 'utf8')),
  }
}

/** 与 fetch 同签名：米游社域名走 mysFetch，其余走全局 fetch（白名单 URL 走磁盘缓存） */
export async function mysReq(input, options = {}) {
  const url = typeof input === 'string' ? input : String(input?.url || input)
  const rule = cacheRuleFor(url, options)
  if (rule) {
    const file = cacheFileOf(url)
    const hit = readCache(file)
    if (hit && Date.now() - hit.at < rule.ttl) return cachedResponse(hit)
    // 同一 URL 并发请求只打一次网络
    if (cacheInflight.has(url)) {
      try {
        return await cacheInflight.get(url)
      } catch (_) {
        if (hit) return cachedResponse(hit)
        throw _
      }
    }
    const task = (async () => {
      const res = await doFetch(url, options)
      if (res.status !== 200) return res
      // 读 body 做快照会消费掉响应体，之后调用方的 res.json() 就报
      // 「Body is unusable」——所以读完用快照重建一个响应返回。
      try {
        const headers = Object.fromEntries(new Headers(res.headers || {}).entries())
        const body = await res.text()
        // 阻断页不写缓存：12 小时 TTL 会把一次风控固化成一整天的「查不到」
        if (!BLOCKED_HINT.test(body)) writeCache(file, url, res.status, headers, body)
        return cachedResponse({ url, at: Date.now(), status: res.status, headers, body })
      } catch (_) {
        return res
      }
    })()
    cacheInflight.set(url, task)
    try {
      return await task
    } catch (err) {
      if (hit) {
        logger?.mark?.(`[xhh][cache] ${rule.name} 取数失败，改用本地缓存兜底：${url.slice(0, 90)}`)
        return cachedResponse(hit)
      }
      throw err
    } finally {
      cacheInflight.delete(url)
    }
  }
  return doFetch(url, options)
}

/** 实际网络请求：米游社域名走 mysFetch，其余走全局 fetch */
async function doFetch(input, options = {}) {
  if (!isMysHost(input)) return fetch(input, options)
  const host = hostOf(input)
  const cooling = host && failedAt.has(host) && Date.now() - failedAt.get(host) < FAIL_TTL
  try {
    const res = await wrapResponse(await mysFetch(input, cooling ? { timeout: 4000, retry: 1, ...options } : options))
    if (host) failedAt.delete(host)
    return await retryIfBlocked(input, options, res)
  } catch (err) {
    if (host) failedAt.set(host, Date.now())
    // 兜底：mysFetch 靠 TCP 测速挑节点，偶有误判（节点握手通但请求挂死）；
    // 再用全局 fetch 试一次（走系统解析 + happy-eyeballs），成功就不报错。
    try {
      const res = await fetch(input, options)
      if (host) failedAt.delete(host)
      return await retryIfBlocked(input, options, res)
    } catch (_) {
      throw err // 仍失败则抛 mysFetch 的原始错误，保留节点明细便于排查
    }
  }
}

export default mysReq
