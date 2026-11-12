import { providers } from "../core/model.js";
import { floatingSelection } from "../core/floating.js";
import { demoAccounts } from "./demo.js";

const $ = (selector) => document.querySelector(selector);
const isDemo = new URLSearchParams(location.search).get("demo") === "1";
let accounts = isDemo ? demoAccounts : await window.quota.list();
let preference = await window.quota.floatingPreference();
const symbols = { codex: "◎", claude: "✳", cursor: "↗", copilot: "⌘" };
const svgNS = "http://www.w3.org/2000/svg";
// 和 Mac 版一样：首页按服务列出，点进去看这个服务的所有账号
let openProvider = null;
let refreshing = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function status(account) {
  if (!account?.snapshot) return "尚无额度记录";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(account.snapshot.observedAt)) / 60_000),
  );
  const age =
    minutes < 1
      ? "刚刚"
      : minutes < 60
        ? minutes + " 分钟前"
        : Math.floor(minutes / 60) + " 小时前";
  const source =
    account.mode === "manual"
      ? "手动记录"
      : account.mode === "claude"
        ? "会话记录"
        : account.error || minutes > 5
          ? "上次记录"
          : "已同步";
  return source + " · " + age;
}
function resetDescription(date) {
  if (!date) return "重置时间待确认";
  const minutes = Math.ceil((Date.parse(date) - Date.now()) / 60_000);
  if (minutes <= 0) return "已到重置时间，待刷新";
  if (minutes < 60) return minutes + " 分钟后重置";
  if (minutes < 1440) return Math.floor(minutes / 60) + " 小时后重置";
  return Math.floor(minutes / 1440) + " 天后重置";
}
function showError(error) {
  if (!$("#float-error")) return;
  $("#float-error").textContent = error.message;
  $("#float-error").hidden = false;
}

function renderBall({ account, quota }) {
  const used = quota ? Math.round(100 - quota.remaining) : null;
  $("#orb-brand").textContent = symbols[account?.provider] || "＋";
  $("#orb-value").textContent = used === null ? "—" : used + "%";
  const old =
    account &&
    (account.error ||
      account.mode === "manual" ||
      account.mode === "claude" ||
      Date.now() - Date.parse(account.snapshot?.observedAt) > 300_000);
  $("#orb-caption").textContent = quota ? (old ? "上次已用" : "已用") : "未连接";
  $("#orb").classList.toggle("old", Boolean(old));
  $("#orb").classList.toggle("unknown", used === null);
  $("#orb").style.setProperty("--used", used || 0);
  const description = account
    ? providers[account.provider].name +
      " · " +
      account.label +
      " · " +
      (quota
        ? quota.label + " 已用 " + used + "% · " + status(account)
        : "暂无额度记录")
    : "连接订阅账号";
  $("#orb").title = description + "\n点击展开，拖动调整位置";
  $("#orb").setAttribute("aria-label", description + "，点击展开额度面板");
}

// 一个小圆环：圈里是剩余百分比，圈下是周期名
function meter(tag, quota, pinned) {
  const value = Math.round(quota.remaining);
  const box = node(
    tag,
    "meter" + (pinned ? " pinned" : "") + (value < 20 ? " low" : ""),
  );
  const ring = node("span", "ring");
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("aria-hidden", "true");
  for (const [name, dash] of [
    ["ring-track", "100 0"],
    ["ring-value", value + " 100"],
  ]) {
    const circle = document.createElementNS(svgNS, "circle");
    for (const [key, val] of Object.entries({
      cx: 20,
      cy: 20,
      r: 17,
      pathLength: 100,
      class: name,
      "stroke-dasharray": dash,
    }))
      circle.setAttribute(key, val);
    svg.append(circle);
  }
  ring.append(svg, node("span", "ring-number", value + "%"));
  box.append(ring, node("span", "meter-label", quota.label));
  box.title =
    quota.label +
    " · 剩余 " +
    value +
    "% · " +
    resetDescription(quota.resetsAt) +
    (pinned ? "\n正在悬浮球上显示" : "");
  return box;
}
function isPinned(selected, account, quota) {
  return (
    account.id === selected.account?.id && quota.label === selected.quota?.label
  );
}

function renderHome(selected) {
  $("#back").hidden = true;
  $("#title").textContent = "额度看板";
  $("#subtitle").textContent = "剩余额度 · 点服务看全部账号";
  const groups = Object.keys(providers)
    .map((provider) => [
      provider,
      accounts.filter((item) => item.provider === provider),
    ])
    .filter(([, list]) => list.length);
  if (!groups.length) {
    $("#subtitle").textContent = "";
    const empty = node("div", "empty");
    const add = node("button", "pill", "添加账号");
    add.onclick = () => window.quota.manage().catch(showError);
    empty.append(node("p", "", "还没有账号"), add);
    return [empty];
  }
  return groups.map(([provider, list]) => {
    const current =
      list.find((item) => item.id === selected.account?.id) || list[0];
    const row = node("button", "service-row");
    row.setAttribute(
      "aria-label",
      providers[provider].name + " · " + current.label + "，查看所有账号",
    );
    const text = node("span", "row-text");
    text.append(
      node("span", "row-title", providers[provider].name),
      node(
        "span",
        "row-subtitle",
        current.label + (list.length > 1 ? " · 共 " + list.length + " 个" : ""),
      ),
    );
    const meters = node("span", "meters");
    const windows = current.snapshot?.windows || [];
    meters.append(
      ...(windows.length
        ? windows.map((quota) =>
            meter("span", quota, isPinned(selected, current, quota)),
          )
        : [node("span", "row-empty", "待更新")]),
    );
    row.append(
      node("span", "service-symbol", symbols[provider]),
      text,
      meters,
      node("span", "chevron", "›"),
    );
    row.onclick = () => {
      openProvider = provider;
      render();
    };
    return row;
  });
}

