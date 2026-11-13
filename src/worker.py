#!/usr/bin/env python3
"""Account-scoped quota reads using the pinned CodexBar CLI."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import tempfile

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
]
URLS = {
    "Codex": "https://chatgpt.com/codex/settings/usage",
    "Kiro": "https://app.kiro.dev/account/usage",
    "Cursor": "https://cursor.com/dashboard",
    "Claude": "https://claude.ai/settings/usage",
    "GitHub Copilot": "https://github.com/settings/copilot",
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
    if card_id.startswith("codex-profile-"):
        return BOARD_DATA / "Profiles/Codex" / card_id.removeprefix("codex-profile-")
    return USER_HOME / (".codex" if card_id == "codex-default" else "." + card_id)


def kiro_home(card_id):
    return USER_HOME if card_id == "kiro-default" else KIRO_ACCOUNTS / card_id.removeprefix("kiro-")


def cursor_home(card_id):
    if card_id == "cursor":
        return USER_HOME / "Library/Application Support/Cursor"
    return BOARD_DATA / "Profiles/Cursor" / card_id.removeprefix("cursor-profile-")


def claude_home(card_id):
    if card_id == "claude-default":
        return USER_HOME / ".claude"
    return BOARD_DATA / "Profiles/Claude" / card_id.removeprefix("claude-profile-")


def profile_specs():
    specs = CARDS + [("claude-default", "Claude", "Claude")]
    for prefix, provider, directory, pattern in (
        ("codex-profile-", "Codex", BOARD_DATA / "Profiles/Codex", r"[0-9a-f]{32,64}"),
        ("kiro-", "Kiro", KIRO_ACCOUNTS, r"profile-[0-9a-f]{32}"),
        ("claude-profile-", "Claude", BOARD_DATA / "Profiles/Claude", r"[0-9a-f]{32}"),
        ("cursor-profile-", "Cursor", BOARD_DATA / "Profiles/Cursor", r"[0-9a-f]{32}"),
    ):
        if directory.is_dir():
            specs += [(prefix + item.name, provider, provider + " 账号")
                      for item in sorted(directory.iterdir()) if item.is_dir() and re.fullmatch(pattern, item.name)]
    return specs


def gh_environment():
    env = environment("")
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"):
        env.pop(key, None)
    env["GH_PROMPT_DISABLED"] = "1"
    return env


def github_accounts():
    try:
        status, output = run(["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"],
                             gh_environment(), timeout=9)
        if status != 0:
            return []
        return [row for row in json.loads(output).get("hosts", {}).get("github.com", [])
                if valid_github_login(row.get("login", ""))]
    except (OSError, ReadError, ValueError, AttributeError):
        return []


def valid_github_login(login):
    return isinstance(login, str) and re.fullmatch(r"[A-Za-z0-9-]{1,39}", login) is not None


def copilot_id(login):
    return "copilot-" + login.casefold()


def claude_status(card_id):
    try:
        status, output = run(["claude", "auth", "status"], environment(card_id), timeout=7)
        result = json.loads(output)
        if status == 0 and result.get("loggedIn") is True and result.get("authMethod") == "claude.ai":
            return result
    except (OSError, ReadError, ValueError, AttributeError):
        pass
    return {}


def email_address(value):
    return value.strip() if isinstance(value, str) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value.strip()) else ""


def claude_email(status):
    return email_address(status.get("email")) or email_address(status.get("emailAddress"))



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


def active_accounts(specs=None, providers=()):
    specs = profile_specs() if specs is None else specs
    active = {}
    current_codex = claims(USER_HOME / ".codex/auth.json")
    if current_codex:
        active["Codex"] = next((card_id for card_id, provider, _ in specs
                               if provider == "Codex" and card_id != "codex-default"
                               and claims(codex_home(card_id) / "auth.json") == current_codex), "codex-default")

    try:
        last_kiro = (KIRO_ACCOUNTS / "active-account").read_text().strip()
    except OSError:
        last_kiro = ""
    if any(card_id == "kiro-" + last_kiro for card_id, _, _ in specs) and kiro_signed_in(KIRO_ACCOUNTS / last_kiro):
        active["Kiro"] = "kiro-" + last_kiro
    elif kiro_signed_in(USER_HOME):
        current_kiro = kiro_identity(USER_HOME)
        active["Kiro"] = next((card_id for card_id, provider, _ in specs
                               if provider == "Kiro" and card_id != "kiro-default" and current_kiro
                               and kiro_identity(kiro_home(card_id)) == current_kiro), "kiro-default")
    try:
        chosen_cursor = (BOARD_DATA / "active-cursor-account").read_text().strip()
    except OSError:
        chosen_cursor = ""
    if any(card_id == chosen_cursor for card_id, _, _ in specs) and cursor_email(chosen_cursor):
        active["Cursor"] = chosen_cursor
    elif cursor_email():
        active["Cursor"] = "cursor"
    if "Claude" in providers:
        try:
            chosen = (BOARD_DATA / "active-claude-account").read_text().strip()
        except OSError:
            chosen = ""
        if any(card_id == chosen for card_id, _, _ in specs) and claude_status(chosen):
            active["Claude"] = chosen
        elif claude_status("claude-default"):
            active["Claude"] = "claude-default"
    if "GitHub Copilot" in providers:
        accounts = github_accounts()
        current = next((row["login"] for row in accounts if row.get("active") and row.get("state") == "success"), None)
        if current:
            active["GitHub Copilot"] = copilot_id(current)
    return active


def environment(card_id):
    env = dict(os.environ)
    node_bins = sorted((USER_HOME / ".nvm/versions/node").glob("*/bin"),
                       key=lambda path: tuple(int(n) for n in re.findall(r"\d+", path.parent.name)), reverse=True)
    env["PATH"] = os.pathsep.join([str(USER_HOME / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
                                  *map(str, node_bins), env.get("PATH", os.defpath)])
    for key in ("OPENAI_API_KEY", "KIRO_API_KEY", "CODEX_HOME", "KIRO_HOME", "KIRO_DATA_DIR",
                "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
                "CODEXBAR_CLAUDE_OAUTH_TOKEN", "ANTHROPIC_ADMIN_KEY", "CLAUDE_CONFIG_DIR",
                "CLAUDE_SECURESTORAGE_CONFIG_DIR", "COPILOT_API_TOKEN"):
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
    elif card_id.startswith("claude-profile-"):
        env["CLAUDE_CONFIG_DIR"] = str(claude_home(card_id))
        env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = env["CLAUDE_CONFIG_DIR"]
    return env


def cursor_email(card_id="cursor"):
    path = cursor_home(card_id) / "User/globalStorage/state.vscdb"
    if not path.is_file():
        return ""
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.4) as db:
            rows = dict(db.execute("SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/cachedEmail', 'cursorAuth/accessToken')"))
        email = rows.get("cursorAuth/cachedEmail")
        if isinstance(email, bytes):
            email = email.decode("utf-8", errors="ignore").replace("\x00", "")
        return email_address(email) if rows.get("cursorAuth/accessToken") else ""
    except sqlite3.Error:
        return ""


def identity_key(card_id):
    try:
        if card_id.startswith("codex-"):
            value = claims(codex_home(card_id) / "auth.json")
        elif card_id.startswith("kiro-"):
            value = kiro_identity(kiro_home(card_id))
        elif card_id == "cursor" or card_id.startswith("cursor-profile-"):
            value = cursor_email(card_id)
        elif card_id.startswith("claude-"):
            status = claude_status(card_id)
            email = claude_email(status)
            value = (email.casefold(), status.get("orgId", status.get("organizationId"))) if email else None
        elif card_id.startswith("copilot-") and valid_github_login(card_id[8:]):
            value = card_id[8:].casefold()
        else:
            return None
        return hashlib.sha256(json.dumps(value).encode()).hexdigest() if value else None
    except (OSError, sqlite3.Error, ValueError):
        return None


def github_email(card_id):
    env = github_token_environment(card_id)
    try:
        status, output = run(["gh", "api", "--hostname", "github.com", "user/emails"], env, timeout=9)
        if status == 0:
            return next((email_address(row.get("email")) for row in json.loads(output)
                         if row.get("primary") and row.get("verified")), "")
    except (OSError, ReadError, ValueError, AttributeError):
        pass
    return ""


def github_token_environment(card_id):
    env = gh_environment()
    status, token = run(["gh", "auth", "token", "--hostname", "github.com", "--user", card_id[8:]], env, timeout=8)
    if status != 0 or not token.strip():
        raise ReadError("not_logged_in", "请在 GitHub 完成授权后重新扫描。")
    env["GH_TOKEN"] = token.strip()
    return env


def kiro_email(card_id):
    try:
        status, output = run(["kiro-cli", "whoami", "--format", "json"], environment(card_id), timeout=6)
        if status == 0:
            email = email_address(json.loads(output).get("email"))
            if email:
                return email
    except (OSError, ReadError, ValueError, AttributeError):
        pass
    try:
        row, _ = request_kiro(card_id, retry=False)
        return email_address(row["usage"]["identity"].get("accountEmail"))
    except (ReadError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        return ""


def discover_accounts(providers=None):
    """Discover provider logins and resolve account identity before quota import."""
    specs = profile_specs()
    providers = set(URLS) if providers is None else providers
    github = github_accounts() if "GitHub Copilot" in providers else []
    specs += [(copilot_id(row["login"]), "GitHub Copilot", row["login"]) for row in github
              if row.get("state") == "success"]
    # Only duplicated local profiles need an active-account tie break.
    active = active_accounts(specs)
    unique = {}

    def discover(spec):
        card_id, provider, label = spec
        if provider == "Kiro" and not kiro_signed_in(kiro_home(card_id)):
            return None
        if provider == "Claude":
            status = claude_status(card_id)
            email = claude_email(status)
            if not email:
                return None
            key = (email.casefold(), status.get("orgId", status.get("organizationId")))
            identity = hashlib.sha256(json.dumps(key).encode()).hexdigest()
        else:
            identity = identity_key(card_id)
            if not identity:
                return None
            if provider == "Codex":
                email = codex_email(card_id)
            elif provider == "Cursor":
                email = cursor_email(card_id)
            elif provider == "Kiro":
                email = kiro_email(card_id)
            else:
                try:
                    email = github_email(card_id)
                except (OSError, ReadError):
                    email = ""
        return {"id": card_id, "provider": provider, "label": label,
                "email": email, "identityKey": identity}

    with ThreadPoolExecutor(max_workers=5) as pool:
        for account in pool.map(discover, [spec for spec in specs if providers is None or spec[1] in providers]):
            if account is None:
                continue
            key = (account["provider"], account["identityKey"])
            existing = unique.get(key)
            current_id = active.get(account["provider"])
            if existing is None or account["id"] == current_id:
                unique[key] = account
            if existing and not unique[key]["email"]:
                unique[key]["email"] = account["email"] or existing["email"]
    return list(unique.values())


def auth_session(provider, interactive, profile=None):
    access_file = USER_HOME / "Library/Application Support/QuotaBoard/access-enabled.json"
    try:
        enabled = json.loads(access_file.read_bytes())
    except (OSError, ValueError):
        enabled = {}
    if not interactive and not enabled.get(provider):
        raise ReadError("keychain_required", "点「授权读取」，允许系统提供本机登录信息")
    command = [str(VENDOR / "QuotaAccess"), provider]
    if profile is not None:
        command.append(str(profile))
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
    if provider == "claude":
        # The CLI owns this profile's login and refresh. Pass only its current token to the usage reader.
        profile = claude_home(card_id) if card_id != "claude-default" else None
        session = auth_session("claude", interactive, profile)
        env["CODEXBAR_CLAUDE_OAUTH_TOKEN"] = session["token"]
        if session.get("scopes"):
            env["CODEXBAR_CLAUDE_OAUTH_SCOPES"] = ",".join(session["scopes"])
        session = None
        source = "oauth"
    elif provider == "copilot":
        env["COPILOT_API_TOKEN"] = github_token_environment(card_id)["GH_TOKEN"]
        source = "api"
    elif provider == "cursor":
        session = auth_session(provider, interactive, cursor_home(card_id) if card_id != "cursor" else None)
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
        if provider == "GitHub Copilot":
            title = "Premium · Monthly" if key == "primary" else "Chat · Monthly"
            minutes = minutes or 43200
        elif minutes == 300:
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
    email = email_address(usage.get("accountEmail")) or email_address(identity.get("accountEmail")) \
        or email_address((session or {}).get("email"))
    if provider == "Codex" and not email:
        email = codex_email(card_id)
    if provider == "Cursor" and email and email.casefold() != cursor_email(card_id).casefold():
        raise ReadError("account_changed", "Cursor 登录已变化，请重新扫描。")
    if provider == "Claude":
        expected = claude_email(claude_status(card_id))
        if not expected or (email and email.casefold() != expected.casefold()):
            raise ReadError("account_changed", "Claude 额度所对应的账号无法核对，请重新登录。")
        email = expected
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
        "plan": provider,
        "email": codex_email(card_id) if provider == "Codex" else "",
        "status": "error", "message": message, "windows": [], "details": [],
        "updatedAt": None, "source": "等待读取", "url": URLS[provider], "errorCode": code,
        "identityKey": identity_key(card_id),
    }


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def login(provider, profile, check=False):
    env = environment("")
    if not re.fullmatch(r"[0-9a-f]{32}", profile):
        raise ReadError("invalid_profile", "无法建立登录配置。")
    if provider == "Codex":
        home = codex_home("codex-profile-" + profile)
        env["CODEX_HOME"] = str(home)
        command = ["codex", "login", "-c", 'cli_auth_credentials_store="file"']
    elif provider == "Kiro":
        home = kiro_home("kiro-profile-" + profile)
        env["HOME"] = str(home)
        env["KIRO_HOME"] = str(home / ".kiro")
        command = ["kiro-cli", "login"]
    elif provider == "Claude":
        home = claude_home("claude-profile-" + profile)
        env["CLAUDE_CONFIG_DIR"] = str(home)
        env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = str(home)
        command = ["claude", "auth", "login", "--claudeai"]
    elif provider == "GitHub Copilot":
        env = gh_environment()
        env.pop("GH_PROMPT_DISABLED", None)
        command = ["gh", "auth", "login", "--hostname", "github.com", "--web", "--scopes", "user:email", "--skip-ssh-key"]
    else:
        raise ReadError("invalid_provider", "请在 Cursor 桌面应用中登录。")
    if not shutil.which(command[0], path=env["PATH"]):
        raise ReadError("cli_missing", f"请先安装 {command[0]}，再回到额度看板添加账号。")
    if check:
        return 0
    if provider != "GitHub Copilot":
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
    return subprocess.call(command, env=env)


def switch_account(card_id, expected):
    specs = profile_specs()
    provider = next((p for i, p, _ in specs if i == card_id), None)
    if provider is None and card_id.startswith("copilot-") and valid_github_login(card_id[8:]):
        provider = "GitHub Copilot"
    if provider is None or identity_key(card_id) != expected:
        raise ReadError("account_changed", "登录账号已变化，请在设置中重新导入。")
    if provider == "Codex":
        BOARD_DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (BOARD_DATA / ".codex-switch.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return switch_codex(card_id, expected, specs)
    if provider == "GitHub Copilot":
        status, _ = run(["gh", "auth", "switch", "--hostname", "github.com", "--user", card_id[8:]],
                        gh_environment(), timeout=10)
        if status != 0:
            raise ReadError("switch_failed", "GitHub 切换失败，请重新授权此账号。")
        return {}
    if provider == "Cursor":
        atomic_write(BOARD_DATA / "active-cursor-account", card_id.encode())
        return {}
    if provider in ("Kiro", "Claude"):
        if provider == "Kiro":
            if not kiro_signed_in(kiro_home(card_id)):
                raise ReadError("not_logged_in", "请先重新登录此 Kiro 账号。")
            marker = KIRO_ACCOUNTS / "active-account"
            selected = "" if card_id == "kiro-default" else card_id.removeprefix("kiro-")
            command = ["kiro-cli", "chat"]
        else:
            marker = BOARD_DATA / "active-claude-account"
            selected = card_id
            command = ["claude"]
        if not shutil.which(command[0], path=environment(card_id)["PATH"]):
            raise ReadError("cli_missing", f"请先安装 {command[0]}。")
        # Swift opens this exact profile in a new Terminal session.
        atomic_write(marker, selected.encode())
        return {"launch": True}
    raise ReadError("switch_unavailable", "请在 Cursor 桌面应用中切换登录。")


def switch_codex(card_id, expected, specs):
    default = codex_home("codex-default") / "auth.json"
    target = codex_home(card_id) / "auth.json"
    target_data = target.read_bytes()
    if identity_key(card_id) != expected or target.read_bytes() != target_data:
        raise ReadError("account_changed", "目标登录已变化，请重新扫描。")
    try:
        current_data = default.read_bytes()
    except FileNotFoundError:
        current_data = None
    current = identity_key("codex-default")
    if current == expected:
        return {}
    if current is None and current_data is not None:
        raise ReadError("switch_failed", "现有 Codex 登录格式无法核对，请先在 Codex 里退出或重新登录。")
    result = {}
    if current is not None and current_data is not None:
        saved_id = next((other for other, provider, _ in specs if provider == "Codex"
                         and other != "codex-default" and identity_key(other) == current),
                        "codex-profile-" + current)
        atomic_write(codex_home(saved_id) / "auth.json", current_data)
        result["previousID"] = saved_id
        result["previousIdentity"] = current
    if current_data is not None and default.read_bytes() != current_data:
        raise ReadError("account_changed", "当前 Codex 登录在切换时变化，请重试。")
    if current_data is None and default.exists():
        raise ReadError("account_changed", "当前 Codex 登录在切换时变化，请重试。")
    atomic_write(default, target_data)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--account")
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--active", nargs="*", metavar="PROVIDER")
    parser.add_argument("--discover", nargs="*", metavar="PROVIDER")
    parser.add_argument("--selected", help="JSON mapping of selected account IDs to their expected identities")
    parser.add_argument("--login", nargs=2, metavar=("PROVIDER", "PROFILE"))
    parser.add_argument("--switch", nargs=2, metavar=("ACCOUNT", "IDENTITY"))
    parser.add_argument("--launch")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.active is not None:
        print(json.dumps(active_accounts(providers=args.active)))
        return
    if args.discover is not None:
        try:
            providers = [name for name in args.discover if name in URLS]
            print(json.dumps({"accounts": discover_accounts(providers or None)}, ensure_ascii=False))
        except (OSError, ValueError, subprocess.SubprocessError):
            print(json.dumps({"message": "暂时无法扫描账号，请稍后重试。"}, ensure_ascii=False))
        return
    if args.login or args.launch:
        try:
            if args.login:
                raise SystemExit(login(*args.login, check=args.check))
            spec = next((spec for spec in profile_specs() if spec[0] == args.launch), None)
            commands = {"Kiro": ["kiro-cli", "chat"], "Claude": ["claude"]}
            if spec is None or spec[1] not in commands:
                raise ReadError("invalid_profile", "未找到此账号。")
            raise SystemExit(subprocess.call(commands[spec[1]], env=environment(args.launch)))
        except (ReadError, OSError) as error:
            print(str(error) if isinstance(error, ReadError) else "无法启动登录，请检查客户端是否已安装。")
            raise SystemExit(1) from None
    if args.switch:
        try:
            print(json.dumps({"switched": True, **switch_account(*args.switch)}, ensure_ascii=False))
        except ReadError as error:
            print(json.dumps({"message": str(error)}, ensure_ascii=False))
        except (OSError, ValueError, subprocess.SubprocessError):
            print(json.dumps({"message": "切换失败，请检查登录状态后重试。"}, ensure_ascii=False))
        return
    selected = json.loads(args.selected) if args.selected is not None else None
    specs = profile_specs()
    specs += [(card_id, "GitHub Copilot", card_id[8:]) for card_id in (selected or {})
              if card_id.startswith("copilot-") and valid_github_login(card_id[8:])]
    requested = [spec for spec in specs if (not args.account or spec[0] == args.account)
                 and (selected is None or spec[0] in selected)]
    if not requested:
        parser.error("unknown account")
    if args.interactive and (len(requested) != 1 or requested[0][1] not in ("Cursor", "Claude")):
        parser.error("interactive access requires a Cursor or Claude account")
    results = {}
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
        jobs = [pool.submit(read_selected, spec) for spec in requested]
        for future in as_completed(jobs):
            card = future.result()
            results[card["id"]] = card
            if not args.json:
                print(json.dumps({"card": card}, ensure_ascii=False), flush=True)
    ordered = [results[item[0]] for item in requested if item[0] in results]
    if args.json:
        print(json.dumps({"cards": ordered, "updatedAt": now()}, ensure_ascii=False))
    else:
        print(json.dumps({"done": True, "updatedAt": now()}), flush=True)


if __name__ == "__main__":
    main()
