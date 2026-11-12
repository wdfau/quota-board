import { demoAccounts } from "./demo.js";
import { providers } from "../core/model.js";

const $ = (selector) => document.querySelector(selector);
let accounts = await window.quota.list();
let demo = new URLSearchParams(location.search).get("demo") === "1";
let filter = "all";
let recordingId;
let toastTimer;
const pending = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, callback, className = "") {
  const node = element("button", className, text);
  node.type = "button";
  node.onclick = () =>
    Promise.resolve(callback()).catch((error) => toast(error.message));
  return node;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 6000);
}
function age(date) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 60_000),
  );
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  if (minutes < 1440) return Math.floor(minutes / 60) + " 小时前";
  return Math.floor(minutes / 1440) + " 天前";
}
function resetText(date) {
  if (!date) return "未提供重置时间";
  const minutes = Math.ceil((Date.parse(date) - Date.now()) / 60_000);
  if (minutes <= 0) return "已到重置时间，待确认";
  if (minutes < 60) return minutes + " 分钟后重置";
  if (minutes < 1440)
    return Math.floor(minutes / 60) + " 小时 " + (minutes % 60) + " 分钟后重置";
  return Math.floor(minutes / 1440) + " 天后重置";
}
function icon(provider) {
  const node = element(
    "span",
    "provider-icon",
    { codex: "◎", claude: "✳", cursor: "↗", copilot: "⌘" }[provider],
  );
  node.style.color = providers[provider].color;
  node.setAttribute("aria-hidden", "true");
  return node;
}
function quotaWindow(window, provider) {
  const node = element("div", "window");
  const ring = element("div", "ring");
  ring.style.setProperty("--remaining", window.remaining);
  ring.style.setProperty(
    "--accent",
    window.remaining <= 10 ? "#bb7938" : providers[provider].color,
  );
  ring.innerHTML =
    '<svg viewBox="0 0 95 95" aria-hidden="true"><circle class="track" cx="47.5" cy="47.5" r="42"/><circle class="progress" cx="47.5" cy="47.5" r="42"/></svg>';
  const value = element(
    "div",
    "ring-value",
    Math.round(window.remaining) + "%",
  );
  value.append(element("small", "", "剩余"));
  ring.append(value);
  node.append(
    ring,
    element("div", "window-name", window.label),
    element("div", "reset", resetText(window.resetsAt)),
  );
  return node;
}
function card(account) {
  const stale =
    account.error ||
    account.mode === "manual" ||
    account.mode === "claude" ||
    (account.snapshot &&
      Date.now() - Date.parse(account.snapshot.observedAt) > 300_000);
  const node = element("article", "account" + (stale ? " stale" : ""));
  const heading = element("div", "card-heading");
  const title = element("div");
  title.append(
    element("h3", "", account.label),
    element("small", "", providers[account.provider].name),
  );
  heading.append(icon(account.provider), title);
  if (!demo)
    heading.append(
      button(
        "×",
        async () => {
          if (confirm("移除「" + account.label + "」及其本地额度记录？"))
            await window.quota.remove(account.id);
        },
        "delete",
      ),
    );
  heading.lastElementChild?.setAttribute(
    "aria-label",
    demo ? providers[account.provider].name : "移除 " + account.label,
  );
  node.append(heading);
  if (account.snapshot) {
    const body = element("div", "card-body");
    body.append(
      ...account.snapshot.windows.map((window) =>
        quotaWindow(window, account.provider),
      ),
    );
    node.append(body);
  } else {
    const empty = element("div", "unknown");
    empty.append(
      element("strong", "", "—"),
      element(
        "span",
        "",
        account.mode === "manual" ? "添加一条官方用量记录" : "等待读取额度",
      ),
    );
    node.append(empty);
  }
  if (account.error)
    node.append(element("div", "error-message", account.error));
  const footer = element("div", "card-footer");
  const label = account.snapshot
    ? (stale ? "上次记录 · " : "已同步 · ") + age(account.snapshot.observedAt)
    : "尚无额度记录";
  const status = element("span", "", label);
  status.title = account.snapshot
    ? account.source +
      "\n" +
      new Date(account.snapshot.observedAt).toLocaleString()
    : "";
  footer.append(element("span", "state-dot"), status);
  footer.append(
    button("官方用量 ↗", () => window.quota.openProvider(account.provider)),
  );
  if (!demo) {
    const action = button(
      account.mode === "manual" ? "更新记录" : "刷新",
      () => {
        if (account.mode === "manual") openRecord(account);
        else return refresh(account.id);
      },
    );
    action.disabled = pending.has(account.id) || pending.has("all");
    footer.append(action);
  }
  node.append(footer);
  return node;
}
function render() {
  const data = demo ? demoAccounts : accounts;
  $("#demo-banner").hidden = !demo;
  $("#demo").textContent = demo ? "返回我的账号" : "试用演示";
  $("#add").disabled = demo;
  $("#refresh").disabled = demo || pending.size > 0;
  const navigation = $("#navigation");
  navigation.replaceChildren();
  for (const [key, name] of [
    ["all", "全部账号"],
    ...Object.entries(providers).map(([key, provider]) => [key, provider.name]),
  ]) {
    const item = button(
      "",
      () => {
        filter = key;
        render();
      },
      filter === key ? "selected" : "",
    );
    item.append(
      key === "all" ? element("span", "provider-icon", "▦") : icon(key),
      element("span", "nav-name", name),
      element(
        "span",
        "count",
        data.filter((account) => key === "all" || account.provider === key)
          .length,
      ),
    );
    navigation.append(item);
  }
  const stats = [
    [data.length, "订阅账号"],
    [new Set(data.map((account) => account.provider)).size, "AI 服务"],
    [
      data.filter((account) =>
        account.snapshot?.windows.some((window) => window.remaining <= 10),
      ).length,
      "额度较低",
    ],
  ];
  $("#overview").replaceChildren(
    ...stats.map(([value, label]) => {
      const node = element("div", "stat");
      node.append(element("strong", "", value), element("span", "", label));
      return node;
    }),
  );
  $("#section-title").textContent =
    filter === "all" ? "全部账号" : providers[filter].name;
  const visible = data.filter(
    (account) => filter === "all" || account.provider === filter,
  );
  $("#accounts").replaceChildren(...visible.map(card));
  if (!visible.length) {
    const node = element("div", "empty");
    node.append(
      element("h3", "", "把你的第一个账号放进来"),
      element(
        "p",
        "",
        "连接 Codex、Claude、Cursor 或 GitHub Copilot。\n每个账号都有自己的额度记录。",
      ),
      button("＋ 添加账号", openProfile, "primary"),
    );
    $("#accounts").append(node);
  }
}
function openProfile() {
  if (demo) return;
  $("#profile-form").reset();
  if (filter !== "all") $("#provider").value = filter;
  updateModes();
  $("#profile-dialog").showModal();
}
const modeNames = {
  codex: "官方 CLI 查询",
  claude: "官方状态栏记录",
  copilot: "官方 SDK 查询",
  manual: "手动记录",
};
function updateModes() {
  const provider = $("#provider").value;
  $("#mode").replaceChildren(
    ...providers[provider].modes.map((mode) => {
      const option = element("option", "", modeNames[mode]);
      option.value = mode;
      return option;
    }),
  );
  updateFields();
}
function updateFields() {
  const mode = $("#mode").value;
  $("#home-field").hidden = !["codex", "copilot"].includes(mode);
  $("#cli-field").hidden = !["codex", "copilot"].includes(mode);
  $("#snapshot-field").hidden = mode !== "claude";
  $("#mode-help").textContent = {
    codex:
      "使用 Codex 官方 CLI 已登录的订阅账号。多个账号分别选择独立配置目录。",
    claude:
      "使用仓库脚本导出 Claude Code 状态栏额度，每个账号选择独立文件。数据随官方会话更新。",
    copilot:
      "查询 Copilot CLI 当前登录的账号，可选择独立配置目录。每次刷新核对身份，切换官方登录后需重新添加。",
    manual: "从官方用量页填写余量和重置时间，卡片始终注明这是一次本地记录。",
  }[mode];
}
function openRecord(account) {
  recordingId = account.id;
  const form = $("#record-form");
  form.reset();
  const window = account.snapshot?.windows[0];
  if (window) {
    form.elements.period.value = window.label;
    form.elements.remaining.value = window.remaining;
  }
  $("#record-dialog").showModal();
}
async function refresh(id) {
  const key = id || "all";
  pending.add(key);
  render();
  try {
    await window.quota.refresh(id);
  } finally {
    pending.delete(key);
    render();
  }
}
$("#add").onclick = openProfile;
$("#demo").onclick = () => {
  demo = !demo;
  render();
};
$("#refresh").onclick = () => refresh().catch((error) => toast(error.message));
$("#provider").onchange = updateModes;
$("#mode").onchange = updateFields;
document.querySelectorAll("[data-close]").forEach((node) => {
  node.onclick = () => $("#" + node.dataset.close).close();
});
document.querySelectorAll("[data-pick]").forEach((node) => {
  node.onclick = async () => {
    try {
      const path = await window.quota.choose(node.dataset.kind || "file");
      if (path) $("#profile-form").elements[node.dataset.pick].value = path;
    } catch (error) {
      toast(error.message);
    }
  };
});
$("#profile-form").onsubmit = async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const account = await window.quota.add(
      Object.fromEntries(new FormData(event.target)),
    );
    $("#profile-dialog").close();
    if (account.mode === "manual") openRecord(account);
    else await refresh(account.id);
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
};
$("#record-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await window.quota.record(recordingId, {
      observedAt: new Date().toISOString(),
      windows: [
        {
          label: form.elements.period.value,
          remaining: Number(form.elements.remaining.value),
          resetsAt: form.elements.resetsAt.value
            ? new Date(form.elements.resetsAt.value).toISOString()
            : null,
        },
      ],
    });
    $("#record-dialog").close();
  } catch (error) {
    toast(error.message);
  }
};
window.quota.onState((state) => {
  accounts = state;
  render();
});
setInterval(render, 60_000);
render();
