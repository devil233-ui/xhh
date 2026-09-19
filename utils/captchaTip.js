/**
 * 米游社撞验证码的提示文案（移植自 xhh-TL 的 utils/captchaTip.js，兜底话术按 xhh 现状调整）。
 *
 * 说明：xhh-TL 有「#过码」手划指令兜底；xhh 没有移植该链路，
 * 所以未配自动过码服务时只提示等待重试，不引导用户去发不存在的指令。
 *
 * 文案只写做什么，不解释为什么。
 */

/**
 * 撞码提示（**尚未过码**时用）。
 * @param {string} [game] gs / sr / zzz（当前文案不分游戏，保留参数位）
 * @returns {string} 撞码提示（不含 UID）
 */
export function captchaTip(game = 'gs') {
  return '米游社风控验证中，请一分钟后再试；若持续出现请联系管理员'
}

export { captchaTip as default }
