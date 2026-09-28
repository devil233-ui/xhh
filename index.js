import fs from "node:fs";
import "./utils/ckAutoRefresh.js"; // ck 失效全局自愈：加载即对 genshin checkCode 打补丁
import yaml from "./system/yaml.js";

logger.info("\x1B[31m---------៷>ᴗ<៷---------\x1B[0m");
logger.info("\x1B[31m小花火插件正在载入...\x1B[0m");
logger.info("\x1B[31m-------------------------\x1B[0m");

var paths = [ "config/", "temp/", "data/", "data/fp/", "data/Stoken/" ];

paths.map(path => {
  if (!fs.existsSync("./plugins/xhh/" + path)) {
    fs.mkdirSync("./plugins/xhh/" + path);
  }
});

let paths_ = [ "config.yaml", "sign.yaml", "other.yaml", "bh3_remind.yaml", "activity_remind.yaml" ];

for (const _path of paths_) {
  const cfg_path = "./plugins/xhh/config/" + _path;
  const def_cfg_path = "./plugins/xhh/system/default/default_config/" + _path;
  if (!fs.existsSync(cfg_path)) {
    fs.cpSync(def_cfg_path, cfg_path);
    continue;
  }

  let cfg = yaml.get("./plugins/xhh/config/" + _path) || {};
  let def_cfg = yaml.get(def_cfg_path) || {};

  // 只补默认配置里新增、用户配置里还没有的键；不覆盖、不删除用户已有的键。
  // 旧逻辑在键数不一致时用默认配置整份覆盖用户配置、再回填两边都有的键，
  // 结果是把用户自定义或锅巴面板写入的键静默抹掉（debug、abyss_report_* 等）。
  for (const key of Object.keys(def_cfg)) {
    if (!(key in cfg)) yaml.set(cfg_path, key, def_cfg[key]);
  }
}

const files = fs
  .readdirSync("./plugins/xhh/apps")
  .filter(file => file.endsWith(".js"));

let ret = [];

files.forEach(file => {
  ret.push(import(`./apps/${file}`));
});

ret = await Promise.allSettled(ret);

let apps = {};
for (let i in files) {
  let name = files[i].replace(".js", "");

  if (ret[i].status != "fulfilled") {
    logger.error(`载入插件错误：${logger.red(name)}`);
    logger.error(ret[i].reason);
    continue;
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]];
}

export { apps };
