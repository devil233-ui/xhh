/**
 * 扫码绑定情况一览（签到名单）
 *
 * 移植自上游 v3 `apps/sign_manage.js` 的「名单」部分（代签到、自动签到登记暂未移植）。
 * 与本地结构有关的地方做了适配：数据源路径、游戏键判据、makeForwardMsg/render 从 #xhh 取、
 * 出图模板与本地 resources/sign 对齐。
 *
 * 「谁扫码过来了」的数据来自两处，插件自身存的和逍遥插件存的：
 *   ./plugins/xhh/data/Stoken/<QQ>.yaml
 *   ./plugins/xiaoyao-cvs-plugin/data/yaml/<QQ>.yaml
 * 两边可能都绑（按 stuid 去重），也可能只有一边 —— 逍遥那半边目录不存在就自动跳过。
 *
 * 名单含 QQ 号，因此只回主人；锅巴「签到名单只私聊」打开时改为私聊发图。
 */
import fs from 'node:fs';
import path from 'node:path';
import plugin from '../../../lib/plugins/plugin.js';
import { config, yaml, render, makeForwardMsg, pluginPriority } from '#xhh';

const XH_DIR = './plugins/xhh/data/Stoken';
const XY_DIR = './plugins/xiaoyao-cvs-plugin/data/yaml';
const SIGN_YAML = './plugins/xhh/config/sign.yaml';

const GAME_CN = { gs: '原神', sr: '星铁', zzz: '绝区零', bh3: '崩三' };

// 一条绑定记录 → 内部游戏键：game_biz → region_name → 崩三那套 region。
// 实测有一批条目没有 game_biz（只写 region_name），而 region 单独不够用
// （prod_gf_cn 同时对应绝区零和星铁），所以三层依次判。判据与上游 v3 的 gameOfEntry 一致。
const GAME_BIZ = { hk4e_cn: 'gs', hkrpg_cn: 'sr', nap_cn: 'zzz', bh3_cn: 'bh3' };
const REGION_NAME = { 天空岛: 'gs', 世界树: 'gs', 星穹列车: 'sr', 新艾利都: 'zzz' };
const BH3_REGIONS = ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'];

const isBh3Region = r => BH3_REGIONS.includes(String(r || ''));

function gameOfEntry(e) {
    const byBiz = GAME_BIZ[String(e?.game_biz || '')];
    if (byBiz) return byBiz;
    const byName = REGION_NAME[String(e?.region_name || '')];
    if (byName) return byName;
    return isBh3Region(e?.region) ? 'bh3' : '';
}

function readYaml(p) {
    // 先判存在再读：yaml.get 内部会 catch 住 ENOENT 并 logger.error，
    // 而逍遥侧的人本来就没有 xhh 侧的 yaml 文件，不判一下每次都要往 error.log 刷一条。
    if (!fs.existsSync(p)) return {};
    try {
        return yaml.get(p) || {};
    } catch {
        return {};
    }
}

function listQq(dir) {
    try {
        return fs
            .readdirSync(dir)
            .filter(f => f.endsWith('.yaml'))
            .map(f => f.replace(/\.yaml$/, ''));
    } catch {
        return [];
    }
}

/** 汇总某个 QQ 的绑定情况 */
function collectAccount(qq) {
    const xh = readYaml(path.posix.join(XH_DIR, `${qq}.yaml`));
    const xy = readYaml(path.posix.join(XY_DIR, `${qq}.yaml`));
    const xhList = Object.values(xh).filter(v => v?.stuid && v?.stoken);
    const xyList = Object.values(xy).filter(v => v?.stuid && v?.stoken);
    if (!xhList.length && !xyList.length) return null;

    const stuids = new Set();
    const games = new Set();
    for (const v of [...xhList, ...xyList]) {
        stuids.add(String(v.stuid));
        const g = gameOfEntry(v);
        if (g) games.add(g);
    }
    return { qq, fromXh: xhList.length > 0, fromXy: xyList.length > 0, stuids, games, accounts: stuids.size };
}

/** 所有绑定了 CK 的 QQ */
function collectAll() {
    const qqs = [...new Set([...listQq(XH_DIR), ...listQq(XY_DIR)])];
    return qqs.map(collectAccount).filter(Boolean);
}

