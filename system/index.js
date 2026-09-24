import mys from "./mys.js";
import render from "./render.js";
import splitImage from "./process_images.js";
import yaml from "./yaml.js";
import yyjson from "./yyjson.js";
import bili from "./bili.js";
import bili_live from "./bili_live.js";
import mhy from "./mhy.js";
import QR from "qrcode";
import api from "./api.js";
import {
    MysSign,
    zd_MysSign
} from "./sign.js";

let isTrss = true

try {
    const module = await import("../../miao-plugin/components/index.js");
    isTrss = module.Version.name === "TRSS-Yunzai";
} catch (err) {

}

//撤回消息
const recallMsg = (e, id) => {
    e.isGroup ? e.group.recallMsg(id || e.message_id) : e.friend.recallMsg(id || e.message_id);
};

//延时撤回
const reply_recallMsg = async(e, message, time, is_quote_reply = false) => {
    let rclFailRpl = await e.reply(message, is_quote_reply);
    setTimeout(() => {
        recallMsg(e, rclFailRpl.message_id);
    }, time * 1000);
    return rclFailRpl;
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

//合并转发消息
async function makeForwardMsg(e, msg = [], dec = "", Id = "", isGroup = true) {
    let name = Bot.nickname;
    let id = Number(Bot.uin);
    if (typeof msg == "string") msg = [ msg ];
    if (e?.isGroup) {
        try {
            let info = await e.bot.getGroupMemberInfo(e.group_id, id);
            name = info.card || info.nickname;
        } catch (err) {}
    }
    let userInfo = {
        user_id: id,
        nickname: name,
    };
    let forwardMsg = [];
    for (const message of msg) {
        if (!message) {
            continue;
        }
        forwardMsg.push({
            ...userInfo,
            message: message,
        });
    }
    let msg_ = false;

    if (!msg_ || !msg_.data) {
        if (e?.group?.makeForwardMsg) {
            msg_ = await e.group.makeForwardMsg(forwardMsg);
        } else if (e?.friend?.makeForwardMsg) {
            msg_ = await e.friend.makeForwardMsg(forwardMsg);
        } else if (Id) {
            try {
                //兼容napcat-adapter，解决napcat-adapter的Bot.makeForwardMsg发不出去的bug
                msg_ = isGroup ? await Bot.pickGroup(Id).makeForwardMsg(forwardMsg) : await Bot.pickFriend(Id).makeForwardMsg(forwardMsg);
            } catch (err) {
                msg_ = await Bot.makeForwardMsg(forwardMsg);
            }
        } else {
            return msg.join("\n");
        }
    }

    if (dec && msg_.data) {
        if (msg_.data.meta?.detail) {
            msg_.data.meta.detail.news = [
{
                text: dec
            }
];
        } else {
            if (Array.isArray(msg_.data)) msg_.data.unshift({
                ...userInfo,
                message: dec
            });
        }
    }
    return msg_;
}

//制作消息命令
function makeMessage(e, msg) {
    Bot.em("message.private.friend", {
        self_id: e.self_id,
        message_id: e.message_id,
        user_id: e.user_id,
        sender: e.sender,
        friend: e.friend,
        reply: e.reply.bind(e),
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        message: [
{
            type: "text",
            text: msg
        }
],
        raw_message: msg,
    });
}

//获取配置
const config = () => {
    return yaml.get("./plugins/xhh/config/config.yaml");
};

const pluginPriority = (name, defaultVal) => {
    const cfg = config() || {};
    return cfg[`${name}_priority`] ?? defaultVal;
};



// 攻略帖发布时间过旧时，在时间后面挂一句提醒
const oldPostWarn = (ts, now = Date.now()) => {
    const t = Number(ts || 0);
    if (!t) return '';
    const ms = t > 1e11 ? t : t * 1000;
    const years = (now - ms) / (365 * 24 * 3600 * 1000);
    if (years >= 3) return `（${Math.floor(years)}年前）⚠️内容可能已严重过时`;
    if (years >= 2) return `（${Math.floor(years)}年前）⚠️内容可能已过时`;
    return '';
};

async function getSource(e) {
    //引用回复
    if (!e.source && !e.getReply) return false;

    let source = {};
    
    if (e.source) {
        if (e.source.message_id) {
            try {
                source = await Bot.getMsg(e.source.message_id);
            } catch (error) {
                source = await e.bot.getMsg(e.source.message_id);
            }
        } else {
            source = e.isGroup ? (await e.group.getChatHistory(e.source?.seq, 1)).pop() : (await e.friend.getChatHistory((e.source?.time + 1), 1)).pop();
        }
    } else {
        source = await e.getReply(); //无e.source的情况
    }
    
    return source
}



export {
    mys,
    render,
    splitImage,
    yaml,
    yyjson,
    QR,
    bili,
    bili_live,
    api,
    mhy,
    isTrss,
    recallMsg,
    reply_recallMsg,
    sleep,
    makeForwardMsg,
    makeMessage,
    config,
    pluginPriority,
    oldPostWarn,
    getSource,
    MysSign,
    zd_MysSign,
};
