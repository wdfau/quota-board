import { services, serviceIds, shortest, periods } from "../core/services.js";

const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const notice = document.querySelector("#notice");
const { invoke, onState, onNavigate } = window.boardAPI;
const board = new URLSearchParams(location.search).get("surface") === "board";
const icons = {
  back: "M15 18l-6-6 6-6",
  settings: "M12 8.5v-2m0 11.5v-2.5m3.5-3.5H18M6 12h2.5m1-2.5-2-2m9 9-2-2m0-5 2-2m-9 9 2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
  refresh: "M20 6v5h-5M4 13a8 8 0 0 0 14 4m2-6a8 8 0 0 0-14-4",
  power: "M12 3v9m5-7a8 8 0 1 1-10 0",
  edit: "M4 16l-1 5 5-1L20 8l-4-4L4 16zm10-10 4 4",
  add: "M12 5v14M5 12h14",
};
const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const symbol = (name) => `<svg class="symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]}"/></svg>`;
const brand = (id) => `<img class="brand" src="BrandIcons/${services[id].icon}.svg" alt="">`;
const iconButton = (name, label, attributes = "") => `<button type="button" class="icon-button" aria-label="${label}" title="${label}" ${attributes}>${symbol(name)}</button>`;
const forService = (id) => state.accounts.filter((account) => account.provider === id);
const title = (account) => account.alias || account.label;
const address = (account) => account.email || "邮箱未提供";
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
let state = await invoke("state");
let route = board ? {} : await invoke("initial");
let selected = route.provider || serviceIds[0];
let detail, guide, toastTimer;
let busy = false;

function message(text) {
  notice.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { notice.textContent = ""; }, 4500);
}

