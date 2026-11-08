import fs from 'fs';
import {
    yyjson,
    yaml,
    render,
    mys,
    config
} from '#xhh';
import {
    execSync
} from 'child_process';

const path = process.cwd();

// 私聊里引用图片消息时，部分协议端不会把 reply 段带上来（2026-11-08 19:00:44 实测：
// 私聊引用语音列表图发序号，入站消息只有「1」，没有 [CQ:reply]，fsyy 拿不到被引用消息）。
// 这里记住每个会话最近一次发出去的语音列表图，只在「完全没有引用信息」时兜底；
// 只要带了引用（哪怕引用的是别人的转发卡），就严格按引用 id 匹配，不会抢别的插件的活。
const lastVoicePic = new Map();
const VOICE_PIC_TTL = 30 * 60 * 1000;
const voicePicKey = e => (e.isGroup ? `group:${e.group_id}` : `private:${e.user_id}`);

function mergeRoleNames(filePath, aliases) {
    const names = {
        ...(yaml.get(filePath) || {})
    };
    for (const [key, values] of Object.entries(aliases || {})) {
        const current = Array.isArray(names[key]) ? names[key] : [];
        names[key] = [...new Set(current.concat(Array.isArray(values) ? values : []))];
    }
    return names;
}

function resolveRoleName(names, name) {
    for (const [key, aliases] of Object.entries(names)) {
        if (key === name || (Array.isArray(aliases) && aliases.includes(name))) return key;
    }
    return name;
}

export class voice extends plugin {
    constructor() {
        super({
            name: '[小花火]角色语音',
            dsc: '',
            event: 'message',
            priority: 15,
            rule: [{
                reg: '^#*(小花火)?清(空|除)语音(图片(列表)?)?缓存$',
                fnc: 'qc',
                permission: 'master',
            },
            {
                reg: '^(#|\\*)(星铁|原神)?(.*)语音(列表)?$',
                fnc: 'yylb',
            },
            {
                reg: '^((\\d+)(.*))|((.*)(\\d+))$',
                fnc: 'fsyy',
            },
            ],
        });
        this.task = {
            cron: '0 20 4 * * *', //Cron表达式，(秒 分 时 日 月 星期)
            name: '[小花火]清空语音列表图片缓存',
            fnc: () => this.qc(),
        };
    }

    async tu(e, table, name, background) {
        let data = {
            name,
            table,
            background,
        };
        let img = await render('yytable/table', data, {
            e
        });
        if (img) return img;
        return false;
    }

    /**
     * 角色语音入口包装：与图鉴一致走「指令传递」——触发即 return false 把消息交下去，
     * 让同样认这条指令的插件（bookdex 的 `#xx语音`）也回一份。
     * 本插件内部用 e._xhhVoiceDone 去重，避免自己的后续规则重复处理同一条消息。
     */
    async yylb(e) {
        if (e._xhhVoiceDone) return false;
        e._xhhVoiceDone = true;
        try {
            await this.yylbImpl(e);
        } catch (err) {
            logger.error('[xhh][语音] 处理异常，放行给后续插件:', err);
        }
        return false;
    }

