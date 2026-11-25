"""Worker xử lý phiếu hỗ trợ tự động (Project 3, mục 4): phiếu mới → agent phía admin → đề xuất chờ admin duyệt.

    python worker.py                         # chạy mãi: quét phiếu "open" mỗi 20 giây, mỗi phiếu chạy agent một lần
    python worker.py --once                  # quét một lượt rồi thoát
    python worker.py --tickets TICK-105,TICK-107 --config H2   # xử lý đúng các phiếu này (kể cả đã có đề xuất), dùng cho thí nghiệm

P3_MODEL_FROM_TICKET=1: agent dùng đúng model của phiên chatbot đã tạo phiếu (không ghi thì dùng P3_RUN_MODEL).
Tự bật cùng start.cmd khi local.cmd đặt P3_WORKER=1 (cửa sổ "P3 worker"); khi hệ thống chưa lên thì chờ, không thoát.

Agent chạy dưới tài khoản admin dịch vụ p3admin (mật khẩu .p3admin-pass) trong /data/admin/p3, preset p3-h1/2/3 (role admin,
không có tool ghi). Đầu vào = phiếu thật (câu hỏi, lý do chuyển phiếu) + đoạn chat của chatbot trong phiên đã tạo phiếu.
Đề xuất lưu vào DocShield (bảng ticket_proposals) qua CLI dist/cli/tickets.js; người hỏi chưa thấy gì cho tới khi admin duyệt
ở http://127.0.0.1:3454/gate/admin/tickets.
Model: P3_PROVIDER / P3_RUN_MODEL (như eval.py). Phiếu lỗi 2 lần thì bỏ qua (worker-state.json).
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import agent
import dsh
from eval import CONFIGS, MODEL, proposal

HERE = Path(__file__).resolve().parent
CLI = '/opt/plugins/dsh-docshield/dist/cli/tickets.js'
ADMIN_WS = '/data/admin/p3'
STATE = HERE / 'worker-state.json'
MAX_FAILS = 2
MATCH_MODEL = os.environ.get('P3_MODEL_FROM_TICKET') == '1'
PROMPT = '''Phiếu hỗ trợ {code} cần xử lý.
Câu hỏi của người dùng: "{question}"
Lý do chatbot chuyển phiếu: "{reason}"
Đoạn chat giữa người dùng và chatbot trước khi tạo phiếu (chatbot có thể đã trả lời sai hoặc thiếu):
"""
{chat}
"""'''


def cli(*args, input=None):
    r = subprocess.run(['docker', 'exec', '-i', agent.CONTAINER, 'node', CLI, *args], input=json.dumps(input) if input is not None else '',
                       capture_output=True, text=True, encoding='utf-8', env=agent.ENV)
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f'tickets {args[0]}: rc={r.returncode} {(r.stderr or r.stdout)[-500:]}')
    if r.returncode or (isinstance(out, dict) and 'error' in out):
        raise RuntimeError(f"tickets {args[0]}: {out.get('error') if isinstance(out, dict) else r.stderr[-500:]}")
    return out


def chat_lines(records, result_chars=400):
    """Sự kiện của phiên DSH → các dòng: người dùng hỏi, chatbot gọi công cụ gì (kèm tham số), công cụ trả gì (rút gọn), chatbot trả lời."""
    lines = []
    texts = lambda content: ''.join(c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text').strip()
    for r in records:
        e = r.get('event') or {}
        data = e.get('data') or {}
        if e.get('type') == 'user/message':  # không có trường role
            t = texts(data.get('content') or [])
            if t:
                lines.append(f'Người dùng: {t}')
        elif e.get('type') == 'assistant/message':
            for c in (data.get('message') or {}).get('content') or []:
                if c.get('type') == 'tool-call':
                    lines.append(f"Chatbot gọi {c.get('name')}: {c.get('arguments')}")
                elif c.get('type') == 'text' and c.get('text', '').strip():
                    lines.append(f"Chatbot: {c['text'].strip()}")
        elif e.get('type') == 'tool/result':
            for c in (data.get('message') or {}).get('content') or []:
                t = texts(c.get('content') or []) if c.get('type') == 'tool-result' else ''
                if t:
                    lines.append(f"  → kết quả: {t[:result_chars]}{'…' if len(t) > result_chars else ''}")
    return lines


def chat_text(g, session_id, max_chars=6000):
    """Đoạn chat của phiên đã tạo phiếu (admin đọc được mọi phiên). session/page cần throughSeq thật (-1 trả rỗng)."""
    try:
        item = agent.session_item(g, session_id)
        page = g.api('session/page', {'request': {'address': {'kind': 'session', 'sessionId': session_id},
                                                   'throughSeq': item['projections']['asOfSeq'], 'maxMessages': 200}})
    except (StopIteration, RuntimeError) as e:
        return f'(không đọc được phiên chatbot: {str(e)[:120] or "không thấy phiên"})'
    text = '\n'.join(chat_lines(page['records']))
    return (text if len(text) <= max_chars else '…' + text[-max_chars:]) or '(phiên không có nội dung)'


def ticket_model(g, session_id):
    """(provider, model) mà phiên chatbot đã dùng khi tạo phiếu, hoặc None nếu phiên không ghi."""
    try:
        used = agent.session_item(g, session_id)['projections']['values'].get('modelSelection') or {}
    except (StopIteration, RuntimeError):
        return None
    pick = used.get('lastUsed') or used.get('next') or {}
    return (pick['provider'], pick['model']) if pick.get('provider') and pick.get('model') else None


def process(g, code, cfg, match_model=MATCH_MODEL):
    """match_model: agent dùng đúng model của phiên chatbot (P3_MODEL_FROM_TICKET=1); eval.py luôn tắt để model cố định."""
    t = cli('get', code)['ticket']
    provider, model = (ticket_model(g, t['sessionId']) if match_model else None) or (agent.PROVIDER, MODEL)
    prompt = PROMPT.format(code=code, question=t['question'], reason=t['reason'], chat=chat_text(g, t['sessionId']))
    print(f'{code}: model {provider}/{model}', flush=True)
    text, meta = agent.run_session(g, prompt, preset=CONFIGS[cfg]['preset'], model=model, provider=provider, cwd=ADMIN_WS)
    p = cli('propose', code, input={'config': cfg, 'model': model, 'sessionId': meta['session'], 'raw': text,
                                    'payload': proposal(text), 'tokens': meta['total_tokens'], 'seconds': meta['seconds']})
    return p, meta


def main(argv):
    flag = lambda name, default=None: argv[argv.index(name) + 1] if name in argv else default
    cfg = flag('--config', 'H1')
    agents = [c for c in CONFIGS if c not in ('H0', 'H0re')]
    if cfg not in agents:
        sys.exit(f'--config phải là một agent: {", ".join(agents)}')
    forced = flag('--tickets')
    interval = int(flag('--interval', '20'))
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {}
    mode = f'model của phiên chatbot tạo phiếu (dự phòng {agent.PROVIDER}/{MODEL})' if MATCH_MODEL else f'model {agent.PROVIDER}/{MODEL}'
    print(f'worker: cấu hình {cfg} (preset {CONFIGS[cfg]["preset"]}), {mode}', flush=True)
    g, waiting = None, False
    while True:
        # Bật cùng start.cmd: hệ thống (container, gate) có thể chưa lên hoặc vừa khởi động lại → chờ, không thoát.
        try:
            if g is None:
                agent.sh(f'mkdir -p {ADMIN_WS}')
                g = dsh.Gate('p3admin')
            todo = forced.split(',') if forced else [
                t['code'] for t in cli('list', '--status', 'open') if t['proposals'] == 0 and state.get(t['code'], 0) < MAX_FAILS]
            if waiting:
                print('worker: hệ thống đã sẵn sàng, đang theo dõi phiếu mới', flush=True)
            waiting = False
        except Exception as e:
            if not waiting:
                print(f'worker: chờ hệ thống ({str(e)[:120]})…', flush=True)
            g, waiting = None, True
            if forced or '--once' in argv:
                raise
            time.sleep(interval)
            continue
        for code in todo:
            print(f'{code}: đang xử lý…', flush=True)
            try:
                p, meta = process(g, code, cfg)
                print(f"{code}: đề xuất #{p['id']} ({'JSON hợp lệ' if p['payload'] else 'KHÔNG có JSON'}), {meta['seconds']}s, {meta['total_tokens']} token", flush=True)
            except Exception as e:
                state[code] = state.get(code, 0) + 1
                STATE.write_text(json.dumps(state), encoding='utf-8')
                print(f'{code}: LỖI lần {state[code]}: {str(e)[:200]}', flush=True)
                g = None  # đăng nhập lại ở vòng sau (phiên có thể hết hạn); đăng nhập lỗi không làm worker thoát
                break
        if forced or '--once' in argv:
            return
        time.sleep(interval)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    assert chat_lines([{'event': {'type': 'user/message', 'data': {'content': [{'type': 'text', 'text': 'Hỏi?'}]}}},
                       {'event': {'type': 'assistant/message', 'data': {'message': {'role': 'assistant', 'content': [
                           {'type': 'reasoning', 'text': 'x'}, {'type': 'tool-call', 'name': 'scoped_doc_search', 'arguments': '{"query":"q"}'}]}}}},
                       {'event': {'type': 'tool/result', 'data': {'message': {'content': [{'type': 'tool-result', 'content': [{'type': 'text', 'text': 'Tìm thấy 0 đoạn'}]}]}}}},
                       {'event': {'type': 'assistant/message', 'data': {'message': {'content': [{'type': 'text', 'text': 'Không tìm thấy.'}]}}}}]) == [
        'Người dùng: Hỏi?', 'Chatbot gọi scoped_doc_search: {"query":"q"}', '  → kết quả: Tìm thấy 0 đoạn', 'Chatbot: Không tìm thấy.']
    main(sys.argv[1:])