/** 某个 QQ 都在哪些群的签到名单里（config/sign.yaml 的 add() 记的） */
function groupsOf(qq) {
    const d = readYaml(SIGN_YAML);
    const out = [];
    for (const [key, map] of [
        ['游戏', d?.sign],
        ['社区', d?.bbs_sign],
    ]) {
        for (const [gid, list] of Object.entries(map || {})) {
            if (Array.isArray(list) && list.map(String).includes(String(qq))) out.push(`${key}:${gid}`);
        }
    }
    return out;
}

const maskStuid = s => {
    const t = String(s || '').trim();
    return !t ? '—' : t.length <= 4 ? t : `****${t.slice(-4)}`;
};

function describe(acc) {
    const src = [acc.fromXh && '小花火', acc.fromXy && '逍遥'].filter(Boolean).join('+');
    const games = acc.games.size ? [...acc.games].map(g => GAME_CN[g] || g).join('/') : '未知（该来源没记游戏）';
    const stuids = [...acc.stuids].slice(0, 3).map(maskStuid).join(' ');
    const more = acc.stuids.size > 3 ? ` 等${acc.stuids.size}个` : '';
    const gs = groupsOf(acc.qq);
    return (
        `QQ ${acc.qq}\n  来源：${src}　账号：${acc.accounts}　游戏：${games}\n  stuid：${stuids}${more}` +
        (gs.length ? `\n  已在签到名单：${gs.join('、')}` : '')
    );
}

/** 名单卡模板用的扁平结构 */
function cardData(acc) {
    const src = [acc.fromXh && '小花火', acc.fromXy && '逍遥'].filter(Boolean).join('+');
    const games = acc.games.size ? [...acc.games].map(g => GAME_CN[g] || g).join('/') : '未知';
    const stuids = [...acc.stuids].map(maskStuid);
    const more = stuids.length > 3 ? ` 等${stuids.length}个` : '';
    return {
        qq: acc.qq,
        src,
        accounts: acc.accounts,
        games,
        stuids: (stuids.slice(0, 3).join(' ') || '无') + more,
        groups: groupsOf(acc.qq).join('、'),
    };
}

/**
 * 拉群成员 QQ。部分 TRSS/OneBot 连接器的群对象缓存为空，
 * 所以对象方法取不到时再用 sendApi 实时拉一次。
 */
async function fetchGroupQqs(e) {
    const gid = Number(e?.group_id);
    if (!e?.isGroup || !gid) return [];
    let members = [];
    const group = e.group;
    try {
        if (group?.getMemberArray) members = await group.getMemberArray();
        if (!members?.length && group?.getMemberMap) members = await group.getMemberMap(true);
        if (!members?.length && group?.getMemberList) members = await group.getMemberList();
    } catch {
        /* 换下面的 sendApi */
    }
    if ((!members || !members.length) && e.bot?.sendApi) {
        try {
            const res = await e.bot.sendApi('get_group_member_list', { group_id: gid, no_cache: true });
            members = res?.data || res || [];
        } catch {
            /* 拉不到就如实说明 */
        }
    }
    return (Array.isArray(members) ? members : [])
        .map(m => String(m?.user_id ?? m?.userId ?? m ?? '').trim())
        .filter(v => /^\d{5,12}$/.test(v));
}

const getBot = () => globalThis.Bot || (typeof Bot !== 'undefined' ? Bot : null);

export class SignManage extends plugin {
    constructor(e) {
        super({
            name: '[小花火]签到名单',
            dsc: '查看扫码绑定情况',
            event: 'message',
            priority: pluginPriority('sign', -26),
            rule: [
                // 「#签到名单 本群」要排在「#签到名单」前面：后者以 $ 结尾本来匹配不到带尾巴的形式，
                // 先特指后泛指更不容易将来改错。
                { reg: '^#*(小花火|xhh)*(签到|绑定|CK|ck)(名单|列表|情况|一览)\\s*(本群|当前群)$', fnc: 'listGroup', permission: 'master' },
                { reg: '^#*(小花火|xhh)*(签到|绑定|CK|ck)(名单|列表|情况|一览)$', fnc: 'list', permission: 'master' },
                { reg: '^#*(小花火|xhh)*(本群|当前群)(签到名单|绑定列表|名单|CK情况)$', fnc: 'listGroup', permission: 'master' },
            ],
        });
    }