async function action(name, ...args) {
  try {
    return await invoke(name, ...args);
  } catch (error) {
    message(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    return undefined;
  }
}

function ring(window, detailView) {
  const value = window ? Math.round(window.remaining) : null;
  const dash = value === 0 || value === null ? "" : `<path class="meter-value" d="M12 55 A30 30 0 1 1 54 55" pathLength="100" stroke-dasharray="${value} 100"/>`;
  const minutes = window?.resetsAt ? Math.max(0, Math.ceil((Date.parse(window.resetsAt) - Date.now()) / 60000)) : null;
  const reset = minutes === null ? "" : minutes >= 1440
    ? `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时`
    : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
  return `<div class="quota">
    <div class="meter" aria-label="${value === null ? "额度暂不可用" : `剩余 ${value}%`}">
      <svg viewBox="0 0 66 61" aria-hidden="true"><path class="meter-track" d="M12 55 A30 30 0 1 1 54 55"/>${dash}</svg>
      <strong>${value === null ? "—" : `${value}%`}</strong>
    </div>
    <span class="period">${escape(window?.label || "暂无额度")}</span>
    ${detailView ? `<span class="quota-detail" title="${escape(window?.detail)}">${escape(window?.detail)}</span><span class="reset">${reset}</span>` : ""}
  </div>`;
}

function renderBoard() {
  const visible = serviceIds.filter((id) => !state.hidden.includes(id) && forService(id).length);
  const current = detail ? forService(detail) : [];
  const observations = state.accounts.map((account) => account.observedAt).filter(Boolean).sort();
  const status = state.refreshing ? "更新中…" : observations.length ? timeFormat.format(new Date(observations.at(-1))) : "待更新";
  const content = detail ? detailContent(current) : visible.length
    ? `<div class="tiles">${visible.map((id) => {
      const account = forService(id).find((entry) => entry.id === state.active[id]);
      return `<button class="tile ${services[id].color}" data-detail="${id}">
        <span class="provider-label">${brand(id)}${services[id].name}</span>
        <span class="dim ellipsis" title="${escape(title(account))}">${escape(title(account))}</span>
        ${ring(shortest(account.windows), false)}
      </button>`;
    }).join("")}</div>`
    : '<div class="empty-board"><p>暂无可显示的平台</p><button class="tonal" data-settings>打开设置</button></div>';
  root.innerHTML = `<main class="panel">
    ${detail ? `<header class="detail-head">${iconButton("back", "返回总览", "data-back")}<h1>${brand(detail)}${services[detail].name}</h1>${iconButton("settings", "设置", "data-settings")}</header>`
      : '<header class="panel-head"><h1>额度总览</h1></header>'}
    ${content}
    <footer class="panel-footer"><span class="status"><i class="${observations.length ? "ready" : ""}"></i>${status}</span>
      ${detail ? "" : iconButton("settings", "设置", "data-settings")}${iconButton("refresh", "刷新额度", "data-refresh")}</footer>
  </main>`;
  const count = detail ? current.length : visible.length;
  const maxWindows = Math.max(1, ...current.map((account) => account.windows.length));
  const width = detail ? Math.min(1040, Math.max(370, Math.min(count, 3) * Math.max(164, Math.min(maxWindows, 4) * 86 + 24) + 44))
    : Math.max(320, visible.length * 148 + 40);
  const height = detail ? Math.min(700, 82 + Math.max(1, Math.ceil(count / 3)) * 186) : visible.length ? 220 : 190;
  void action("panel-size", width, height);
}

function detailContent(accounts) {
  return `<div class="details">${accounts.map((account) => {
    const isActive = account.id === state.active[detail];
    return `<article class="account ${services[detail].color} ${isActive ? "active" : "switchable"}" data-account="${account.id}" ${isActive ? "" : 'tabindex="0" aria-keyshortcuts="Enter" title="双击切换账号"'}>
      <h2>${isActive ? "<i></i>" : ""}<span class="ellipsis" title="${escape(title(account))}">${escape(title(account))}</span></h2>
      <p class="dim ellipsis" title="${escape(address(account))}">${escape(address(account))}</p>
      <div class="rings">${(account.windows.length ? account.windows : [null]).map((window) => ring(window, true)).join("")}</div>
      ${account.error ? '<small class="dim">读取未完成</small>' : ""}
    </article>`;
  }).join("")}</div>`;
}

function renderSettings() {
  const accounts = forService(selected);
  const provider = services[selected];
  root.innerHTML = `<main class="settings">
    <aside><h2>平台</h2><nav>${serviceIds.map((id) => `<button data-provider="${id}" aria-current="${id === selected}">${brand(id)}${services[id].name}</button>`).join("")}</nav></aside>
    <section class="settings-body">
      <h1>${provider.name}</h1>
      <label class="setting-row"><span><strong>在总览中显示</strong><small>${accounts.length ? "显示当前账号的最短周期额度" : "导入账号后即可开启"}</small></span>
        <input class="switch" type="checkbox" role="switch" id="visibility" ${accounts.length && !state.hidden.includes(selected) ? "checked" : ""} ${accounts.length ? "" : "disabled"}></label>
      <div class="account-head"><h2>登录账号</h2><button class="tonal" data-add>${symbol("add")}添加账号</button></div>
      ${accounts.length ? `<div class="account-list">${accounts.map((account) => {
        const active = account.id === state.active[selected];
        return `<div class="account-row">${brand(selected)}<div class="identity">
          <strong>${escape(title(account))}</strong><small>${escape(address(account))}</small>
          <small>${active ? "当前账号 · " : ""}${account.mode === "manual" ? "手动记录" : escape(account.source)}</small>
        </div>
        ${account.mode === "manual" ? `<button class="text-button" data-record="${account.id}">记录额度</button>`
          : selected === "claude" ? `<button class="text-button" data-snapshot="${account.id}">连接额度记录</button>` : ""}
        ${active ? "" : `<button class="tonal" data-switch="${account.id}">切换</button>`}
        ${iconButton("edit", "编辑显示名称", `data-edit="${account.id}"`)}</div>`;
      }).join("")}</div>` : '<p class="dim">还没有导入账号。</p>'}
    </section>
    <footer class="settings-footer">${iconButton("power", "退出或重启额度看板", "data-power")}</footer>
  </main>`;
}

function beginGuide(provider) {
  guide = { step: provider ? 2 : 1, provider, services: new Set(provider ? [provider] : serviceIds), candidates: [], checked: new Set(), emails: new Map(), scanning: false };
  render();
  if (provider) void scan();
}

async function scan() {
  const session = guide;
  if (!session || session.scanning) return;
  session.scanning = true;
  render();
  const entries = await action("scan", [...session.services]);
  if (guide !== session) return;
  if (entries) {
    for (const entry of entries) {
      const matching = session.candidates.find((account) => account.provider === entry.provider && account.identityKey === entry.identityKey);
      if (!matching) session.candidates.push(entry);
    }
  }
  session.scanning = false;
  render();
}

function renderGuide() {
  const { provider, step, scanning, checked } = guide;
  const names = ["选择平台", "选择要导入的账号", "确认导入"];
  const chosen = guide.candidates.filter((entry) => checked.has(entry.id));
  const description = step === 1 ? "勾选要在额度看板中管理的平台。"
    : step === 2 ? "勾选需要导入的账号。登录完成后，可重新扫描。"
      : "确认账号后，额度总览会显示每个平台的最短周期。";
  const content = step === 1 ? `<div class="service-picker">${serviceIds.map((id) =>
    `<label><input type="checkbox" data-service="${id}" ${guide.services.has(id) ? "checked" : ""}>${brand(id)}${services[id].name}</label>`).join("")}</div>`
    : step === 2 ? [...guide.services].map((id) => {
      const accounts = guide.candidates.filter((account) => account.provider === id);
      return `<section class="import-group"><div class="account-head"><h2>${brand(id)}${services[id].name}</h2>
        <button class="tonal" data-add-service="${id}">${symbol("add")}添加账号</button></div>
        ${accounts.length ? accounts.map((entry) => `<label class="import-row"><input type="checkbox" data-check="${entry.id}" ${checked.has(entry.id) || entry.imported ? "checked" : ""} ${entry.imported ? "disabled" : ""}>
          <span>${escape(entry.email || entry.label)}${entry.imported ? " · 已导入" : ""}</span></label>
          ${!entry.email && checked.has(entry.id) ? `<input class="email-entry" type="email" placeholder="填写此账号的邮箱" aria-label="账号邮箱" data-email="${entry.id}" value="${escape(guide.emails.get(entry.id))}">` : ""}`).join("")
          : '<p class="dim">暂未找到可导入的账号。</p>'}</section>`;
    }).join("") : `<ul class="review-list">${chosen.map((entry) => `<li>${brand(entry.provider)}<span>${escape(entry.email || guide.emails.get(entry.id) || entry.label)}</span></li>`).join("")}</ul>`;
  root.innerHTML = `<main class="guide">
    <header><small>第 ${step} 步，共 3 步</small><h1>${names[step - 1]}</h1><div class="account-head"><p class="dim">${description}</p>
      ${step === 2 ? `<button class="tonal" data-scan ${scanning ? "disabled" : ""}>${scanning ? "扫描中…" : "重新扫描"}</button>` : ""}</div></header>
    <div class="guide-content">${content}</div>
    <footer><button class="text-button" data-guide-cancel>${provider ? "取消" : "暂不导入"}</button><span></span>
      ${step > (provider ? 2 : 1) ? '<button class="tonal" data-guide-back>上一步</button>' : ""}
      <button class="primary" data-guide-next ${(step === 1 && !guide.services.size) || (step === 2 && (!checked.size || scanning)) ? "disabled" : ""}>${step === 3 ? provider ? "保存账号" : "导入并打开总览" : "下一步"}</button>
    </footer></main>`;
}

function render() {
  if (board) renderBoard();
  else if (guide) renderGuide();
  else renderSettings();
}

function showDialog(heading, content, buttons) {
  dialog.innerHTML = `<form method="dialog"><h2>${heading}</h2>${content}<div class="dialog-actions">${buttons}</div></form>`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve({
      choice: dialog.returnValue,
      values: Object.fromEntries(new FormData(dialog.querySelector("form"))),
    }), { once: true });
  });
}
const cancel = '<button type="submit" class="text-button" value="cancel" formnovalidate>取消</button>';
const primary = (name, value = "confirm") => `<button type="submit" class="primary" value="${value}">${name}</button>`;

