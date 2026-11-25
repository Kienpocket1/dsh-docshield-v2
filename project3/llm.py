"""Gọi model qua 9Router (OpenAI-compatible, 127.0.0.1:20128) — cùng router mà DSH dùng.

Khóa: biến P3_LLM_KEY, nếu không có thì đọc NIEN_ROUTER_API_KEY trong volume DSH congty-home
(.credentials.yaml) qua docker. Khóa không bao giờ được in hay ghi ra đĩa.
"""
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request

BASE = os.environ.get('P3_LLM_BASE', 'http://127.0.0.1:20128/v1')
# ds/* (DeepSeek) và ollama/* hết hạn mức trên 9Router lúc viết (402); đổi bằng P3_MODEL khi nạp lại.
MODEL = os.environ.get('P3_MODEL', 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')
JUDGE_MODEL = os.environ.get('P3_JUDGE_MODEL', 'gemini/gemini-3.5-flash-lite')
_key = None


def key():
    global _key
    if _key is None:
        _key = os.environ.get('P3_LLM_KEY') or ''
        if not _key:
            out = subprocess.run(['docker', 'run', '--rm', '-v', 'congty-home:/h:ro', 'alpine', 'cat', '/h/.credentials.yaml'],
                                 capture_output=True, text=True, env={**os.environ, 'MSYS_NO_PATHCONV': '1'}).stdout
            m = re.search(r'^\s*NIEN_ROUTER_API_KEY:\s*["\']?([^"\'\s]+)', out, re.M)
            if not m:
                raise RuntimeError('Không tìm thấy khóa 9Router: đặt P3_LLM_KEY')
            _key = m.group(1)
    return _key


def chat(messages, model=MODEL, max_tokens=4000, temperature=0.2, json_mode=False, retries=3):
    """→ (text, usage{prompt_tokens, completion_tokens, total_tokens}, seconds)."""
    body = {'model': model, 'messages': messages, 'max_tokens': max_tokens, 'temperature': temperature,
            'stream': False}  # 9Router mặc định stream với một số model
    if json_mode:
        body['response_format'] = {'type': 'json_object'}
    req = urllib.request.Request(f'{BASE}/chat/completions', data=json.dumps(body).encode(), method='POST',
                                 headers={'content-type': 'application/json', 'authorization': f'Bearer {key()}'})
    for attempt in range(retries):
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
            if 'error' in d:
                raise RuntimeError(str(d['error'])[:300])
            return d['choices'][0]['message'].get('content') or '', d.get('usage') or {}, time.time() - t0
        except (urllib.error.URLError, RuntimeError, TimeoutError) as e:
            if attempt == retries - 1:
                raise RuntimeError(f'LLM lỗi sau {retries} lần: {getattr(e, "read", lambda: b"")()[:300] or e}') from None
            time.sleep(5 * (attempt + 1))


def parse_json(text):
    """Lấy object JSON đầu tiên trong câu trả lời (model hay bọc trong ```json)."""
    m = re.search(r'\{.*\}', text, re.S)
    if not m:
        raise ValueError('không có JSON trong câu trả lời')
    return json.loads(m.group(0))