function renderDetail(selected) {
  const list = accounts.filter((item) => item.provider === openProvider);
  if (!list.length) {
    openProvider = null;
    return renderHome(selected);
  }
  $("#back").hidden = false;
  $("#title").textContent = providers[openProvider].name;
  $("#subtitle").textContent = list.length + " 个账号 · 点圆环放到悬浮球";
  return list.map((account) => {
    const card = node("div", "account-card");
    const head = node("div", "card-head");
    const text = node("span", "row-text");
    text.append(
      node("span", "row-title", account.label),
      node("span", "row-subtitle", status(account)),
    );
    head.append(node("span", "service-symbol", symbols[account.provider]), text);
    if (account.id === selected.account?.id)
      head.append(node("span", "ball-tag", "悬浮球"));
    if (account.error) card.title = account.error;
    const meters = node("div", "meters");
    const windows = account.snapshot?.windows || [];
    meters.append(
      ...(windows.length
        ? windows.map((quota) => {
            const button = meter(
              "button",
              quota,
              isPinned(selected, account, quota),
            );
            button.onclick = () =>
              window.quota
                .selectFloating(account.id, quota.label)
                .catch(showError);
            return button;
          })
        : [node("span", "row-empty", "尚无额度记录")]),
    );
    card.append(head, meters);
    return card;
  });
}

function footerStatus() {
  if (refreshing) return "正在刷新…";
  if (isDemo) return "演示数据";
  const times = accounts
    .map((item) => Date.parse(item.snapshot?.observedAt))
    .filter(Number.isFinite);
  if (!times.length) return accounts.length ? "待更新" : "";
  return (
    "更新于 " +
    new Date(Math.max(...times)).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })
  );
}
const refreshable = () => accounts.filter((item) => item.mode !== "manual");

async function refreshAll() {
  if (refreshing || isDemo || !refreshable().length) return;
  refreshing = true;
  $("#float-error").hidden = true;
  render();
  for (const account of refreshable()) {
    try {
      await window.quota.refresh(account.id);
    } catch (error) {
      showError(error);
    }
  }
  refreshing = false;
  render();
}

function render() {
  const selected = floatingSelection(accounts, preference);
  if ($("#orb")) return renderBall(selected);
  $("#view").replaceChildren(
    ...(openProvider ? renderDetail(selected) : renderHome(selected)),
  );
  $("#status").textContent = footerStatus();
  $("#float-refresh").disabled =
    isDemo || refreshing || !refreshable().length;
  $("#float-refresh").classList.toggle("spinning", refreshing);
}

if ($("#orb")) {
  let start;
  let dragged = false;
  $("#orb").onpointerdown = (event) => {
    if (event.button !== 0) return;
    start = { x: event.screenX, y: event.screenY };
    dragged = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    window.quota.dragFloating("start", start).catch(showError);
  };
  $("#orb").onpointermove = (event) => {
    if (!start) return;
    const point = { x: event.screenX, y: event.screenY };
    if (Math.hypot(point.x - start.x, point.y - start.y) < 4 && !dragged)
      return;
    dragged = true;
    window.quota.dragFloating("move", point).catch(showError);
  };
  function finish(event) {
    if (!start) return;
    start = null;
    window.quota
      .dragFloating("end", { x: event.screenX, y: event.screenY })
      .catch(showError);
  }
  $("#orb").onpointerup = finish;
  $("#orb").onpointercancel = finish;
  $("#orb").onclick = () => {
    if (!dragged) window.quota.toggleFloating().catch(showError);
  };
} else {
  const back = () => {
    openProvider = null;
    render();
  };
  $("#back").onclick = back;
  $("#manage").onclick = () => window.quota.manage().catch(showError);
  $("#float-refresh").onclick = refreshAll;
  // 面板收起后，下次打开回到首页
  window.addEventListener("blur", back);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (openProvider) back();
      else window.quota.toggleFloating().catch(showError);
    } else if (event.key.toLowerCase() === "r" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      refreshAll();
    }
  });
}
window.quota.onState((state) => {
  if (!isDemo) accounts = state;
  render();
});
window.quota.onPreferences((value) => {
  preference = value;
  render();
});
setInterval(render, 60_000);
render();
