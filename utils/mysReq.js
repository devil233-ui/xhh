/**
 * 米游社请求封装：优先走云崽 lib/common/mys.js 的 mysFetch（节点优选 + 失败自动换 IP），
 * 其它域名回退全局 fetch，行为不变。
 *
 * 背景：米游社各 API 域名（bbs-api.miyoushe.com、api-takumi.mihoyo.com、
 * public-operation-common.mihoyo.com 等）指向国内 CDN，海外机器命中坏节点会一直挂到超时，
 * 表现为「米游社访问失败」「卡池公告获取失败」等。mysFetch 会并发测速选节点并按序重试。
 */
import { mysFetch } from '../../../lib/common/mys.js'

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

/** 与 fetch 同签名：米游社域名走 mysFetch，其余走全局 fetch */
export async function mysReq(input, options = {}) {
  if (!isMysHost(input)) return fetch(input, options)
  const host = hostOf(input)
  const cooling = host && failedAt.has(host) && Date.now() - failedAt.get(host) < FAIL_TTL
  try {
    const res = await wrapResponse(await mysFetch(input, cooling ? { timeout: 4000, retry: 1, ...options } : options))
    if (host) failedAt.delete(host)
    return res
  } catch (err) {
    if (host) failedAt.set(host, Date.now())
    // 兜底：mysFetch 靠 TCP 测速挑节点，偶有误判（节点握手通但请求挂死）；
    // 再用全局 fetch 试一次（走系统解析 + happy-eyeballs），成功就不报错。
    try {
      const res = await fetch(input, options)
      if (host) failedAt.delete(host)
      return res
    } catch (_) {
      throw err // 仍失败则抛 mysFetch 的原始错误，保留节点明细便于排查
    }
  }
}

export default mysReq