    async yylbImpl(e) {
        if (!config().all_voice) return false;
        let isSrMode = e.msg.startsWith("*") || e.msg.includes("星铁");
        let name = e.msg.replace(/#|\*|星铁|原神|语音|列表/g, "");
        let miaoPath = "./plugins/miao-plugin/config/roleName.yaml";
        let miaoRoleName = fs.existsSync(miaoPath) ? yaml.get(miaoPath) : null;

        // 先归一化当前游戏的别名，确保官方源和备用源使用同一个角色名。
        const gsnames = mergeRoleNames(
            "./plugins/xhh/system/default/gs_js_names.yaml",
            miaoRoleName?.gs
        );
        const srnames = mergeRoleNames(
            "./plugins/xhh/system/default/sr_js_names.yaml",
            miaoRoleName?.sr
        );
        name = resolveRoleName(isSrMode ? srnames : gsnames, name);
        //先查原神
        // let gs_id = (await mys.data(name)).id;
        let background = '../../../../../plugins/xhh/resources/yytable/bg0.png';

        if (name == '空') {
            // gs_id = '505542'
            background = '../../../../../plugins/xhh/resources/yytable/bg.png';
        } else if (name == '荧') {
            // gs_id = '505527'
            background = '../../../../../plugins/xhh/resources/yytable/bg.png';
        }
        let img;
        let data, table = [];
        let mysData = null;

        // ======= 步骤1：尝试走 MYS 官方主源 =======
        try {
            if (isSrMode) {
                let sr_id = (await mys.data(name, "js", true))?.id;
                if (sr_id) mysData = await yyjson.sr_download(sr_id);
            } else {
                let gs_id = (await mys.data(name))?.id;
                if (gs_id) mysData = await yyjson.gs_download(gs_id);
            }
        } catch (err) {
            logger.info("[小花火] MYS接口暂无数据或失效，准备走内鬼网备用源...");
        }

        // ======= 步骤2：检查主源数据，失败则走内鬼网备用源 =======
        if (mysData && mysData.list && mysData.list.length > 0) {
            data = mysData;
            data.isMys = true; // 增加MYS数据标记，方便发语音时区分
            if (isSrMode) background = "../../../../../plugins/xhh/resources/yytable/sr.png";
        } else {
            if (isSrMode) {
                data = await yyjson.sr_other_download(name);
                background = "../../../../../plugins/xhh/resources/yytable/sr.png";
            } else {
                data = await yyjson.gs_other_download(name);
            }
        }

        if (!data || !data.list || data.list.length === 0) {
            await e.reply(`未获取到${isSrMode ? "星铁" : "原神"}角色“${name}”的语音数据，可能是数据源暂时不可用或该角色尚未上传。`);
            return false;
        }

        // ======= 步骤3：生成图片 =======
        for (let v of data.list) {
            table.push(v.title);
        }
        img = await this.tu(e, table, name, background);

        // if (!isSr) {
        //     data = {
        //         name,
        //         isSr,
        //         list,
        //         list
        //     };
        // } else {
        //     data = {
        //         name,
        //         isSr,
        //         table,
        //         yy,
        //         list
        //     };
        // }

        if (img) {
            let f = await e.reply(img);
            await this.temp();
            if (f.data?.message_id) f.message_id = f.data.message_id;
            f.message_id = f.message_id.toString().replace(/\//g, '');
            fs.writeFileSync(
                `./plugins/xhh/temp/yy_pic/${f.message_id}.json`,
                JSON.stringify(data),
                'utf-8'
            );
            lastVoicePic.set(voicePicKey(e), { id: f.message_id, ts: Date.now() });
            return true;
        }
        return false;
    }

    async fsyy(e) {
        if (!config().all_voice) return false;
        if (!e.source && !e.getReply) return false;

        // 只认「引用的正是本插件发出去的语音列表图」：列表图发送时会把数据写到
        // temp/yy_pic/<message_id>.json，用被引用消息的 id 直接比对这个缓存就够了。
        // 不再走 getSource / getChatHistory —— 私聊取历史在部分协议端会抛错，而 Yunzai 的
        // loader 一旦捕获到本插件抛错就终止整条处理链，排在后面的插件（如 bookdex 的引用
        // 序号）全都收不到消息；合并转发、别人的图也本来就不需要取消息体。
        let replyId = String(e.source?.message_id || e.source?.seq || e.source?.time || '')
            .replace(/\//g, '');
        if (!replyId && typeof e.getReply === 'function') {
            // 老适配器只给 getReply、不给 e.source，兜底一次；拿不到就当没引用
            const src = await e.getReply().catch(() => null);
            replyId = String(src?.message_id || '').replace(/\//g, '');
        }
        if (!replyId && !e.isGroup) {
            // 私聊引用图片常常连 reply 段都没有（见文件顶部注释），用最近一次列表图兜底
            const rec = lastVoicePic.get(voicePicKey(e));
            if (rec && Date.now() - rec.ts <= VOICE_PIC_TTL) replyId = rec.id;
        }
        if (!replyId) return false;

        const picJson = `./plugins/xhh/temp/yy_pic/${replyId}.json`;
        if (!fs.existsSync(picJson)) return false;

        if (e.msg && e.msg.length > 5) return false;
        let xh = /\d+/.exec(e.msg);
        if (!xh) return false;
        let n = Number(xh[0]) - 1;
        let lx
        if (/日语|日文/.test(e.msg)) {
            // type = '日语'
            lx = 'jp'
        } else if (/汉语|中文|华语/.test(e.msg)) {
            // type = '汉语'
            lx = 'cn'
        } else if (/外语|英语|英文/.test(e.msg)) {
            // type = '英语'
            lx = 'en'
        } else if (/韩语|韩文/.test(e.msg)) {
            // type = '韩语'
            lx = 'kr'
        } else if (/^([0-9]|[0-9][0-9]|[1-2][0-9][0-9])$/.test(e.msg)) {
            // type = '汉语'
            lx = 'cn'
        } else {
            return false;
        }

        let data = JSON.parse(fs.readFileSync(picJson, 'utf-8'));
        // let isSr = data.isSr;
        // let list = data.list;
        // let table = data.table;
        let {
            list,
            id
        } = data;
        if (!list[n]) return e.reply('喂喂喂！你这序号不对吧🤔', true);
        // let yy = data.yy;
        // let x;
        // const pattern = /[\u4e00-\u9fa5]+/g; // 匹配中文字符
        // if (isSr) {
        //     switch (type) {
        //         case '汉语': {
        //             x = 0;
        //             break;
        //         }
        //         case '英语': {
        //             x = 1;
        //             break;
        //         }
        //         case '日语': {
        //             x = 2;
        //             break;
        //         }
        //         case '韩语': {
        //             x = 3;
        //             break;
        //         }
        //         default:
        //             return false;
        //     }
        // } else {
        //     for (let v of list) {
        //         if (v.tab_name == type) {
        //             table = v.table;
        //             break;
        //         }
        //     }
        // }
        // if (table.length) {
        //     for (let i in table) {
        //         if (table[i].name.match(pattern).join('') == list[n].title.match(pattern).join('')) {
        //             yy = isSr ? yy[x][i].replace(/sourcesrc=|><\/audio><\/div>/g, '') : table[i].audio_url
        //             break;
        //         }
        //     }
        // }
        const voiceItem = list[n];
        const description = String(voiceItem.dec || '')
            .replace(/<br\s*\\?\/?>/gi, '\n')
            .replace(/<\\?\/?color(?:=[^>]*)?>/gi, '');
        let yy;
        voiceItem.title = voiceItem.title || `语音${n + 1}`;
        voiceItem.dec = description;
        const voiceText = `[简述]:${voiceItem.title}\n[内容]:${description}`;

        // 判断当前缓存的数据是否为 MYS 源
        if (data.isMys) {
            yy = voiceItem["audio_" + lx] || voiceItem.audio_cn; // 动态提取对应的语种
            if (!yy || typeof yy !== "string") {
                await e.reply(voiceText);
                await e.reply("该语音暂无可用音频，以上为文本内容", true);
                return true;
            }
            logger.mark(`[小花火语音] 正在获取 MYS 源语音: \x1B[36m${yy}\x1B[0m`);
            try {
                let res = await fetch(yy);
                if (!res.ok) {
                    await e.reply(voiceText);
                    return e.reply("获取MYS语音失败，请稍后重试", true);
                }
                let bufferData = Buffer.from(await res.arrayBuffer());
                yy = "./plugins/xhh/temp/yy_pic/temp.mp3";
                fs.writeFileSync(yy, bufferData);
            } catch (err) {
                await e.reply(voiceText);
                return e.reply("获取MYS语音失败，请稍后重试", true);
            }
        } else {
            // 内鬼网备用源防盗链拉取逻辑
            if (!voiceItem.id) {
                await e.reply(voiceText);
                await e.reply("该语音暂无可用音频，以上为文本内容", true);
                return true;
            }
            yy = voiceItem.id + lx + ".ogg";
            logger.mark(`[小花火语音] 正在获取内鬼网语音: \x1B[36m${yy}\x1B[0m`);
            try {
                let res = await fetch(yy);
                if (!res.ok) {
                    logger.mark("语音直接访问失败，尝试添加防盗链请求头下载...");
                    let headers = {
                        "accept": "*/*",
                        "accept-encoding": "identity;q=1, *;q=0",
                        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
                        "cookie": "_first_time=1;_lr_retry_request=true;",
                        "Range": "bytes=0-",
                        "referer": id.includes("-character") ? `https://starrail.honeyhunterworld.com/${id}/` : `https://gensh.honeyhunterworld.com/${id}/`,
                        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
                    };
                    res = await fetch(yy, { method: "GET", headers });
                    if (!res.ok) {
                        await e.reply(voiceText);
                        return e.reply("获取备用源语音失败，请稍后重试", true);
                    }
                    let bufferData = Buffer.from(await res.arrayBuffer());
                    yy = "./plugins/xhh/temp/yy_pic/temp.ogg";
                    fs.writeFileSync(yy, bufferData);
                }
            } catch (err) {
                await e.reply(voiceText);
                return e.reply("获取备用源语音失败，请稍后重试", true);
            }
        }
        // if (!yy_ || typeof yy_ != 'string') return e.reply('获取该语音失败~', true);
        if (!ffmpeg()) {
            await e.reply(voiceText);
            await e.reply("未安装 ffmpeg，无法发送语音，以上为文本内容", true);
            return true;
        }
        let vo = segment.record(yy);
        await e.reply(
            `[简述]:${list[n].title}\n[内容]:${list[n].dec.replace(/<br\\\/>/g, '\n').replace(/<color=#37FFFF>|<\\\/color>/g, '')}`
        );
        e.reply(vo);
        return true;
    }

    async qc(e) {
        try {
            fs.rmSync('./plugins/xhh/temp/yy_pic/', {
                recursive: true
            });
        } catch (err) { }
        if (e) return e.reply('已清空语音列表图片缓存');
    }

    async temp() {
        if (!fs.existsSync('./plugins/xhh/temp/yy_pic/')) {
            fs.mkdirSync('./plugins/xhh/temp/yy_pic/', {
                recursive: true
            });
        }
    }
}

function ffmpeg() {
    try {
        const ret = execSync('ffmpeg -version').toString();
        if (!ret.includes('version')) {
            logger.error('未安装 ffmpeg 无法发送语音');
            return false;
        }
        return true;
    } catch (error) {
        return false;
    }
}
