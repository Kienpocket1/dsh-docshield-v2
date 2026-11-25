"""Chạy một phiên DSH tự động qua gate (127.0.0.1:3454, tài khoản p3agent) và lấy kết quả.

    import dsh, agent
    g = dsh.Gate()
    agent.put({'a.pdf': Path('corpus/hust/a.pdf')}, f'{agent.WS}/docs')   # chép file vào workspace
    text, meta = agent.run_session(g, 'Câu hỏi...', preset='docshield-harness', model='qwen3:8b')

meta: token, số bước, thời gian (từ projections của phiên DSH). Chạy tuần tự.
"""
import io
import json
import os
import subprocess
import tarfile
import time
import uuid

CONTAINER = 'congty-dsh-main'
WS = '/data/users/p3agent/p3'
PROVIDER = os.environ.get('P3_PROVIDER', 'ollama-local')
ENV = {**os.environ, 'MSYS_NO_PATHCONV': '1'}


def sh(cmd, input=None):
    # chạy với user node (chủ /data/users); root trong container không vào được /data/users
    r = subprocess.run(['docker', 'exec', '-i', CONTAINER, 'sh', '-c', cmd], input=input, capture_output=True, env=ENV)
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors='replace')[:500])
    return r.stdout.decode(errors='replace')


def put(files: dict, dest: str):
    """files = {tên trong dest: Path}; giải nén tar qua stdin để file thuộc user node (docker cp tạo file của root)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        for name, src in files.items():
            t.add(src, arcname=name)
    sh(f'mkdir -p {dest} && tar -x -C {dest}', input=buf.getvalue())


def session_item(g, sid):
    return next(x for x in g.api('session/list', {'_request': {}})['items'] if x['sessionId'] == sid)


def last_assistant_text(g, sid, seq) -> str:
    page = g.api('session/page', {'request': {'address': {'kind': 'session', 'sessionId': sid}, 'throughSeq': seq, 'maxMessages': 200}})
    texts = []

    def walk(n):
        if isinstance(n, dict):
            if n.get('role') == 'assistant' and isinstance(n.get('content'), list):
                t = ''.join(c.get('text', '') for c in n['content'] if isinstance(c, dict) and c.get('type') == 'text')
                if t.strip():
                    texts.append(t)
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk(page)
    ends = [r['event']['data'] for r in page['records'] if r.get('event', {}).get('type') == 'turn/end']
    if ends and ends[-1].get('reason', {}).get('kind') == 'error':
        raise RuntimeError('phiên lỗi: ' + json.dumps(ends[-1]['reason'], ensure_ascii=False)[:300])
    return texts[-1] if texts else ''


def run_session(g, prompt: str, preset: str, model: str, provider: str = PROVIDER, cwd: str = WS, timeout_s=1800):
    """Tạo phiên, gửi prompt, chờ xong. Trả (câu trả lời cuối, meta). Lỗi/quá giờ → raise."""
    t0 = time.time()
    sid = g.api('session/create', {'request': {'cwd': cwd, 'agentPreset': preset}})['sessionId']
    # Gate đổi lặng lẽ preset chưa cấp về preset mặc định → kết quả thí nghiệm sai mà không ai biết; dừng ngay.
    got = session_item(g, sid)['projections']['values'].get('agentPreset')
    if got != preset:
        raise RuntimeError(f'phiên chạy preset {got!r} thay vì {preset!r} (tài khoản chưa được cấp preset này?)')
    g.api('session/selectModel', {'request': {'sessionId': sid, 'provider': provider, 'model': model}})
    g.api('session/prompt', {'request': {'requestId': str(uuid.uuid4()), 'sessionId': sid, 'mode': 'queue',
                                         'content': [{'type': 'text', 'text': prompt}]}})
    while True:
        time.sleep(5)
        it = session_item(g, sid)
        v = it['projections']['values']
        if not it['running'] and v['sessionStats']['turns'] > 0:
            break
        if time.time() - t0 > timeout_s:
            g.api('session/cancel', {'request': {'sessionId': sid}})
            raise TimeoutError(f'quá {timeout_s}s')
    u, st = v['tokenUsage'], v['sessionStats']
    meta = {'session': sid, 'preset': preset, 'model': model,
            'prompt_tokens': u['uncachedInputTokens'] + u['cacheReadTokens'] + u['cacheWriteTokens'],
            'completion_tokens': u['outputTokens'], 'llm_calls': st['steps'], 'llm_ms': st['llmMs'], 'tool_ms': st['toolMs']}
    meta['total_tokens'] = meta['prompt_tokens'] + meta['completion_tokens']
    text = last_assistant_text(g, sid, it['projections']['asOfSeq'])
    meta['seconds'] = round(time.time() - t0, 1)
    return text, meta
