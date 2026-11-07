import common from "../../../lib/common/common.js";
import { Restart } from "../../other/restart.js";
import { createRequire } from "module";
import lodash from "lodash";
import { yaml, config } from "#xhh";

const require = createRequire(import.meta.url);
const { exec, execSync } = require("child_process");

let uping = false;

export class update extends plugin {
  constructor() {
    super({
      name: "[小花火]插件更新",
      dsc: "[小花火]插件更新",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#*(小花火|xhh)(插件)?(强制)?更新$",
          fnc: "update",
        },
        {
          reg: "^#*(小花火|xhh)(插件)?更新日志$",
          fnc: "updateLog",
        },
      ],
    });
    this.typeName = "xhh";
    this.task = {
      cron: "0 30 3 * * *", //凌晨3.30自动更新
      name: "[小花火]检查是否需要自动更新",
      fnc: () => this.zd(),
      log: true,
    };
  }
  async zd() {
    if (config().update) {
      let git = await execSync("git --version", { encoding: "utf-8" });
      if (!git || !git.includes("git version")) {
        return logger.error("未找到git");
      }
      // 自动更新不做 reset --hard：本次更新会覆盖的本地改动一律跳过，免得半夜把正在改的代码清掉
      let dirty = await this.checkDirty("xhh");
      if (dirty === null) {
        logger.error("xhh 工作区状态检查失败，跳过自动更新");
        return;
      }
      if (dirty.length) {
        logger.mark(`xhh 有 ${dirty.length} 个未提交改动，跳过自动更新`);
        return;
      }
      this.oldCommitId = await this.getcommitId("xhh");
      uping = true;
      let cm = "cd plugins/xhh && git pull --ff-only";
      let ret = await this.execSync(cm);
      uping = false;
      if (ret.error) {
        logger.mark("xhh更新失败");
        return;
      }
      if (/Already up|已经是最新/g.test(ret.stdout)) {
        logger.info("xhh已经是最新");
      } else {
        logger.info("xhh更新成功,即将重启");
        let npm = await this.checkPnpm();
        cm = `${npm} start`;
        if (process.argv[1].includes("pm2")) {
          cm = `${npm} run restart`;
        }
        exec(cm, { windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            logger.error(`重启失败\n${error.stack}`);
          } else if (stdout) {
            logger.mark("重启成功，运行已由前台转为后台");
            logger.mark(`查看日志请用命令：${npm} run log`);
            logger.mark(`停止后台运行命令：${npm} stop`);
            process.exit();
          }
        });
      }
    }
    return;
  }

  async update() {
    if (!this.e.isMaster) return false;
    if (uping) {
      await this.reply("已有命令更新中..请勿重复操作");
      return;
    }
    /** 获取插件 */
    let plugin = "xhh";

    /** 检查git安装 */
    if (!(await this.checkGit())) return;

    /** 执行更新 */
    await this.runUpdate(plugin);

    /** 是否需要重启 */
    if (this.isUp) {
      // await this.reply('即将执行重启，以应用更新')
      setTimeout(() => this.restart(), 2000);
    }
  }

  restart() {
    new Restart(this.e).restart();
  }

  async checkGit() {
    let ret = await execSync("git --version", { encoding: "utf-8" });
    if (!ret || !ret.includes("git version")) {
      await this.reply("请先安装git");
      return false;
    }

    return true;
  }

  async runUpdate(plugin = "") {
    this.isNowUp = false;

    let isForce = this.e.msg.includes("强制");
    let cm = `cd "plugins/${plugin}" && git pull --ff-only`;
    let type = "更新";

    if (isForce) {
      type = "强制更新";
      cm = `cd "plugins/${plugin}" && git reset --hard && git pull --rebase --allow-unrelated-histories`;
    } else {
      // 普通更新只走快进；会被这次更新覆盖的本地改动先拦下，不覆盖
      let dirty = await this.checkDirty(plugin);
      if (dirty === null) {
        await this.reply("检查工作区状态失败，已停止更新，请手动确认后重试");
        return false;
      }
      if (dirty.length) {
        let shown = dirty.slice(0, 10).join("\n");
        let more = dirty.length > 10 ? `\n…另有 ${dirty.length - 10} 处` : "";
        await this.reply(
          `工作区还有 ${dirty.length} 处未提交改动，已停止更新（更新会覆盖它们）：\n${shown}${more}\n\n` +
            "先提交或备份这些改动再更新；确认要丢弃本地修改，再发「#小花火强制更新」。"
        );
        return false;
      }
    }

    this.oldCommitId = await this.getcommitId(plugin);

    await this.reply(`开始执行${type}操作...`);
    uping = true;
    let ret = await this.execSync(cm);
    uping = false;

    if (ret.error) {
      logger.mark(`${this.e.logFnc} 更新失败：${this.typeName}`);
      this.gitErr(ret.error, ret.stdout);
      return false;
    }

    let time = await this.getTime(plugin);

    if (/Already up|已经是最新/g.test(ret.stdout)) {
      await this.reply(`${this.typeName}已经是最新\n最后更新时间：${time}`);
    } else {
      await this.reply(`${this.typeName}更新成功\n更新时间：${time}`);
      this.isUp = true;
      let log = await this.getLog(plugin);
      await this.reply(log);
    }

    logger.mark(`${this.e.logFnc} 最后更新时间：${time}`);

    return true;
  }

  async gitErr(err, stdout) {
    let msg = "更新失败！";
    let errMsg = err.toString();
    stdout = stdout.toString();

    if (errMsg.includes("Timed out")) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, "");
      await this.reply(msg + `\n连接超时：${remote}`);
      return;
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, "");
      await this.reply(msg + `\n连接失败：${remote}`);
      return;
    }

    if (/Not possible to fast-forward|diverging branches/i.test(errMsg)) {
      await this.reply(
        msg +
          "\n远端与本地已经分叉，无法快进合并。\n" +
          "可以在本地整理提交后再试，或者执行#小花火强制更新，放弃本地修改"
      );
      return;
    }

    if (errMsg.includes("be overwritten by merge")) {
      await this.reply(
        msg +
          `存在冲突：\n${errMsg}\n` +
          "请解决冲突后再更新，或者执行#小花火强制更新，放弃本地修改"
      );
      return;
    }

    if (stdout.includes("CONFLICT")) {
      await this.reply([
        msg + "存在冲突\n",
        errMsg,
        stdout,
        "\n请解决冲突后再更新，或者执行#小花火强制更新，放弃本地修改",
      ]);
      return;
    }

    await this.reply([ errMsg, stdout ]);
  }

  /**
   * 本地未提交改动里，真正会被这次更新覆盖的那些文件。
   * 先 fetch 看清远端要改哪些文件，再与本地改动取交集——只有交集才拦，
   * 本地改了但远端没碰的文件 git 会自己保留，不该因此阻止更新
   * （system/default/*.yaml 是运行期数据，几乎天天在变，一刀切会让人永远更新不了）。
   * 返回 [] 表示可安全更新，非空数组表示这些文件会被覆盖，null 表示检查失败。
   */
  async checkDirty(plugin = "") {
    let cwd = `cd "plugins/${plugin}"`;
    // fetch 失败说明网络或远端有问题，交给接下来的 pull 自己报错，这里不拦
    let fetch = await this.execSync(`${cwd} && git fetch --quiet`);
    if (fetch.error) return [];

    let local = await this.statusList(plugin);
    if (local === null) return null;
    if (!local.length) return [];

    let up = await this.execSync(`${cwd} && git rev-parse --abbrev-ref @{u}`);
    // 没有 upstream 就无从判断，退回全量拦截
    if (up.error) return local;

    let incoming = await this.execSync(`${cwd} && git diff --name-only HEAD...@{u}`);
    if (incoming.error) return local;

    let willTouch = new Set(
      String(incoming.stdout || "")
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean)
    );
    return local.filter(file => willTouch.has(file));
  }

  /** 已跟踪文件的未提交改动列表；null 表示 git 命令失败 */
  async statusList(plugin = "") {
    let ret = await this.execSync(`cd "plugins/${plugin}" && git status --porcelain --untracked-files=no`);
    if (ret.error) {
      logger.error(`检查 ${plugin} 工作区状态失败：${String(ret.error)}`);
      return null;
    }
    return String(ret.stdout || "")
      .split("\n")
      .map(line => line.replace(/\r$/, ""))
      .filter(line => line.trim())
      // porcelain 固定是「2 位状态 + 1 空格 + 路径」，不能先 trim 再切，否则路径首字符会被吃掉
      .map(line => line.slice(3).trim());
  }

  async getcommitId(plugin = "") {
    let cm = `cd "plugins/${plugin}" && git rev-parse --short HEAD`;

    let commitId = await execSync(cm, { encoding: "utf-8" });
    commitId = lodash.trim(commitId);

    return commitId;
  }

  async getTime(plugin = "") {
    let cm = `cd "plugins/${plugin}" && git log -1 --pretty=format:"%cr"`;

    let time = "";
    try {
      time = await execSync(cm, { encoding: "utf-8" });
      time = lodash.trim(time);
      time = time
        .replace(/ago/g, "前")
        .replace(/days/g, "天")
        .replace(/hours/g, "小时")
        .replace(/minutes/g, "分钟")
        .replace(/seconds/g, "秒")
        .replace(/weeks/g, "周")
        .replace(/months/g, "月")
        .replace(/ 前/g, "前");
    } catch (error) {
      logger.error(error.toString());
      time = "获取时间失败";
    }

    return time;
  }

  async execSync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }

  async getLog(plugin = "") {
    let cm = `cd "plugins/${plugin}" && git log -20 --pretty=format:"%h||[%cr] %s"`;

    let logAll;
    try {
      logAll = await execSync(cm, { encoding: "utf-8" });
    } catch (error) {
      logger.error(error.toString());
      this.reply(error.toString());
    }

    if (!logAll) return false;

    logAll = logAll.split("\n");

    let log = [];
    for (let str of logAll) {
      str = str.split("||");
      if (str[0] == this.oldCommitId) break;
      if (str[1].includes("Merge branch")) continue;
      str[1] = str[1]
        .replace(/ago/g, "前")
        .replace(/days/g, "天")
        .replace(/hours/g, "小时")
        .replace(/minutes/g, "分钟")
        .replace(/seconds/g, "秒")
        .replace(/weeks/g, "周")
        .replace(/months/g, "月")
        .replace(/ 前/g, "前");
      log.push(str[1]);
    }
    let line = log.length;
    log = log.join("\n\n");

    if (log.length <= 0) return "";

    let title = `小花火更新日志，共${line}条`;
    log = await common.makeForwardMsg(this.e, [ title, log ]);

    return log;
  }

  async updateLog() {
    let log = await this.getLog("xhh");
    await this.reply(log);
  }

  async checkPnpm() {
    let npm = "npm";
    let ret = await this.execSync("pnpm -v");
    if (ret.stdout) npm = "pnpm";
    return npm;
  }
}
