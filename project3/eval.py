"""Bộ câu hỏi, chạy cấu hình, chấm điểm cho Project 3.

    python eval.py check                           # kiểm tra bằng chứng có nguyên văn trong kho
    python eval.py run H0|H1|H2|H3 dev [--limit N] [--ids q01,q02]  # chạy cấu hình trên tập, ghi results/<cfg>-<split>.jsonl (chạy tiếp được)
    python eval.py grade H0 dev                    # chấm (giám khảo LLM + luật), in bảng, ghi results/<cfg>-<split>.md
    python eval.py tickets H1 dev                  # agent phía admin xử lý các phiếu THẬT mà H0 đã tạo ở tập đó (worker.process)
    python eval.py reask dev                       # đo "bồi đắp": hỏi lại chatbot các câu có phiếu đã duyệt + thêm vào kho → H0re

Tập dev/test: trường "split" trong data/questions.jsonl (chia theo nhãn, ~1/3 mỗi nhãn vào test).
Giám khảo: qwen3:8b qua Ollama (API gốc /api/chat, P3_JUDGE_BASE), không tốn tiền.
H1+ (agent xử lý phiếu, preset p3-h*, phía admin từ 23/11): chạy bằng `tickets` trên phiếu thật H0 tạo; agent trả phiếu đề xuất
JSON; giám khảo chấm trường tra_loi. Bảng H1+ có thêm chỉ số "cứu câu H0 hỏng" (kết quả cuối = agent nếu có phiếu, không thì H0).
Kết quả H1/H1v2/H2/H3/H1api trước 23/11 là bản cũ phía user (câu hỏi đưa thẳng vào prompt, không có đoạn chat chatbot).
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
QFILE = HERE / 'data' / 'questions.jsonl'
RES = HERE / 'results'
CONFIGS = {'H0': {'preset': 'docshield'}, 'H1': {'preset': 'p3-h1'}, 'H2': {'preset': 'p3-h2'}, 'H3': {'preset': 'p3-h3'},
           'H1v2': {'preset': 'p3-h1'},  # H1 sau khi sửa prompt (21/11), chạy trên câu H1 sai
           'H1api': {'preset': 'p3-h1'},  # thử H1 với model API free (P3_PROVIDER/P3_RUN_MODEL)
           'H0re': {'preset': 'docshield'}}  # H0 hỏi lại sau khi kho được bồi đắp (reask)
TICKET = 'Phiếu hỗ trợ cần xử lý. Câu hỏi của người dùng: "{q}"'
MODEL = os.environ.get('P3_RUN_MODEL', 'qwen3:8b')
JUDGE_BASE = os.environ.get('P3_JUDGE_BASE', 'http://127.0.0.1:11434')
JUDGE_MODEL = os.environ.get('P3_JUDGE_MODEL', 'qwen3:8b')
JUDGE_V = 2  # đổi khi sửa prompt/cách gọi giám khảo → grade chấm lại hết
NOT_FOUND = re.compile(r'không (tìm thấy|có (thông tin|trong|tài liệu))|chưa có (thông tin|tài liệu)|TICK-\d+|phiếu hỗ trợ', re.I)


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def questions(split=None):
    qs = [json.loads(l) for l in QFILE.read_text(encoding='utf-8').splitlines() if l.strip()]
    return [q for q in qs if split in (None, q['split'])]


def check():
    texts, bad = {}, 0
    for q in questions():
        for e in q['evidence']:
            t = texts.setdefault(e['doc'], norm((HERE / 'corpus' / 'text' / f"{e['doc']}.txt").read_text(encoding='utf-8')))
            if norm(e['quote']) not in t:
                bad += 1
                print('không khớp:', q['id'], e['doc'], e['quote'])
    qs = questions()
    by = {}
    for q in qs:
        by.setdefault((q['label'], q['split']), 0)
        by[(q['label'], q['split'])] += 1
    print(f'{len(qs)} câu, {bad} bằng chứng không khớp;', ', '.join(f'{l}/{s}={n}' for (l, s), n in sorted(by.items())))
    return bad == 0


def proposal(text):
    """Phiếu đề xuất JSON ở cuối câu trả lời của agent H1+ (None nếu không có/không hợp lệ)."""
    m = re.search(r'\{.*\}', text or '', re.S)
    try:
        return json.loads(m.group(0)) if m else None
    except json.JSONDecodeError:
        return None


def judged_text(cfg, text):
    """Phần đưa giám khảo: H0 = toàn bộ; H1+ = trường tra_loi của phiếu đề xuất."""
    p = proposal(text) if cfg not in ('H0', 'H0re') else None
    if p is None:
        return text
    return p.get('tra_loi') or 'Không tìm thấy thông tin này trong tài liệu (đề xuất bổ sung kho).'


def ticket_ids(session_id):
    """Phiếu DocShield tạo trong phiên này (đọc DB chỉ đọc trong container)."""
    js = ("const D=require('node:sqlite').DatabaseSync;const db=new D('/var/docshield/docshield.db',{readOnly:true});"
          f"console.log(JSON.stringify(db.prepare('select id from tickets where session_id=?').all({json.dumps(session_id)}).map(r=>r.id)))")
    out = subprocess.run(['docker', 'exec', 'congty-dsh-main', 'node', '-e', js], capture_output=True, text=True)
    return json.loads(out.stdout or '[]')


def run(cfg, split, limit=None, ids=None):
    import agent
    import dsh
    if cfg not in ('H0', 'H0re'):
        sys.exit('H1+ chạy phía admin trên phiếu thật: dùng "eval.py tickets <cfg> <split>"')
    RES.mkdir(exist_ok=True)
    out = RES / f'{cfg}-{split}.jsonl'
    done = {json.loads(l)['id'] for l in out.read_text(encoding='utf-8').splitlines()} if out.exists() else set()
    todo = [q for q in questions(split) if q['id'] not in done and (ids is None or q['id'] in ids)][:limit]
    g = dsh.Gate()
    for i, q in enumerate(todo, 1):
        rec = {'id': q['id'], 'cfg': cfg, 'model': MODEL}
        prompt = q['question'] if cfg == 'H0' else TICKET.format(q=q['question'])
        try:
            text, meta = agent.run_session(g, prompt, preset=CONFIGS[cfg]['preset'], model=MODEL)
            rec.update(answer=text, meta=meta, tickets=ticket_ids(meta['session']))
        except Exception as e:  # ghi lỗi để không chạy lại vô hạn; xóa dòng để chạy lại
            rec.update(error=str(e)[:500])
        with out.open('a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        print(f"[{i}/{len(todo)}] {q['id']} {rec.get('meta', {}).get('seconds', '-')}s {'LỖI ' + rec['error'][:80] if 'error' in rec else ''}", flush=True)
        g = dsh.Gate() if 'error' in rec else g  # phiên đăng nhập có thể hết hạn


def tickets(cfg, split, ids=None):
    """Agent phía admin xử lý các phiếu mà H0 tạo trên tập này; ghi results/<cfg>-<split>.jsonl như run (chạy tiếp được)."""
    import dsh
    import worker
    h0 = RES / f'H0-{split}.jsonl'
    if not h0.exists():
        sys.exit(f'chưa có {h0.name}: chạy "eval.py run H0 {split}" trước (H0 tạo phiếu thật)')
    out = RES / f'{cfg}-{split}.jsonl'
    done = {json.loads(l)['id'] for l in out.read_text(encoding='utf-8').splitlines()} if out.exists() else set()
    rows = [json.loads(l) for l in h0.read_text(encoding='utf-8').splitlines() if l.strip()]
    todo = [r for r in rows if r.get('tickets') and r['id'] not in done and (ids is None or r['id'] in ids)]
    print(f'{len(todo)} câu có phiếu cần agent {cfg} xử lý', flush=True)
    g = dsh.Gate('p3admin')
    for i, r in enumerate(todo, 1):
        code = f"TICK-{r['tickets'][-1]}"
        rec = {'id': r['id'], 'cfg': cfg, 'model': MODEL, 'ticket': code}
        try:
            p, meta = worker.process(g, code, cfg, match_model=False)
            rec.update(answer=p['raw'], meta=meta, proposal=p['id'])
        except Exception as e:
            rec.update(error=str(e)[:500])
            g = dsh.Gate('p3admin')
        with out.open('a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        print(f"[{i}/{len(todo)}] {r['id']} {code} {rec.get('meta', {}).get('seconds', '-')}s {'LỖI ' + rec['error'][:80] if 'error' in rec else ''}", flush=True)


def reask(split):
    """Bồi đắp: hỏi lại chatbot (H0re) đúng các câu có phiếu đã được duyệt và thêm vào kho; so với H0 ban đầu."""
    import worker
    rows = [json.loads(l) for l in (RES / f'H0-{split}.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
    ids = set()
    for r in rows:
        if r.get('tickets') and any(p['status'] == 'approved' and p['kbFile'] for p in worker.cli('get', f"TICK-{r['tickets'][-1]}")['proposals']):
            ids.add(r['id'])
    print(f'{len(ids)} câu có phiếu đã duyệt + thêm vào kho: {sorted(ids)}', flush=True)
    if ids:
        run('H0re', split, ids=ids)


JUDGE_PROMPT = """Bạn là giám khảo. So sánh CÂU TRẢ LỜI của chatbot với ĐÁP ÁN chuẩn cho câu hỏi về quy định của Đại học Bách khoa Hà Nội.
Chọn đúng một nhãn:
- "dung": nội dung chính khớp đáp án (số liệu, điều kiện quan trọng đúng; diễn đạt khác vẫn được).
- "mot-phan": đúng một phần, thiếu hoặc sai chi tiết quan trọng.
- "tu-choi": chatbot nói không tìm thấy / không có thông tin / chuyển phiếu hỗ trợ / hỏi lại, không đưa ra đáp án.
- "sai": đưa ra câu trả lời nhưng sai so với đáp án.
- "bia": khẳng định thông tin cụ thể (số liệu, quy định) KHÔNG có trong đáp án và trái hoặc không suy ra được từ đáp án.
Nếu đáp án là "Không có trong kho tài liệu" thì: chatbot từ chối/chuyển phiếu → "dung"; chatbot tự đưa số liệu cụ thể → "bia".
Nếu đáp án nói câu hỏi mơ hồ thì: chatbot hỏi lại hoặc trả lời đúng theo các trường hợp → "dung".