    async list(e) {
        return this.showRoster(e, collectAll(), '扫码绑定情况');
    }

    /** 本群名单：群成员 ∩ 已绑定。取不到群成员时如实说明，不悄悄退化成全量 */
    async listGroup(e) {
        if (!e.isGroup) return e.reply('请在群里发这条指令。', true);
        const memberQqs = await fetchGroupQqs(e);
        if (!memberQqs.length) {
            return e.reply('拉不到本群成员列表，没法确定「本群」都有谁。\n可以改用「#签到名单」看全部。', true);
        }
        const all = collectAll();
        const inGroup = all.filter(a => memberQqs.includes(a.qq));
        return this.showRoster(e, inGroup, `本群扫码绑定情况（${inGroup.length}/${memberQqs.length} 人）`, memberQqs.length);
    }

    /**
     * 出名单图，出图失败才退回合并转发（makeForwardMsg 在连接器不支持时会内部退回纯文本）。
     * 只私聊模式下必须走 base64 再私发 —— 直接 ret:true 会把带 QQ 的图发到群里。
     */
    async showRoster(e, all, title, memberTotal) {
        if (!all.length) {
            return e.reply(
                memberTotal
                    ? `本群 ${memberTotal} 人里，还没有人扫码绑定过 CK。\n让成员发「#小花火扫码绑定」完成绑定后再试。`
                    : '还没有任何人扫码绑定过 CK。\n让成员发「#小花火扫码绑定」完成绑定后再试。',
                true,
            );
        }
        const both = all.filter(a => a.fromXh && a.fromXy).length;
        const head =
            `${title}\n` +
            `小花火侧 ${all.filter(a => a.fromXh).length} 人，逍遥侧 ${all.filter(a => a.fromXy).length} 人` +
            (both ? `，其中 ${both} 人两边都绑了` : '');
        const nodes = all.map(acc => {
            const who = e.isGroup ? e.group?.getMemberMap?.()?.get?.(Number(acc.qq))?.card : '';
            const name = [who, `QQ ${acc.qq}`].filter(Boolean).join(' · ');
            return { user_id: Number(acc.qq) || acc.qq, nickname: name, message: describe(acc) };
        });

        const card = {
            title,
            total: all.length,
            xh: all.filter(a => a.fromXh).length,
            xy: all.filter(a => a.fromXy).length,
            both,
            people: all.map(cardData),
        };

        // 先回一句数量再出图：渲染要一秒多，中间完全静默，图要是被连接器丢掉了，
        // 体感上就是「没反应」。
        const accTotal = all.reduce((n, a) => n + a.accounts, 0);
        const brief = memberTotal
            ? `${title}\n本群 ${memberTotal} 人，其中 ${all.length} 人绑定了 CK（合计 ${accTotal} 个账号）`
            : `${title}\n共 ${all.length} 人，合计 ${accTotal} 个账号`;
        await e.reply(brief, true);

        const privOnly = config()?.sign_list_private === true;

        if (privOnly && e.isGroup) {
            const botObj = getBot();
            const target = botObj?.pickFriend ? botObj.pickFriend(e.user_id) : null;
            if (!target) return e.reply(await makeForwardMsg(e, nodes, head), true);
            try {
                const img = await render('sign/roster', card);
                if (img) {
                    await e.reply('名单含全体 QQ 号，按设置私聊发出。', true);
                    return target.sendMsg(img);
                }
            } catch (err) {
                logger.error(`[xhh][签到名单] 出图失败，退回合并转发: ${err.message}`);
            }
            await e.reply('名单含全体 QQ 号，按设置私聊发出。', true);
            return target.sendMsg(await makeForwardMsg(e, nodes, head));
        }

        try {
            await render('sign/roster', card, { e, ret: true });
            return true;
        } catch (err) {
            logger.error(`[xhh][签到名单] 出图失败，退回合并转发: ${err.message}`);
        }
        return e.reply(await makeForwardMsg(e, nodes, head), true);
    }
}
