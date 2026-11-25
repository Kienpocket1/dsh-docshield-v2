"""Client tối thiểu cho DSH qua gate (127.0.0.1:3454): đăng nhập tài khoản p3agent, gọi /api/<method>.
Mật khẩu đọc từ .p3agent-pass (không vào git, không in)."""
import http.cookiejar
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = os.environ.get('P3_GATE', 'http://127.0.0.1:3454')
USER = os.environ.get('P3_GATE_USER', 'p3agent')


class Gate:
    def __init__(self, user: str = USER):
        """user: tài khoản gate; mật khẩu trong .<user>-pass (p3agent: H0 phía user; p3admin: agent xử lý phiếu phía admin)."""
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        page = self.op.open(f'{GATE}/gate/login').read().decode()
        csrf = re.search(r'name="csrf" value="([^"]+)"', page).group(1)
        pw = (HERE / f'.{user}-pass').read_text().strip()
        body = urllib.parse.urlencode({'username': user, 'password': pw, 'csrf': csrf, 'next': '/'}).encode()
        self.op.open(urllib.request.Request(f'{GATE}/gate/login', data=body))
        if not any(c.name == 'gate_session' for c in self.jar):
            raise RuntimeError('đăng nhập gate thất bại')

    def api(self, method: str, args: dict):
        body = json.dumps({'type': 'client-request', 'rpcId': 'x', 'method': method, 'payload': {'args': args}}).encode()
        req = urllib.request.Request(f'{GATE}/api/{method}', data=body, headers={'content-type': 'application/json'})
        try:
            out = json.loads(self.op.open(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{method}: HTTP {e.code} {e.read()[:300]!r}')
        r = out.get('result', out)
        if r.get('ok') is False:
            raise RuntimeError(f'{method}: {json.dumps(r, ensure_ascii=False)[:400]}')
        return r.get('value', r)