CÂU HỎI: {q}
ĐÁP ÁN: {a}
CÂU TRẢ LỜI: {r}

Chỉ trả JSON: {{"verdict": "...", "ly_do": "một câu"}}"""


def judge(q, answer):
    import urllib.request
    # API gốc Ollama + think:false: endpoint /v1 bỏ qua /no_think → qwen3 nghĩ hết max_tokens, content rỗng.
    body = {'model': JUDGE_MODEL, 'stream': False, 'think': False, 'format': 'json', 'options': {'temperature': 0},
            'messages': [{'role': 'user', 'content': JUDGE_PROMPT.format(q=q['question'], a=q['answer'], r=answer[:4000])}]}
    req = urllib.request.Request(f'{JUDGE_BASE}/api/chat', data=json.dumps(body).encode(),
                                 headers={'content-type': 'application/json'})
    for attempt in range(3):
        try:
            text = json.loads(urllib.request.urlopen(req, timeout=600).read())['message']['content']
            v = json.loads(re.search(r'\{.*\}', text, re.S).group(0))
            if v.get('verdict') in ('dung', 'mot-phan', 'tu-choi', 'sai', 'bia'):
                return v
        except Exception:
            time.sleep(3)
    return {'verdict': 'loi-cham', 'ly_do': 'giám khảo không trả JSON hợp lệ'}


def cites_source(q, answer):
    """Câu trả lời có nêu đúng file nguồn của bằng chứng không (DocShield ghi [Nguồn: tên file · vị trí])."""
    if not q['evidence']:
        return None
    a = answer.lower().replace('_', '-')
    return any(e['doc'].lower() in a for e in q['evidence'])


def grade(cfg, split):
    qs = {q['id']: q for q in questions(split)}
    path = RES / f'{cfg}-{split}.jsonl'
    rows = [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()]
    gfile = RES / f'{cfg}-{split}.graded.jsonl'
    old = {json.loads(l)['id']: json.loads(l) for l in gfile.read_text(encoding='utf-8').splitlines()} if gfile.exists() else {}
    graded = []
    for r in rows:
        q = qs[r['id']]
        o = old.get(r['id'])
        if o and o.get('answer') == r.get('answer') and o['verdict'] != 'loi-cham' and o.get('judge_v') == JUDGE_V:
            graded.append(o)
            continue
        ans = r.get('answer', '')
        v = {'verdict': 'loi-chay', 'ly_do': r['error']} if 'error' in r else judge(q, judged_text(cfg, ans))
        if cfg not in ('H0', 'H0re'):
            p = proposal(ans)
            v.update(json_ok=p is not None, chan_doan=(p or {}).get('chan_doan'), da_kiem_chung=(p or {}).get('da_kiem_chung'))
        g = {**r, 'label': q['label'], **v, 'judge_v': JUDGE_V, 'cite_ok': cites_source(q, ans) if 'error' not in r else None,
             'ticket': bool(r.get('tickets')), 'says_not_found': bool(NOT_FOUND.search(ans))}
        graded.append(g)
        print(r['id'], q['label'], g['verdict'], flush=True)
    gfile.write_text(''.join(json.dumps(g, ensure_ascii=False) + '\n' for g in graded), encoding='utf-8')
    report(cfg, split, graded)


def report(cfg, split, graded):
    labels = ['truc-tiep', 'tim-kiem-truot', 'nhieu-buoc', 'cu-mau-thuan', 'mo-ho', 'thieu']
    cols = ['dung', 'mot-phan', 'tu-choi', 'sai', 'bia', 'loi-chay', 'loi-cham']
    lines = [f'# {cfg} trên tập {split} ({len(graded)} câu, model {graded[0].get("model") if graded else "-"})', '',
             '| Nhãn | n | ' + ' | '.join(cols) + ' | trích đúng nguồn | tạo phiếu | token TB | giây TB |',
             '|---|' + '---|' * (len(cols) + 5)]
    for lab in labels + ['TỔNG']:
        rs = [g for g in graded if lab in ('TỔNG', g['label'])]
        if not rs:
            continue
        cite = [g['cite_ok'] for g in rs if g['cite_ok'] is not None]
        ok = [g for g in rs if 'meta' in g]
        tok = sum(g['meta']['total_tokens'] for g in ok) / len(ok) if ok else 0
        sec = sum(g['meta']['seconds'] for g in ok) / len(ok) if ok else 0
        lines.append(f'| {lab} | {len(rs)} | ' + ' | '.join(str(sum(g['verdict'] == c for g in rs)) for c in cols) +
                     f" | {sum(cite)}/{len(cite)} | {sum(g['ticket'] for g in rs)} | {tok:.0f} | {sec:.0f} |")
    base = RES / f'H0-{split}.graded.jsonl'
    if cfg not in ('H0', 'H0re') and base.exists():
        h0 = {g['id']: g for g in map(json.loads, base.read_text(encoding='utf-8').splitlines())}
        mine = {g['id']: g for g in graded}
        final = {i: (mine[i] if i in mine else g)['verdict'] for i, g in h0.items()}
        rescued = [i for i in mine if h0.get(i, {}).get('verdict') != 'dung' and mine[i]['verdict'] == 'dung']
        lines += ['', f"Cứu câu H0 hỏng: H0 đúng {sum(g['verdict'] == 'dung' for g in h0.values())}/{len(h0)} → sau khi agent xử lý phiếu "
                  f"{sum(v == 'dung' for v in final.values())}/{len(final)}; phiếu được cứu {len(rescued)}/{len(mine)}"
                  f"{' (' + ', '.join(sorted(rescued)) + ')' if rescued else ''}; agent làm hỏng câu H0 đã đúng: "
                  f"{sum(1 for i in mine if h0.get(i, {}).get('verdict') == 'dung' and mine[i]['verdict'] != 'dung')}"]
    if cfg == 'H0re' and base.exists():
        h0 = {g['id']: g for g in map(json.loads, base.read_text(encoding='utf-8').splitlines())}
        lines += ['', f"Bồi đắp: lần đầu H0 đúng {sum(h0[g['id']]['verdict'] == 'dung' for g in graded)}/{len(graded)} → hỏi lại sau khi kho "
                  f"được cập nhật đúng {sum(g['verdict'] == 'dung' for g in graded)}/{len(graded)}"]
    if cfg not in ('H0', 'H0re'):
        ok = [g for g in graded if 'json_ok' in g]
        lines += ['', f"Phiếu đề xuất JSON hợp lệ: {sum(g['json_ok'] for g in ok)}/{len(ok)}; chẩn đoán trùng nhãn: "
                  f"{sum(g.get('chan_doan') == g['label'] for g in ok)}/{len(ok)}; đã kiểm chứng trích dẫn: "
                  f"{sum(g.get('da_kiem_chung') is True for g in ok)}/{len(ok)}"]
    lines += ['', '## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)', '']
    lines += [f"- {g['id']} ({g['label']}, {g['verdict']}): phiếu {', '.join(map(str, g['tickets']))}" for g in graded if g.get('tickets')] or ['- (không có)']
    lines += ['', '## Câu không đúng', '']
    lines += [f"- {g['id']} ({g['label']}) {g['verdict']}: {g.get('ly_do', '')}" for g in graded if g['verdict'] != 'dung']
    md = '\n'.join(lines) + '\n'
    (RES / f'{cfg}-{split}.md').write_text(md, encoding='utf-8')
    print(md)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    assert proposal('x ```json\n{"tra_loi": null, "chan_doan": "thieu"}\n```')['chan_doan'] == 'thieu'
    assert judged_text('H1', '{"tra_loi": "50 giờ"}') == '50 giờ' and judged_text('H0', 'a') == 'a'
    cmd, *args = sys.argv[1:] or ['check']
    if cmd == 'check':
        sys.exit(0 if check() else 1)
    limit = int(args[args.index('--limit') + 1]) if '--limit' in args else None
    ids = set(args[args.index('--ids') + 1].split(',')) if '--ids' in args else None
    {'run': lambda: run(args[0], args[1], limit, ids), 'grade': lambda: grade(args[0], args[1]),
     'tickets': lambda: tickets(args[0], args[1], ids), 'reask': lambda: reask(args[0])}[cmd]()
