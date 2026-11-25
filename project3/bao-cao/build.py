"""In bao-cao-tien-do.html ra PDF: bìa (lề 0) và nội dung (lề chuẩn) in riêng bằng Chrome rồi ghép.

    python -X utf8 build.py        # → bao-cao-tien-do-2026-11-23.pdf
Chrome dàn cả tài liệu theo một chiều rộng trang, nên bìa tràn lề bị thu nhỏ nếu in chung với nội dung.
"""
import re
import subprocess
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
OUT = HERE / 'bao-cao-tien-do-2026-11-23.pdf'

src = (HERE / 'bao-cao-tien-do.html').read_text(encoding='utf-8')
head, body = src.split('<body>')
cover = re.search(r'<div class="cover">.*?</div></div>', body, re.S).group(0)
content = body.replace(cover, '')
parts = {
    '_bia.html': head.replace('@page {', '@page { margin: 0 !important;') + '<body>' + cover + '</body></html>',
    '_noi-dung.html': head + '<body>' + content,
}
pdfs = []
for name, html in parts.items():
    (HERE / name).write_text(html, encoding='utf-8')
    pdf = HERE / (name[:-5] + '.pdf')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', f'--print-to-pdf={pdf}',
                    (HERE / name).as_uri()], check=True, capture_output=True)
    pdfs.append(pdf)

doc = pymupdf.open()
for pdf in pdfs:
    with pymupdf.open(pdf) as part:
        doc.insert_pdf(part, to_page=0 if pdf.name == '_bia.pdf' else -1)  # bìa: chỉ trang đầu
doc.save(OUT)
print(OUT.name, doc.page_count, 'trang')
for f in [*pdfs, *(HERE / n for n in parts)]:
    f.unlink()
