#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 src/ 下的 ES 模块与样式打包成一个完全自包含的单文件 HTML 应用。

用法：
    python3 build.py                 打包（若存在 src/auth.json，则把固定密码校验值内嵌进 html）
    python3 build.py auth            交互设置 / 更换固定访问密码（写入 src/auth.json）
    python3 build.py --out a.html    输出到指定路径（测试用）
产物：思维导图.html  （双击即可离线运行，不需要任何服务器 / 构建工具 / 网络）
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import re
import secrets
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
JS_DIR = SRC / "js"
ENTRY = "app"
OUT = ROOT / "思维导图.html"
AUTH_FILE = SRC / "auth.json"
AUTH_ITERATIONS = 600_000
MIN_PASSWORD = 8
# 与 crypto.js 中 deriveMaterial 的派生约定保持一致：salt 加后缀区分用途
VERIFY_SUFFIX = "|yinian|verify"
ENV_PASSWORD = "YINIAN_AUTH_PASSWORD"
ENV_SALT = "YINIAN_AUTH_SALT"

IMPORT_RE = re.compile(
    r"^import\s+(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))"
    r"\s+from\s+['\"]\./([\w.-]+)\.js['\"];?[ \t]*$",
    re.M,
)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\};?[ \t]*$", re.M)
EXPORT_DECL_RE = re.compile(
    r"^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)", re.M
)


class BuildError(Exception):
    pass


def parse_module(name: str):
    path = JS_DIR / f"{name}.js"
    if not path.exists():
        raise BuildError(f"缺少模块文件：{path}")
    text = path.read_text(encoding="utf-8")
    deps: list[tuple[str, list[str]]] = []

    def take_import(m: re.Match) -> str:
        braces, star, default, mod = m.group(1), m.group(2), m.group(3), m.group(4)
        if braces is not None:
            names = [n.strip() for n in braces.replace("\n", " ").split(",") if n.strip()]
            for n in names:
                if " as " in n:
                    raise BuildError(f"{name}.js 使用了 import 重命名（{n}），构建脚本未支持")
            deps.append((mod, names))
        elif star:
            deps.append((mod, [f"*{star}"]))
        else:
            deps.append((mod, [f"default:{default}"]))
        return ""

    body = IMPORT_RE.sub(take_import, text)

    exports: list[str] = []

    def take_list(m: re.Match) -> str:
        for n in m.group(1).replace("\n", " ").split(","):
            n = n.strip()
            if not n:
                continue
            if " as " in n:
                raise BuildError(f"{name}.js 使用了 export 重命名（{n}），构建脚本未支持")
            exports.append(n)
        return ""

    body = EXPORT_LIST_RE.sub(take_list, body)

    def take_decl(m: re.Match) -> str:
        kw, ident = m.group(1), m.group(2)
        exports.append(ident)
        return f"{kw} {ident}"

    body = EXPORT_DECL_RE.sub(take_decl, body)

    leftover = [ln for ln in body.splitlines() if re.match(r"^export\b", ln)]
    if leftover:
        raise BuildError(f"{name}.js 存在构建脚本无法处理的导出：{leftover[0]}")

    return {
        "name": name,
        "deps": deps,
        "exports": exports,
        "body": body.strip("\n"),
    }


def resolve_order(entry: str):
    modules: dict[str, dict] = {}

    def visit(name: str, stack: list[str]):
        if name in modules:
            return
        if name in stack:
            raise BuildError(f"检测到循环依赖：{' -> '.join(stack + [name])}")
        mod = parse_module(name)
        for dep, _names in mod["deps"]:
            visit(dep, stack + [name])
        modules[name] = mod

    visit(entry, [])
    return modules


def check_names(modules: dict[str, dict]):
    problems = []
    for mod in modules.values():
        for dep, names in mod["deps"]:
            available = set(modules[dep]["exports"])
            for n in names:
                if n.startswith("*") or n.startswith("default:"):
                    continue
                if n not in available:
                    problems.append(f"{mod['name']}.js 从 {dep}.js 导入了不存在的 {n}")
    if problems:
        raise BuildError("模块导出不匹配：\n  " + "\n  ".join(problems))


