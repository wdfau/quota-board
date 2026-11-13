#!/usr/bin/env python3
"""Account-scoped quota reads using the pinned CodexBar CLI."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import time
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor"
if not VENDOR.is_dir():
    VENDOR = ROOT.parent / "vendor"
USER_HOME = Path.home()
KIRO_ACCOUNTS = USER_HOME / "Library/Application Support/Kiro CLI Accounts"
BOARD_DATA = USER_HOME / "Library/Application Support/QuotaBoard"
CARDS = [
    ("codex-default", "Codex", "当前登录账号"),
    ("codex-n", "Codex", "Codex 账号 1"),
    ("codex-b", "Codex", "Codex 账号 2"),
    ("codex-w", "Codex", "Codex 账号 3"),
    ("kiro-1", "Kiro", "账号 1"),
    ("kiro-2", "Kiro", "账号 2"),
    ("kiro-3", "Kiro", "账号 3"),
    ("kiro-default", "Kiro", "当前登录账号"),
    ("cursor", "Cursor", "当前登录账号"),
    ("gemini", "Gemini", "网页版 · Google AI Pro"),
]
URLS = {
    "Codex": "https://chatgpt.com/codex/settings/usage",
    "Kiro": "https://app.kiro.dev/account/usage",
    "Cursor": "https://cursor.com/dashboard",
    "Gemini": "https://gemini.google.com/usage",
}


class ReadError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(command, environment, timeout=65):
    process = subprocess.Popen(
        command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=timeout)
        return process.returncode, output
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise ReadError("timeout", "读取超时，请稍后刷新") from None


def codex_payload(path):
    try:
        token = json.loads(path.read_bytes())["tokens"]["id_token"].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
        return {}


def claims(path):
    try:
        auth = codex_payload(path)["https://api.openai.com/auth"]
        return auth["chatgpt_user_id"], auth["chatgpt_account_id"]
    except (KeyError, TypeError):
        return None


def codex_home(card_id):
    return USER_HOME / (".codex" if card_id == "codex-default" else "." + card_id)


def kiro_home(card_id):
    return USER_HOME if card_id == "kiro-default" else KIRO_ACCOUNTS / card_id.removeprefix("kiro-")


def codex_email(card_id):
    payload = codex_payload(codex_home(card_id) / "auth.json")
    profile = payload.get("https://api.openai.com/profile")
    for email in (payload.get("email"), profile.get("email") if isinstance(profile, dict) else None):
        if isinstance(email, str) and "@" in email:
            return email
    return ""


def kiro_database(home):
    return home / "Library/Application Support/kiro-cli/data.sqlite3"


def kiro_identity(home):
    path = kiro_database(home)
    if not path.is_file():
        return None
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.4) as db:
            row = db.execute("SELECT value FROM state WHERE key='telemetryUserId'").fetchone()
            return row[0] if row else None
    except sqlite3.Error:
        return None


def kiro_signed_in(home):
    path = kiro_database(home)
    if not path.is_file():
        return False
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.4) as db:
            return db.execute("SELECT 1 FROM auth_kv WHERE key='kirocli:odic:token'").fetchone() is not None
    except sqlite3.Error:
        return False


def active_accounts():
    active = {}
    try:
        chosen = (BOARD_DATA / "active-gemini-account").read_text().strip()
        if re.fullmatch(r"gemini-[0-9a-f]{64}", chosen):
            active["Gemini"] = chosen
    except (OSError, ValueError):
        pass
    current_codex = claims(USER_HOME / ".codex/auth.json")
    if current_codex:
        matches = [
            f"codex-{slot}" for slot in ("n", "b", "w")
            if claims(USER_HOME / f".codex-{slot}/auth.json") == current_codex
        ]
        if matches:
            active["Codex"] = matches[0]
        else:
            active["Codex"] = "codex-default"

    slots = ("1", "2", "3")
    try:
        last_kiro = (KIRO_ACCOUNTS / "active-account").read_text().strip()
    except (OSError, ValueError):
        last_kiro = None
    if last_kiro in slots and kiro_database(KIRO_ACCOUNTS / last_kiro).is_file():
        active["Kiro"] = f"kiro-{last_kiro}"
    else:
        current_kiro = kiro_identity(USER_HOME)
        if current_kiro:
            matches = [slot for slot in slots if kiro_identity(KIRO_ACCOUNTS / slot) == current_kiro]
            if matches:
                active["Kiro"] = f"kiro-{matches[0]}"
            else:
                active["Kiro"] = "kiro-default"
    if cursor_email():
        active["Cursor"] = "cursor"
    return active


def environment(card_id):
    env = dict(os.environ)
    env["PATH"] = f"{USER_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    for key in ("OPENAI_API_KEY", "KIRO_API_KEY", "CODEX_HOME", "KIRO_HOME", "KIRO_DATA_DIR"):
        env.pop(key, None)
    env["KIRO_NO_AUTO_UPDATE"] = "1"
    env["KIRO_SKIP_BINARY_PINNING"] = "1"
    if card_id.startswith("codex-"):
        home = codex_home(card_id)
        expected = claims(home / "auth.json")
        if expected is None:
            raise ReadError("not_logged_in", "请在 Codex 登录后重新扫描账号")
        default = USER_HOME / ".codex"
        if claims(default / "auth.json") == expected:
            home = default
        env["CODEX_HOME"] = str(home)
    elif card_id.startswith("kiro-"):
        home = kiro_home(card_id)
        if not kiro_database(home).is_file():
            raise ReadError("not_logged_in", "未找到此 Kiro 账号，请先登录")
        env["HOME"] = str(home)
        env["KIRO_HOME"] = str(home / ".kiro")
    return env


def cursor_email():
    path = USER_HOME / "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    if not path.is_file():
        return ""
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.4) as db:
            row = db.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/cachedEmail'").fetchone()
        return row[0] if row and isinstance(row[0], str) else ""
    except sqlite3.Error:
        return ""


def identity_key(card_id):
    try:
        if card_id.startswith("codex-"):
            value = claims(codex_home(card_id) / "auth.json")
        elif card_id.startswith("kiro-"):
            value = kiro_identity(kiro_home(card_id))
        elif card_id == "cursor":
            value = cursor_email()
        else:
            return None
        return hashlib.sha256(json.dumps(value).encode()).hexdigest() if value else None
    except (OSError, sqlite3.Error, ValueError):
        return None


def discover_accounts():
    """List local account identifiers without fetching quotas or prompting for access."""
    unique = {}
    active = active_accounts()
    for card_id, provider, label in CARDS:
        if provider == "Gemini":
            continue
        if provider == "Kiro" and not kiro_signed_in(kiro_home(card_id)):
            continue
        identity = identity_key(card_id)
        if not identity:
            continue
        email = codex_email(card_id) if provider == "Codex" else cursor_email() if provider == "Cursor" else ""
        key = (provider, identity)
        if key not in unique or active.get(provider) == card_id:
            unique[key] = {"id": card_id, "provider": provider, "label": label,
                           "email": email, "identityKey": identity}
    return list(unique.values())


def auth_session(provider, interactive):
    access_file = USER_HOME / "Library/Application Support/QuotaBoard/access-enabled.json"
    try:
        enabled = json.loads(access_file.read_bytes())
    except (OSError, ValueError):
        enabled = {}
    if not interactive and not enabled.get(provider):
        raise ReadError("keychain_required", "点「授权读取」，允许系统提供本机登录信息")
    command = [str(VENDOR / "QuotaAccess"), provider]
    if interactive:
        command.append("--interactive")
    status, output = run(command, dict(os.environ), timeout=120 if interactive else 12)
    try:
        session = json.loads(output)
    except ValueError:
        raise ReadError("access_failed", "无法读取本机登录状态，请重新授权") from None
    if status or "error" in session:
        raise ReadError(session.get("error", "access_failed"), session.get("message", "读取登录失败"))
    if interactive:
        enabled[provider] = True
        access_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(dir=access_file.parent, delete=False) as file:
            temporary = Path(file.name)
            try:
                file.write(json.dumps(enabled).encode())
                file.flush()
                os.replace(temporary, access_file)
            finally:
                temporary.unlink(missing_ok=True)
    return session



def request_kiro(card_id, retry=True):
    env = environment(card_id)
    database = Path(env["HOME"]) / "Library/Application Support/kiro-cli/data.sqlite3"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
        row = db.execute("SELECT value FROM auth_kv WHERE key='kirocli:odic:token'").fetchone()
        if not row:
            raise ReadError("not_logged_in", "此 Kiro 账号未登录，请先打开对应快捷入口")
        token = json.loads(row[0]).get("access_token")
        profile_row = db.execute("SELECT value FROM state WHERE key='api.codewhisperer.profile'").fetchone()
    if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
        raise ReadError("not_logged_in", "此 Kiro 账号未登录，请先打开对应快捷入口")
    profile = json.loads(profile_row[0]) if profile_row else {}
    arn = profile.get("arn") if isinstance(profile, dict) else None
    region = arn.split(":")[3] if isinstance(arn, str) and len(arn.split(":")) >= 6 else "us-east-1"
    endpoints = {
        "us-east-1": "https://codewhisperer.us-east-1.amazonaws.com/",
        "eu-central-1": "https://q.eu-central-1.amazonaws.com/",
    }
    if region not in endpoints:
        raise ReadError("unavailable", "此 Kiro 区域暂未接入")
    config = "\n".join([
        "url = " + json.dumps(endpoints[region]),
        'request = "POST"',
        "header = " + json.dumps("Authorization: Bearer " + token),
        'header = "Content-Type: application/x-amz-json-1.0"',
        'header = "X-Amz-Target: AmazonCodeWhispererService.GetUsageLimits"',
        "data = " + json.dumps(json.dumps({"profileArn": arn} if arn else {})),
    ])
    response = subprocess.run([
        "/usr/bin/curl", "--silent", "--show-error", "--http1.1",
        "--retry", "1", "--retry-delay", "1", "--retry-all-errors", "--max-time", "18",
        "--config", "-", "--write-out", "\n%{http_code}",
    ], input=config, capture_output=True, text=True, timeout=42)
    if response.returncode:
        raise ReadError("network", "暂时无法连接 Kiro，保留上次读取结果")
    body, _, status = response.stdout.rpartition("\n")
    if status in ("401", "403"):
        if retry:
            try:
                # The official CLI owns token refresh and database locking.
                run(["kiro-cli", "chat", "--no-interactive", "/usage", "--v2"], env, timeout=40)
            except ReadError:
                pass
            return request_kiro(card_id, retry=False)
        raise ReadError("not_logged_in", "此 Kiro 登录已过期，请打开对应快捷入口后刷新")
    if status != "200":
        raise public_error("HTTP " + status, "kiro")
    data = json.loads(body)
    candidates = [row for row in data.get("usageBreakdownList", []) if row.get("resourceType") == "CREDIT"]
    if len(candidates) != 1:
        raise ReadError("unavailable", "Kiro 未返回可识别的积分额度")
    credit = candidates[0]
    used = credit.get("currentUsageWithPrecision", credit.get("currentUsage"))
    limit = credit.get("usageLimitWithPrecision", credit.get("usageLimit"))
    if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
               for value in (used, limit)) or limit <= 0 or used < 0:
        raise ReadError("unavailable", "Kiro 未返回可量化的积分额度")
    reset = credit.get("nextDateReset", data.get("nextDateReset"))
    if isinstance(reset, (int, float)):
        reset = datetime.fromtimestamp(reset, timezone.utc).isoformat(timespec="seconds")
    email = (data.get("userInfo") or {}).get("email", "")
    if not email:
        try:
            status, output = run(["kiro-cli", "whoami", "--format", "json"], env, timeout=10)
            identity = json.loads(output) if status == 0 else {}
            email = identity.get("email") or ""
        except (ReadError, ValueError):
            pass
    allowance = f"{max(0, limit - used):.2f} / {limit:g} 积分剩余"
    bonus_note = "（含服务合并的赠送积分）" if credit.get("bonuses") else ""
    return {
        "provider": "kiro", "version": "0.84.0", "source": "Kiro GetUsageLimits",
        "usage": {
            "primary": {"usedPercent": used / limit * 100, "windowMinutes": 43200, "resetsAt": reset},
            "identity": {"accountEmail": email},
            "planObservation": {"rawPlan": (data.get("subscriptionInfo") or {}).get("subscriptionTitle", "Kiro")},
            "updatedAt": now(),
            "details": [{"rows": [{"label": "积分", "value": allowance + bonus_note}]}],
        },
    }, None

def cli_result(card_id, interactive):
    provider = card_id.split("-")[0]
    if provider == "kiro":
        return request_kiro(card_id)
    env = environment(card_id)
    session = None
    provider_config = {"id": provider, "enabled": True}
    source = "cli"
    if provider in ("cursor", "gemini"):
        session = auth_session(provider, interactive)
        source = "web"
        provider_config.update(cookieSource="manual", cookieHeader=session["cookie"], source=source)
    # The manual session exists only in this private, short-lived configuration.
    with tempfile.TemporaryDirectory(prefix="quota-board-") as temporary:
        config = Path(temporary) / "config.json"
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as file:
            json.dump({"version": 1, "providers": [provider_config]}, file)
        env["CODEXBAR_CONFIG"] = str(config)
        status, output = run([
            str(VENDOR / "CodexBarCLI"), "usage", "--provider", provider,
            "--source", source, "--json", "--no-credits",
        ], env)
    try:
        payload = json.loads(output)
    except ValueError:
        raise ReadError("read_failed", "数据后端未返回有效结果，请稍后刷新") from None
    if not isinstance(payload, list) or not payload:
        raise ReadError("read_failed", "服务未返回额度信息")
    row = payload[0]
    if "error" in row or status:
        failure = row.get("error", {})
        if failure.get("kind") == "config":
            raise ReadError("config_error", "本地读取组件配置异常，请重新编译看板")
        raise public_error(failure.get("message", ""), provider)
    return row, session


def public_error(message, provider):
    lower = message.lower()
    if any(word in lower for word in ("expired", "unauthorized", "not logged", "sign in", "login", "401", "403")):
        return ReadError("not_logged_in", f"{provider.title()} 登录失效，请打开对应服务重新登录")
    if any(word in lower for word in ("timeout", "timed out", "network", "connect", "offline")):
        return ReadError("network", "暂时无法连接服务，保留上次读取结果")
    if "429" in lower or "rate limit" in lower:
        return ReadError("rate_limited", "服务限制了刷新频率，请稍后再试")
    if any(word in lower for word in ("parse", "format", "changed", "decode")):
        return ReadError("format_changed", "服务的数据格式已变化，需要更新读取组件")
    if "no " in lower and ("window" in lower or "quota" in lower):
        return ReadError("unavailable", "此账号尚未提供可读取的额度窗口")
    return ReadError("read_failed", "暂时无法读取额度，请打开官方用量页面核对")


GEMINI_ORIGIN = "https://gemini.google.com"
GEMINI_MAX_SLOTS = 12
GEMINI_QUERY = urlencode({
    "query_signature": "2/dWbCvkVB0X16r9NPnxifeOAAqdCqMf0xeWvau9yPy7g=",
    "variables": json.dumps({
        "g1Request": {"entrypoints": ["GEMINI_USAGE_SETTINGS_UPGRADE_BANNER"]},
        "workspaceRequest": {"recommendationsForSurfaceRequests": []},
    }, separators=(",", ":")),
})


def gemini_get(session, path):
    # Never follow a redirect: Google may redirect an empty slot to the default account.
    request = "url = " + json.dumps(GEMINI_ORIGIN + path) + "\n"
    request += "header = " + json.dumps("Cookie: " + session["cookie"]) + "\n"
    result = subprocess.run([
        "/usr/bin/curl", "--silent", "--http1.1", "--compressed",
        "--connect-timeout", "5", "--max-time", "12", "--retry", "1",
        "--retry-max-time", "14", "--config", "-", "--write-out", "\n%{http_code}\t%{redirect_url}",
    ], input=request, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    body, _, metadata = result.stdout.rpartition("\n")
    status, _, redirect = metadata.partition("\t")
    if result.returncode or status == "000" or status.startswith("5"):
        raise ReadError("network", "Gemini 暂时无法连接，保留上次结果")
    if status == "429":
        raise ReadError("rate_limited", "Gemini 限制了刷新频率，请稍后再试")
    return status, body, redirect


def gemini_slot_usage(session, slot):
    path = f"/u/{slot}/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery?{GEMINI_QUERY}"
    status, body, redirect = gemini_get(session, path)
    if status.startswith("3"):
        location = urlsplit(redirect)
        if slot > 0 and location.netloc == "gemini.google.com" and location.path.startswith("/u/0/"):
            return None
        if location.netloc == "accounts.google.com":
            raise ReadError("not_logged_in", "请在浏览器重新登录 Gemini")
    if status in ("401", "403"):
        raise ReadError("not_logged_in", "请在浏览器重新登录 Gemini")
    if status != "200":
        raise ReadError("read_failed", "Gemini 暂未返回可读取的账号信息")
    try:
        raw = json.loads(body.strip().removeprefix(")]}'").lstrip())
        info = next(item["data"]["viewer"]["rpcs"]["getUsageInfo"] for item in raw
                    if isinstance(item, dict) and isinstance(item.get("data"), dict)
                    and isinstance(item["data"].get("viewer"), dict)
                    and isinstance(item["data"]["viewer"].get("rpcs"), dict)
                    and isinstance(item["data"]["viewer"]["rpcs"].get("getUsageInfo"), dict))
    except (ValueError, StopIteration, TypeError, KeyError):
        raise ReadError("format_changed", "Gemini 的用量响应未能识别") from None
    return info


def gemini_slot_identity(session, slot):
    status, body, _ = gemini_get(session, f"/u/{slot}/usage")
    if status != "200":
        raise ReadError("not_logged_in", "Gemini 登录已变化，请刷新后再切换")
    start = re.search(r"\bWIZ_global_data\s*=\s*(?=\{)", body)
    try:
        payload = json.JSONDecoder().raw_decode(body, start.end())[0] if start else {}
        email = payload.get("oPEP7c", "")
    except (ValueError, AttributeError):
        email = ""
    if not isinstance(email, str) or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ReadError("format_changed", "Gemini 暂未提供可核对的账号邮箱")
    return "gemini-" + hashlib.sha256(email.casefold().encode()).hexdigest(), email


def gemini_web_route(session, slot):
    browser, separator, profile = session.get("profile", "").partition(" / ")
    if not separator or browser not in ("Chrome", "Edge", "Brave") or not re.fullmatch(r"Default|Profile [0-9]+", profile):
        raise ReadError("read_failed", "未找到可打开的 Gemini 浏览器配置")
    return {"browser": browser, "profile": profile, "slot": slot}


def gemini_account_card(session, slot, info):
    account_id, email = gemini_slot_identity(session, slot)
    windows = []
    pools = info.get("pools")
    if not isinstance(pools, list):
        pools = []
    for pool_type, title in (("GXU_FIVE_HOURLY", "5 小时"), ("GXU_WEEKLY", "每周")):
        pool = next((p for p in pools if isinstance(p, dict) and p.get("poolType") == pool_type), {})
        used = pool.get("percentageUsed")
        if not isinstance(used, (float, int)) or isinstance(used, bool) or not math.isfinite(used) or used < 0:
            continue
        period = pool.get("gxu")
        reset = period.get("windowRefreshesAt") if isinstance(period, dict) else None
        windows.append({"title": title, "remaining": 100 * (1 - min(1, used)),
                        "resetsAt": reset if isinstance(reset, str) else None, "detail": None,
                        "minutes": 300 if pool_type == "GXU_FIVE_HOURLY" else 10080})
    pro = info.get("subscriptionTier") == "TIER1"
    return {
        "id": account_id, "provider": "Gemini", "label": f"Gemini {slot + 1}",
        "email": email, "plan": "Google AI Pro" if pro else "Gemini",
        "status": "ok" if windows else "error",
        "message": None if windows else "此账号尚未提供可读取的额度窗口",
        "windows": windows, "details": [], "updatedAt": now() if windows else None,
        "source": session["profile"], "url": f"{GEMINI_ORIGIN}/u/{slot}/usage",
        "errorCode": None if windows else "unavailable",
        "identityKey": account_id, "geminiRoute": gemini_web_route(session, slot),
    }


def read_gemini_accounts(interactive, selected_ids=None):
    session = auth_session("gemini", interactive)
    if selected_ids is not None:
        cards = []
        for slot, (account_id, _) in gemini_identities(session):
            if account_id in selected_ids:
                info = gemini_slot_usage(session, slot)
                if info is not None:
                    card = gemini_account_card(session, slot, info)
                    if card["id"] == account_id:
                        cards.append(card)
        return cards
    slots = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        exhausted = False
        for start in range(0, GEMINI_MAX_SLOTS, 4):
            batch = pool.map(lambda slot: gemini_slot_usage(session, slot), range(start, start + 4))
            for slot, info in enumerate(batch, start):
                if info is None:
                    exhausted = True
                    break
                slots.append((slot, info))
            if exhausted:
                break
        selected = [(slot, item) for slot, item in slots if item.get("subscriptionTier") == "TIER1"] or slots[:1]
        if not selected:
            raise ReadError("not_logged_in", "请在浏览器登录 Gemini 后刷新")
        cards = list(pool.map(lambda pair: gemini_account_card(session, *pair), selected))
    unique = {}
    for card in cards:
        unique.setdefault(card["id"], card)
    return list(unique.values())


def gemini_identities(session):
    seen = set()
    for slot in range(GEMINI_MAX_SLOTS):
        try:
            identity = gemini_slot_identity(session, slot)
        except ReadError as error:
            if slot and error.code in ("not_logged_in", "format_changed"):
                break
            raise
        if identity[0] in seen:
            break
        seen.add(identity[0])
        yield slot, identity


def discover_gemini_accounts():
    session = auth_session("gemini", True)
    return [{"id": account_id, "provider": "Gemini", "label": f"Gemini {slot + 1}",
             "email": email, "identityKey": account_id, "geminiRoute": gemini_web_route(session, slot)}
            for slot, (account_id, email) in gemini_identities(session)]


def open_gemini_account(account_id, slot, page):
    session = auth_session("gemini", False)
    try:
        matched = gemini_slot_identity(session, slot)[0] == account_id
    except ReadError as error:
        if error.code == "network":
            raise
        matched = False
    if not matched:
        match = next((c for c in read_gemini_accounts(False) if c["id"] == account_id), None)
        if match is None:
            raise ReadError("account_changed", "找不到此 Gemini 账号，请确认浏览器已登录后刷新")
        route = match["geminiRoute"]
    else:
        route = gemini_web_route(session, slot)
    executables = {"Chrome": ("Google Chrome.app", "Google Chrome"),
                   "Edge": ("Microsoft Edge.app", "Microsoft Edge"),
                   "Brave": ("Brave Browser.app", "Brave Browser")}
    app, binary = executables[route["browser"]]
    executable = next((root / app / "Contents/MacOS" / binary
                       for root in (Path("/Applications"), USER_HOME / "Applications")
                       if (root / app / "Contents/MacOS" / binary).is_file()), None)
    if not executable:
        raise ReadError("browser_missing", "找不到此账号使用的浏览器")
    url = f'{GEMINI_ORIGIN}/u/{route["slot"]}/{page}'
    try:
        subprocess.Popen([str(executable), f'--profile-directory={route["profile"]}', url],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        raise ReadError("browser_launch", "浏览器未能打开，请稍后重试") from None
    BOARD_DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=BOARD_DATA, delete=False) as marker:
        target = Path(marker.name)
        try:
            marker.write(account_id.encode() + b"\n")
            marker.flush()
            os.replace(target, BOARD_DATA / "active-gemini-account")
        finally:
            target.unlink(missing_ok=True)


def request_gemini_desktop(account_id):
    bundle = ROOT.parent.parent
    if ROOT.name != "Resources" or ROOT.parent.name != "Contents" or bundle.suffix != ".app":
        raise ReadError("board_missing", "请使用额度看板应用内的切换入口")
    requests = BOARD_DATA / "gemini-desktop-requests"
    requests.mkdir(parents=True, exist_ok=True, mode=0o700)
    request = requests / f"{uuid4()}.json"
    request.write_text(json.dumps({"accountID": account_id, "createdAt": time.time()}), encoding="utf-8")
    try:
        subprocess.run(["/usr/bin/open", "-a", str(bundle), str(request)], check=True, timeout=12,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        request.unlink(missing_ok=True)
        raise ReadError("board_launch", "未能打开额度看板，请从菜单栏重试") from None


def normalize(card_id, provider, label, row, session=None):
    usage = row.get("usage") or {}
    labels = row.get("rateWindowLabels") or {}
    windows = []
    for key in ("primary", "secondary", "tertiary"):
        window = usage.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get("usedPercent")
        if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used) or used < 0:
            continue
        minutes = window.get("windowMinutes")
        if minutes == 300:
            title = "5 小时"
        elif minutes == 10080:
            title = "每周"
        elif minutes and minutes >= 40000:
            title = "本月"
        else:
            title = labels.get(key) or ("主要额度" if key == "primary" else "其他额度")
        windows.append({
            "title": title, "remaining": max(0, min(100, 100 - used)),
            "resetsAt": window.get("resetsAt"), "detail": None,
            "minutes": minutes if type(minutes) is int and minutes > 0 else None,
        })
    for window in usage.get("extraRateWindows") or []:
        if not isinstance(window, dict):
            continue
        used = window.get("usedPercent")
        if isinstance(used, (int, float)) and not isinstance(used, bool) and math.isfinite(used) and used >= 0:
            windows.append({
                "title": window.get("label") or window.get("title") or "额外额度",
                "remaining": max(0, min(100, 100 - used)),
                "resetsAt": window.get("resetsAt"), "detail": None,
                "minutes": window.get("windowMinutes") if type(window.get("windowMinutes")) is int else None,
            })
    if provider == "Cursor" and not any(window.get("resetsAt") for window in windows):
        raise ReadError("network", "Cursor 暂未返回完整的额度周期，请稍后刷新")
    if not windows:
        raise ReadError("unavailable", "服务未返回可量化的剩余额度")
    identity = usage.get("identity") or {}
    plan = (usage.get("planObservation") or {}).get("rawPlan") or usage.get("loginMethod") or identity.get("loginMethod") or ""
    email = usage.get("accountEmail") or identity.get("accountEmail") or (session or {}).get("email") or ""
    if provider == "Codex" and not email:
        email = codex_email(card_id)
    details = []
    for section in usage.get("details") or []:
        for item in section.get("rows") or []:
            key = item.get("label", "")
            value = item.get("value", "")
            if key and value:
                details.append(f"{key}  {value}")
                if key.lower() == "plan":
                    plan = value
    if provider == "Kiro" and details:
        windows[0]["detail"] = details[0].removeprefix("积分  ")
    if provider == "Cursor" and not plan:
        plan = (session or {}).get("plan", "")
    return {
        "id": card_id, "provider": provider, "label": label, "email": email,
        "plan": plan or provider, "status": "ok", "message": None,
        "windows": windows, "details": details[:6], "updatedAt": usage.get("updatedAt") or now(),
        "source": (session or {}).get("profile") or row.get("source") or (f"CodexBar {row.get('version', '0.84.0')}"),
        "url": URLS[provider], "errorCode": None, "identityKey": identity_key(card_id),
    }


def read_card(spec, interactive):
    card_id, provider, label = spec
    try:
        row, session = cli_result(card_id, interactive)
        return normalize(card_id, provider, label, row, session)
    except ReadError as error:
        code, message = error.code, str(error)
    except Exception:
        code, message = "read_failed", "读取失败，请稍后刷新"
    return {
        "id": card_id, "provider": provider, "label": label,
        "plan": "Google AI Pro · 你设置的套餐" if provider == "Gemini" else provider,
        "email": codex_email(card_id) if provider == "Codex" else "",
        "status": "error", "message": message, "windows": [], "details": [],
        "updatedAt": None, "source": "等待读取", "url": URLS[provider], "errorCode": code,
        "identityKey": identity_key(card_id),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--account")
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--active", action="store_true", help="read local account selection without fetching quotas")
    parser.add_argument("--discover", choices=("local", "gemini"))
    parser.add_argument("--selected", help="JSON mapping of selected account IDs to their expected identities")
    parser.add_argument("--gemini-open")
    parser.add_argument("--gemini-desktop")
    parser.add_argument("--slot", type=int)
    parser.add_argument("--page", choices=("app", "usage"), default="app")
    args = parser.parse_args()
    os.umask(0o077)
    if args.active:
        print(json.dumps(active_accounts()))
        return
    if args.discover:
        try:
            accounts = discover_accounts() if args.discover == "local" else discover_gemini_accounts()
            print(json.dumps({"accounts": accounts}, ensure_ascii=False))
        except ReadError as error:
            print(json.dumps({"message": str(error)}, ensure_ascii=False))
        except (OSError, ValueError, subprocess.SubprocessError):
            print(json.dumps({"message": "暂时无法扫描账号，请稍后重试。"}, ensure_ascii=False))
        return
    if args.gemini_desktop:
        if not re.fullmatch(r"gemini-[0-9a-f]{64}", args.gemini_desktop):
            parser.error("invalid Gemini account ID")
        try:
            request_gemini_desktop(args.gemini_desktop)
            print(json.dumps({"requested": True}))
        except ReadError as error:
            print(json.dumps({"message": str(error)}, ensure_ascii=False))
        except OSError:
            print(json.dumps({"message": "未能写入 Gemini 切换请求"}, ensure_ascii=False))
        return
    if args.gemini_open:
        if not re.fullmatch(r"gemini-[0-9a-f]{64}", args.gemini_open) or args.slot is None or not 0 <= args.slot < GEMINI_MAX_SLOTS:
            parser.error("invalid Gemini account slot")
        try:
            open_gemini_account(args.gemini_open, args.slot, args.page)
            print(json.dumps({"opened": True}))
        except ReadError as error:
            print(json.dumps({"message": str(error)}, ensure_ascii=False))
        except OSError:
            print(json.dumps({"message": "未能保存当前 Gemini 账号"}, ensure_ascii=False))
        return
    selected = json.loads(args.selected) if args.selected is not None else None
    gemini_ids = None if selected is None else {
        key for key, identity in selected.items() if key.startswith("gemini-") and key == identity
    }
    requested = [item for item in CARDS if (not args.account or item[0] == args.account) and (
        selected is None or item[0] in selected or (item[0] == "gemini" and gemini_ids)
    )]
    if not requested:
        parser.error("unknown account")
    # One native prompt at a time. Background quota reads never request Keychain UI.
    if args.interactive and (len(requested) != 1 or requested[0][0] not in ("cursor", "gemini")):
        parser.error("interactive access requires one browser-based account")
    results = {}
    gemini_cards = []
    gemini_error = None
    def read_selected(spec):
        card_id, provider, label = spec
        if selected is None:
            return read_card(spec, args.interactive)
        if identity_key(card_id) == selected[card_id]:
            card = read_card(spec, args.interactive)
            if card.get("identityKey") == selected[card_id]:
                return card
        return {"id": card_id, "provider": provider, "label": label, "email": "", "plan": provider,
                "status": "error", "message": "登录账号已变化，请在设置中重新导入",
                "windows": [], "details": [], "source": "等待读取", "url": URLS[provider],
                "errorCode": "account_changed"}

    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {
            (pool.submit(read_gemini_accounts, args.interactive, gemini_ids) if spec[0] == "gemini"
             else pool.submit(read_selected, spec)): spec[0] for spec in requested
        }
        for future in as_completed(jobs):
            if jobs[future] == "gemini":
                try:
                    gemini_cards = future.result()
                except ReadError as error:
                    gemini_error = {"code": error.code, "message": str(error)}
                except Exception:
                    gemini_error = {"code": "read_failed", "message": "Gemini 账号读取失败，请稍后刷新"}
                if not args.json:
                    payload = {"geminiCards": gemini_cards} if gemini_error is None else {"geminiError": gemini_error}
                    print(json.dumps(payload, ensure_ascii=False), flush=True)
                continue
            card = future.result()
            results[card["id"]] = card
            if not args.json:
                print(json.dumps({"card": card}, ensure_ascii=False), flush=True)
    ordered = [results[item[0]] for item in requested if item[0] in results] + gemini_cards
    if args.json:
        print(json.dumps({"cards": ordered, "geminiError": gemini_error, "updatedAt": now()}, ensure_ascii=False))
    else:
        print(json.dumps({"done": True, "updatedAt": now()}), flush=True)


if __name__ == "__main__":
    main()
