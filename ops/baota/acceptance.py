from contextlib import contextmanager
import hashlib
from http.cookies import SimpleCookie
import json
import re
import uuid

from doctor import check, get, private_input, request


IMAGE_BYTES = 20_000_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def fixture_bytes(path):
    check(path.is_absolute() and path.is_file() and not path.is_symlink(), "需要提供普通文件形式的 20 MB PNG 测试图")
    with path.open("rb") as stream:
        image = stream.read(IMAGE_BYTES + 1)
    check(len(image) == IMAGE_BYTES and image.startswith(PNG_SIGNATURE), "测试图须为 20,000,000 字节的 PNG")
    return image


def json_response(response):
    payload = response.read(32_769)
    check(len(payload) <= 32_768, "验收接口响应超过限制")
    return json.loads(payload)


def account_file(path, origin):
    account = private_input(path, origin, {"identifier", "password", "cookieName"})
    check(0 < len(account["identifier"].strip()) <= 200 and 0 < len(account["password"]) <= 4096
          and re.fullmatch(r"[A-Za-z0-9_.-]+", account["cookieName"]), "专用验收账号配置不完整")
    return account


def login(origin, account):
    body = json.dumps({"identifier": account["identifier"], "password": account["password"], "portal": "designer"}).encode()
    with request(origin, "/api/auth/login", {"Content-Type": "application/json"}, method="POST", body=body) as response:
        payload = json_response(response)
        cookies = SimpleCookie()
        for entry in response.headers.get_all("Set-Cookie", []):
            cookies.load(entry)
        cookie = cookies.get(account["cookieName"])
        user = payload.get("user") if isinstance(payload, dict) else None
        check(cookie is not None and isinstance(user, dict), "登录未取得验收会话")
        check(re.fullmatch(r"[A-Za-z0-9_.%~-]{8,4096}", cookie.value), "会话 Cookie 的格式异常")
        return {"Cookie": cookie.key + "=" + cookie.value}, user


@contextmanager
def authenticated_probe(origin, account):
    headers, user = login(origin, account)
    try:
        actor = user.get("id", "")
        check(user.get("role") == "designer" and not user.get("mustChangePassword") and not user.get("isGuest")
              and isinstance(actor, str) and re.fullmatch(r"[0-9a-fA-F-]{36}", actor), "验收必须使用已完成首次改密的专用设计师账号")
        yield {**headers, "X-Canvas-Owner-Id": actor}
    finally:
        with request(origin, "/api/auth/logout", headers, method="POST", status=204):
            pass


def image_roundtrip(origin, headers, image):
    name = "baota-deployment-probe-" + uuid.uuid4().hex + ".png"
    body = json.dumps({"filename": name, "mimeType": "image/png", "byteSize": len(image), "kind": "image", "metadata": {}}).encode()
    with request(origin, "/api/assets/upload-request", {**headers, "Content-Type": "application/json"}, method="POST", body=body, status=201) as response:
        payload = json_response(response)
    asset = payload.get("assetId", "") if isinstance(payload, dict) else ""
    check(isinstance(asset, str) and re.fullmatch(r"[0-9a-fA-F-]{36}", asset), "素材接口未返回有效的新资产 ID")
    upload_path = f"/api/assets/{asset}/upload"
    check(payload.get("uploadUrl") == upload_path and not payload.get("reused"), "验收只能写入本次创建的素材上传地址")
    with request(origin, upload_path, {**headers, "Content-Type": "image/png"}, timeout=90, method="PUT", body=image, status=204):
        pass
    downloaded, info = get(origin, f"/api/assets/{asset}/content", headers, limit=len(image), timeout=90)
    digest = hashlib.sha256(image).hexdigest()
    check(info.get_content_type() == "image/png" and len(downloaded) == len(image) and hashlib.sha256(downloaded).hexdigest() == digest,
          "下载的原图类型、字节数或 SHA-256 与源文件不一致")
    return {"assetId": asset, "filename": name, "bytes": len(image), "sha256": digest}
