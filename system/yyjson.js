import fetch from "node-fetch";
import { yaml } from "#xhh"

const decodeUnicode = (value = "") => String(value)
    .replace(/\\u([dD][89a-fA-F][0-9a-fA-F]{2})/g, (match, group) => {
        return String.fromCharCode(parseInt(group, 16));
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, group) => {
        return String.fromCharCode(parseInt(group, 16));
    });

const collectMatches = (source, pattern) => [...String(source).matchAll(pattern)]
    .map(match => match[1])
    .filter(value => value !== undefined);

const extractVoiceSection = (html, isSr) => {
    const source = String(html || "");
    const pattern = isSr
        ? /Continuous\s*RePlay([\s\S]*?)(?=<section\b[^>]*\bid=["']char_stories["'][^>]*>)/i
        : /<td\b[^>]*>\s*VoiceOver\s*<\/td>([\s\S]*?)(?=<h2\b[^>]*>\s*Stories\s*<\/h2>)/i;
    return source.match(pattern)?.[1] || source;
};

export function parseHoneyhunterVoice(html, type, id) {
    const isSr = type === "sr";
    const source = extractVoiceSection(html, isSr);
    const titlePattern = isSr
        ? /<tr\b[^>]*>\s*<td>(.*?)<\/td>\s*<td>\s*<div\b[^>]*class=["'][^"']*\bdialog_cont\b[^"']*["'][^>]*>/gis
        : /<td>(.*?)<\/td>\s*<td>\s*<div\b[^>]*class=["'][^"']*\bdialog_cont\b[^"']*["'][^>]*>/gis;
    const titles = collectMatches(source, titlePattern);
    const idPattern = /dialog_data\.push\(\s*\{\s*["']start["']\s*:\s*["']?([^,"'\s]+)["']?\s*,/gi;
    const ids = collectMatches(source, idPattern);
    const decs = collectMatches(
        source,
        /\{\s*["']from["']\s*:\s*["'][^"']*["']\s*,\s*["']line["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/g
    );

    if (!ids.length) return false;

    const audioName = isSr
        ? ""
        : id === "playerboy"
            ? "hero"
            : id === "playergirl"
                ? "heroine"
                : id;
    const list = ids.map((voiceId, index) => ({
        id: isSr
            ? `https://starrail.honeyhunterworld.com/audio/hsr-audio/${voiceId}_`
            : `https://gensh.honeyhunterworld.com/audio/quotes/${audioName}/${voiceId}_`,
        title: titles[index] || `语音${index + 1}`,
        dec: decodeUnicode(decs[index] || "")
    }));
    return { list, id };
}

class yyjson {
    async gs_download(id) {
        try {
            let url = `https://api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page?app_sn=ys_obc&entry_page_id=${id}`;
            let res = await fetch(url).then(r => r.json());
            let modules = res?.data?.page?.modules;
            if (!modules) return false;

            // 自动寻找包含语音数据的模块
            let voiceModule = modules.find(m => m.name === "语音") || modules[14] || modules[0];
            let dataStr = voiceModule?.components?.[0]?.data;
            if (!dataStr) return false;

            let data = JSON.parse(dataStr);
            let rawList = data.list;
            if (!rawList || !rawList.length) return false;

            let cnTable = rawList.find(v => v.tab_name === "汉语" || v.tab_name === "中文") || rawList[0];
            let jpTable = rawList.find(v => v.tab_name === "日语");
            let enTable = rawList.find(v => v.tab_name === "英语");
            let krTable = rawList.find(v => v.tab_name === "韩语");

            let list = [];
            const getUrl = (obj) => {
                if (!obj) return "";
                let str = obj.audio_url || obj.audioUrl || "";
                let match = str.match(/https:\/\/[^"<>' ]+/);
                return match ? match[0] : str.replace(/sourcesrc=|><\/audio><\/div>/g, "");
            };

            for (let i = 0; i < cnTable.table.length; i++) {
                list.push({
                    title: cnTable.table[i].name,
                    dec: cnTable.table[i].content,
                    audio_cn: getUrl(cnTable.table[i]),
                    audio_jp: getUrl(jpTable?.table?.[i]),
                    audio_en: getUrl(enTable?.table?.[i]),
                    audio_kr: getUrl(krTable?.table?.[i])
                });
            }
            return { list, id };
        } catch (err) {
            return false;
        }
    }

    async sr_download(id) {
        try {
            let url = `https://api-static.mihoyo.com/common/blackboard/sr_wiki/v1/content/info?app_sn=sr_wiki&content_id=${id}`;
            let res = await fetch(url).then(r => r.json());
            let modules = res?.data?.content?.rpg_new_tmp_content?.modules;
            if (!modules) return false;

            let voiceModule = modules.find(m => m.name === "语音") || modules[9];
            let dataStr = voiceModule?.components?.[0]?.data;
            if (!dataStr) return false;

            let data = JSON.parse(dataStr);
            let rawList = data.list;
            if (!rawList || !rawList.length) return false;

            let cnTable = rawList.find(v => v.tab_name === "汉语" || v.tab_name === "中文") || rawList[0];
            let jpTable = rawList.find(v => v.tab_name === "日语");
            let enTable = rawList.find(v => v.tab_name === "英语");
            let krTable = rawList.find(v => v.tab_name === "韩语");

            let list = [];
            const getUrl = (obj) => {
                if (!obj) return "";
                let str = obj.audio_url || obj.audioUrl || "";
                let match = str.match(/https:\/\/[^"<>' ]+/);
                return match ? match[0] : str.replace(/sourcesrc=|><\/audio><\/div>/g, "");
            };

            for (let i = 0; i < cnTable.table.length; i++) {
                list.push({
                    title: cnTable.table[i].name,
                    dec: cnTable.table[i].content,
                    audio_cn: getUrl(cnTable.table[i]),
                    audio_jp: getUrl(jpTable?.table?.[i]),
                    audio_en: getUrl(enTable?.table?.[i]),
                    audio_kr: getUrl(krTable?.table?.[i])
                });
            }
            return { list, id };
        } catch (err) {
            return false;
        }
    }

    async gs_other_download(name) {
        try {
            const names = yaml.get("./plugins/xhh/system/default/gs_en_id.yaml") || {};
            const id = names[name];
            if (!id) return false;
            const response = await fetch(`https://gensh.honeyhunterworld.com/${id}/?lang=CHS`);
            if (!response.ok) return false;
            return parseHoneyhunterVoice(await response.text(), "gs", id);
        } catch (err) {
            return false;
        }
    }

    async sr_other_download(name) {
        try {
            const names = yaml.get("./plugins/xhh/system/default/sr_en_id.yaml") || {};
            const id = names[name];
            if (!id) return false;
            const response = await fetch(`https://starrail.honeyhunterworld.com/${id}/?lang=CN`);
            if (!response.ok) return false;
            return parseHoneyhunterVoice(await response.text(), "sr", id);
        } catch (err) {
            return false;
        }
    }











}

export default new yyjson();
