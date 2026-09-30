/**
 * 米游社请求封装：优先走云崽 lib/common/mys.js 的 mysFetch（节点优选 + 失败自动换 IP），
 * 其它域名回退全局 fetch，行为不变。
 *
 * 背景：米游社各 API 域名（bbs-api.miyoushe.com、api-takumi.mihoyo.com、
 * public-operation-common.mihoyo.com 等）指向国内 CDN，海外机器命中坏节点会一直挂到超时，
 * 表现为「米游社访问失败」「卡池公告获取失败」等。mysFetch 会并发测速选节点并按序重试。
 */
import { mysFetch } from '../../../lib/common/mys.js'

// 米游社/米哈游系域名（含 hoyolab / hoyoverse 国际版）
const MYS_HOST = /(^|\.)(miyoushe\.com|mihoyo\.com|hoyolab\.com|hoyoverse\.com)$/i

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

/** 与 fetch 同签名：米游社域名走 mysFetch，其余走全局 fetch */
export async function mysReq(input, options = {}) {
  if (!isMysHost(input)) return fetch(input, options)
  return wrapResponse(await mysFetch(input, options))
}

export default mysReq