async function askSwitch(id) {
  if (busy || dialog.open) return;
  const account = state.accounts.find((entry) => entry.id === id);
  if (!account || state.active[account.provider] === id) return;
  const isolated = account.mode === "cli" && ["codex", "copilot"].includes(account.provider);
  const result = await showDialog("切换账号？", `<p>将 ${services[account.provider].name} 的总览切换到 <strong>${escape(title(account))}</strong>。</p><p class="dim">${escape(address(account))}</p>${isolated ? '<p class="dim">独立 CLI 配置会在终端打开。桌面应用登录由平台管理。</p>' : ""}`, cancel + primary("确认切换"));
  if (result.choice !== "confirm") return;
  busy = true;
  message("正在切换账号…");
  if (await action("switch", id)) message(`已切换到 ${title(account)}`);
  busy = false;
}

async function addAccount(id) {
  const official = services[id].cli;
  const help = official ? '<p class="dim">使用官方 CLI 登录并重新扫描，也可以手动登记账号。</p>' : '<p class="dim">在平台查看真实用量，再手动记录到已添加的账号。</p>';
  const result = await showDialog(`添加 ${services[id].name} 账号`, `${help}
    <label>邮箱<input type="email" name="email" placeholder="name@example.com" required maxlength="254"></label>
    <label>显示名称<input name="alias" maxlength="60" placeholder="可选"></label>`,
  cancel + `<button type="submit" class="text-button" value="login" formnovalidate>${official ? "官方登录" : "打开官网"}</button>` + primary("添加账号"));
  if (result.choice === "login") {
    if (official) {
      if (await action("login", id)) message("登录完成后，点「重新扫描」。");
    } else await action("site", id);
  }
  if (result.choice === "confirm") {
    const candidate = await action("candidate", id, result.values);
    if (!candidate || !guide) return;
    if (guide.candidates.some((entry) => entry.provider === id && entry.email?.toLowerCase() === candidate.email)) {
      message("这个账号已经在列表中。");
      return;
    }
    guide.candidates.push(candidate);
    guide.checked.add(candidate.id);
    render();
  }
}