def emit(modules: dict[str, dict]) -> str:
    chunks = []
    for name, mod in modules.items():
        head = [f"/* ================= 模块 {name} ================= */", f"const __m_{name} = (function () {{"]
        head.append("  'use strict';")
        for dep, names in mod["deps"]:
            if names and names[0].startswith("*"):
                head.append(f"  const {names[0][1:]} = __m_{dep};")
            else:
                head.append(f"  const {{ {', '.join(names)} }} = __m_{dep};")
        chunk = "\n".join(head) + "\n" + mod["body"] + "\n"
        if mod["exports"]:
            chunk += f"  return {{ {', '.join(mod['exports'])} }};\n"
        else:
            chunk += "  return {};\n"
        chunk += "})();\n"
        chunks.append(chunk)
    return "\n".join(chunks)


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def derive_verifier(password: str, salt: str, iterations: int) -> str:
    """与 crypto.js 的 PBKDF2-SHA256(password, `${salt}|yinian|verify`) 逐字节一致。"""
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        f"{salt}{VERIFY_SUFFIX}".encode("utf-8"),
        iterations,
        32,
    )
    return b64(digest)


def fingerprint_of(salt: str) -> str:
    """与 crypto.js 的 fingerprint() 一致：31 进制滚动哈希取 8 位十六进制。"""
    h = 0
    for ch in salt:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return f"{h:08x}"[:8]


def read_stored_auth():
    if not AUTH_FILE.exists():
        return None
    try:
        data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    box = data.get("pbkdf2") if isinstance(data.get("pbkdf2"), dict) else data
    if not isinstance(box, dict):
        return None
    salt = str(box.get("salt") or "").strip()
    verifier = str(box.get("verifier") or "").strip()
    if not salt or not verifier:
        return None
    try:
        iterations = int(box.get("iterations") or AUTH_ITERATIONS)
    except (TypeError, ValueError):
        iterations = AUTH_ITERATIONS
    try:
        key_version = int(data.get("keyVersion") or 1)
    except (TypeError, ValueError):
        key_version = 1
    return {
        "salt": salt,
        "verifier": verifier,
        "iterations": iterations,
        "keyVersion": max(1, key_version),
    }


def write_auth_file(password: str, salt: str | None = None, iterations: int = AUTH_ITERATIONS):
    """写入密码配置；keyVersion 每次递增，方便通知员工「请使用 v3 密钥」。"""
    salt = salt or b64(secrets.token_bytes(16))
    previous = read_stored_auth() or {}
    key_version = int(previous.get("keyVersion") or 1)
    base_verifier = derive_verifier(password, salt, iterations)
    if previous.get("verifier") and previous["verifier"] != base_verifier:
        key_version += 1
    cfg = {
        "version": 1,
        "app": "yinian",
        "keyVersion": key_version,
        "note": "固定访问密码的校验配置：只有 PBKDF2 派生值，不含明文密码。",
        "pbkdf2": {
            "algorithm": "PBKDF2-SHA256",
            "salt": salt,
            "iterations": iterations,
            "verifier": base_verifier,
        },
        "fingerprint": fingerprint_of(salt),
        "createdAt": previous.get("createdAt") or datetime.now().isoformat(timespec="seconds"),
        "rotatedAt": datetime.now().isoformat(timespec="seconds"),
    }
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return cfg


def resolve_auth_profile():
    """返回要内嵌的密码配置；None 表示未启用固定密码（访客自设）。"""
    stored = read_stored_auth()
    env_password = os.environ.get(ENV_PASSWORD)
    if env_password:
        # 环境变量方式（CI）：salt 优先取已存配置，其次 YINIAN_AUTH_SALT，最后随机
        salt = (
            (stored or {}).get("salt")
            or os.environ.get(ENV_SALT)
            or b64(secrets.token_bytes(16))
        )
        iterations = int((stored or {}).get("iterations") or AUTH_ITERATIONS)
        return {
            "salt": salt,
            "iterations": iterations,
            "verifier": derive_verifier(env_password, salt, iterations),
            "fingerprint": fingerprint_of(salt),
            "keyVersion": int((stored or {}).get("keyVersion") or 1),
            "source": "env",
        }
    if not stored:
        return None
    return {**stored, "fingerprint": fingerprint_of(stored["salt"]), "source": "file"}