async function editAccount(id) {
  const account = state.accounts.find((entry) => entry.id === id);
  const result = await showDialog("编辑显示名称", `<p class="dim">${escape(address(account))}</p>
    <label>显示名称<input name="alias" maxlength="60" value="${escape(account.alias ?? title(account))}" autofocus></label>`, cancel + primary("保存"));
  if (result.choice === "confirm") await action("rename", id, result.values.alias);
}

async function recordQuota(id) {
  const account = state.accounts.find((entry) => entry.id === id);
  const result = await showDialog("记录剩余额度", `<p class="dim">${escape(address(account))} · 空白周期不显示</p><div class="record-fields">
    ${Object.keys(periods).map((period) => `<label>${period}<input type="number" min="0" max="100" step="any" name="${period}" value="${account.windows.find((entry) => entry.label === period)?.remaining ?? ""}" placeholder="%"></label>`).join("")}</div>`, cancel + primary("保存额度"));
  if (result.choice !== "confirm") return;
  const windows = Object.entries(result.values).filter(([, value]) => value !== "").map(([label, value]) => ({ label, remaining: Number(value), minutes: periods[label] }));
  await action("record", id, windows);
}

async function advance() {
  if (guide.step === 1) { guide.step = 2; render(); await scan(); return; }
  const selection = [...guide.checked].map((id) => ({ id, email: guide.emails.get(id) }));
  if (guide.step === 2) {
    if (selection.some(({ id, email }) => !guide.candidates.find((entry) => entry.id === id)?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || ""))) {
      message("请填写所选账号的完整邮箱。"); return;
    }
    guide.step = 3; render(); return;
  }
  const provider = guide.provider;
  if (await action("import", selection, !provider)) { guide = undefined; render(); }
}

root.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const data = target.dataset;
  if ("settings" in data) await action("settings", detail);
  if ("detail" in data) { detail = data.detail; render(); }
  if ("back" in data) { detail = undefined; render(); }
  if ("refresh" in data) await action("refresh");
  if ("provider" in data) { selected = data.provider; render(); }
  if ("add" in data) beginGuide(selected);
  if ("addService" in data) await addAccount(data.addService);
  if ("scan" in data) await scan();
  if ("switch" in data) await askSwitch(data.switch);
  if ("edit" in data) await editAccount(data.edit);
  if ("record" in data) await recordQuota(data.record);
  if ("snapshot" in data) await action("snapshot", data.snapshot);
  if ("power" in data) {
    const result = await showDialog("额度看板", "<p>请选择要执行的操作。</p>", cancel + '<button value="quit" class="tonal">退出</button>' + primary("重启", "restart"));
    if (["quit", "restart"].includes(result.choice)) await action("power", result.choice);
  }
  if ("guideNext" in data) await advance();
  if ("guideBack" in data) { guide.step--; render(); }
  if ("guideCancel" in data) {
    if (guide.provider) { guide = undefined; render(); }
    else {
      const result = await showDialog("暂不导入账号？", "<p>之后可以从设置添加账号。</p>", cancel + primary("打开空总览"));
      if (result.choice === "confirm") await action("import", [], true);
    }
  }
});
root.addEventListener("dblclick", (event) => {
  const target = event.target.closest("[data-account]");
  if (target) void askSwitch(target.dataset.account);
});
root.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.dataset.account) void askSwitch(event.target.dataset.account);
  if (event.key === "Escape" && board && !dialog.open) void action("hide");
});
root.addEventListener("change", async (event) => {
  const { target } = event;
  if (target.id === "visibility") await action("visible", selected, target.checked);
  if (target.dataset.service) {
    if (target.checked) guide.services.add(target.dataset.service); else guide.services.delete(target.dataset.service);
    root.querySelector("[data-guide-next]").disabled = !guide.services.size;
  }
  if (target.dataset.check) {
    if (target.checked) guide.checked.add(target.dataset.check); else guide.checked.delete(target.dataset.check);
    const candidate = guide.candidates.find((entry) => entry.id === target.dataset.check);
    if (candidate?.email) root.querySelector("[data-guide-next]").disabled = !guide.checked.size || guide.scanning; else render();
  }
});
root.addEventListener("input", ({ target }) => {
  if (target.dataset.email) guide.emails.set(target.dataset.email, target.value);
});
onState((next) => { state = next; if (!guide) render(); });
onNavigate((next) => {
  selected = next.provider || selected;
  if (next.mode === "setup") beginGuide();
  else if (!guide) render();
});
if (route.mode === "setup" || (!board && !state.configured)) beginGuide();
else render();
if (board) setInterval(() => { if (!dialog.open && !root.contains(document.activeElement)) render(); }, 30000);