def cmd_auth(args: list[str]) -> int:
    stored = read_stored_auth()
    env_password = os.environ.get(ENV_PASSWORD)
    if env_password:
        password = env_password
    else:
        if "--show" in args:
            if not stored:
                print("尚未设置固定密码。")
            else:
                print(f"固定密码已启用 · 迭代 {stored['iterations']} · 指纹 {fingerprint_of(stored['salt'])}")
            return 0
        print("设置固定访问密码（密码只用于生成校验值，不会写入任何文件）")
        password = getpass.getpass("新密码：")
        if len(password) < MIN_PASSWORD:
            print(f"密码至少 {MIN_PASSWORD} 位。", file=sys.stderr)
            return 1
        if getpass.getpass("再输一次：") != password:
            print("两次输入不一致。", file=sys.stderr)
            return 1

    if len(password) < MIN_PASSWORD:
        print(f"密码至少 {MIN_PASSWORD} 位。", file=sys.stderr)
        return 1
    if stored:
        print("提示：更换密码后，浏览器里用旧密码加密的本地数据将无法解密，请先在旧版本导出 JSON 备份。")
    cfg = write_auth_file(password, salt=(stored or {}).get("salt"))
    print(f"已写入 {AUTH_FILE.relative_to(ROOT)}")
    print(
        f"  密钥版本 v{cfg['keyVersion']} · 指纹 {cfg['fingerprint']} · "
        f"PBKDF2 迭代 {cfg['pbkdf2']['iterations']} · 不含明文密码"
    )
    print("接着运行 python3 build.py 重新生成 html，校验值会被内嵌进页面。")
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "auth":
        return cmd_auth(args[1:])

    out_path = OUT
    if "--out" in args:
        idx = args.index("--out")
        target = args[idx + 1] if idx + 1 < len(args) else ""
        if not target:
            print("构建失败：--out 需要文件路径", file=sys.stderr)
            return 1
        out_path = Path(target).expanduser().resolve()
    # --no-auth：忽略 src/auth.json，构建「访客自设密码」版本（测试夹具用）
    no_auth = "--no-auth" in args

    try:
        modules = resolve_order(ENTRY)
        check_names(modules)
        bundle = emit(modules)
    except BuildError as exc:
        print(f"构建失败：{exc}", file=sys.stderr)
        return 1

    css = (SRC / "app.css").read_text(encoding="utf-8")
    shell = (SRC / "shell.html").read_text(encoding="utf-8")
    profile = None if no_auth else resolve_auth_profile()

    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    auth_note = (
        f"固定访问密码 · 密钥 v{profile.get('keyVersion', 1)} · 指纹 {profile['fingerprint']}（只含校验值）"
        if profile
        else "未启用固定密码（访客首次进入时自设）"
    )
    banner = (
        f"<!--\n  一念 · 本地思维导图（单文件版）\n"
        f"  构建时间：{stamp}   模块数：{len(modules)}\n"
        f"  {auth_note}\n"
        f"  本文件是完整应用：不联网、不依赖服务器，双击即可使用。\n"
        f"  源码见 src/，修改后运行 python3 build.py 重新生成。\n-->"
    )

    auth_tag = (
        "<script>window.__YINIAN_AUTH__ = "
        + (json.dumps(profile, ensure_ascii=False, separators=(",", ":")) if profile else "null")
        + ";</script>"
    )
    js_tag = (
        "<script>\n"
        "/* 本脚本由 build.py 从 src/js/*.js 打包生成，请勿直接修改此文件内联代码。 */\n"
        "(function () {\n'use strict';\n"
        + bundle
        + "})();\n</script>"
    )
    css_tag = f"<style>\n{css}\n</style>"

    if "<!--INLINE_CSS-->" not in shell or "<!--INLINE_JS-->" not in shell:
        print("构建失败：src/shell.html 缺少 <!--INLINE_CSS--> 或 <!--INLINE_JS--> 占位符", file=sys.stderr)
        return 1

    html = (
        shell.replace("<!--INLINE_CSS-->", css_tag)
        .replace("<!--INLINE_JS-->", auth_tag + "\n" + js_tag)
    )
    html = html.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n" + banner, 1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    size = out_path.stat().st_size
    digest = hashlib.sha256(html.encode("utf-8")).hexdigest()[:12]

    order = " -> ".join(modules)
    print(f"已生成 {out_path.name}  ({size/1024:.1f} KB, sha256:{digest})")
    print(f"访问密码：{auth_note}")
    print(f"模块加载顺序：{order}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
