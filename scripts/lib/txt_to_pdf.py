#!/usr/bin/env python3
"""Turn a corpus text file into a real PDF, with no third-party library.

WHY NOT reportlab / weasyprint. This produces a test fixture, and a fixture
generator that needs its own pip install is a fixture generator nobody runs.
The PDF spec's minimum viable file is about eighty lines of byte-pushing, and
we are already pushing bytes for the audio.

WHY IT MUST BE A REAL PDF. `apps/backend` extracts with `unpdf` (pdf.js). The
hand-written fixtures this replaces got away with a hand-typed xref table
because they never changed length. A generated one does change length on every
corpus regeneration, so the offsets are computed here rather than typed.

ENCODING. Helvetica + WinAnsiEncoding, and the text is encoded cp1252. That
covers every accent Mexican Spanish needs -- á é í ó ú ñ ü ¿ ¡ -- plus the
em dash and middle dot the corpus uses in its header lines. Anything outside
cp1252 is transliterated rather than silently dropped, because a fixture that
quietly loses a character teaches a test to assert the wrong string.

    python3 txt_to_pdf.py IN.txt OUT.pdf
"""

import sys
import unicodedata

PAGE_W, PAGE_H = 612, 792
MARGIN_X, TOP_Y = 56, 736
FONT_SIZE, LEADING = 11, 15.5
BOTTOM_Y = 56
# Helvetica at 11pt averages ~5.1pt per character, so ~96 characters fit the
# 500pt text column. Wrapping by character count rather than by real glyph
# widths is fine here: the fixture has to be extractable, not typeset.
WRAP = 92


def to_cp1252(text: str) -> bytes:
    """cp1252 bytes, transliterating anything the codec cannot represent."""
    out = []
    for ch in text:
        try:
            ch.encode("cp1252")
            out.append(ch)
        except UnicodeEncodeError:
            # NFKD then strip combining marks: 'ẽ' -> 'e'. Characters with no
            # decomposition at all become '?', which is visible in a diff.
            folded = "".join(
                c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c)
            )
            try:
                folded.encode("cp1252")
                out.append(folded or "?")
            except UnicodeEncodeError:
                out.append("?")
    return "".join(out).encode("cp1252")


def pdf_string(text: str) -> bytes:
    """A PDF literal string: cp1252 bytes with (, ) and \\ escaped."""
    raw = to_cp1252(text)
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def wrap(line: str) -> list:
    """Greedy word wrap. An empty input line survives as one empty output line."""
    if not line.strip():
        return [""]
    out, cur = [], ""
    for word in line.split():
        candidate = f"{cur} {word}".strip()
        if len(candidate) <= WRAP:
            cur = candidate
        else:
            if cur:
                out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out


def paginate(lines: list) -> list:
    """Split wrapped lines into pages that fit between TOP_Y and BOTTOM_Y."""
    per_page = int((TOP_Y - BOTTOM_Y) / LEADING)
    pages, cur = [], []
    for line in lines:
        cur.append(line)
        if len(cur) >= per_page:
            pages.append(cur)
            cur = []
    if cur or not pages:
        pages.append(cur)
    return pages


def content_stream(page_lines: list) -> bytes:
    """BT/ET text object. One Td for the first line, then TL/T* for the rest."""
    body = [b"BT", b"/F1 %d Tf" % FONT_SIZE, b"%.1f TL" % LEADING,
            b"%d %d Td" % (MARGIN_X, TOP_Y)]
    for line in page_lines:
        # Tj then T* -- draw, then advance. An empty line draws nothing and
        # still advances, which is how paragraph breaks survive extraction.
        body.append(b"(" + pdf_string(line) + b") Tj")
        body.append(b"T*")
    body.append(b"ET")
    return b"\n".join(body)


def build(text: str) -> bytes:
    lines = []
    for raw in text.splitlines():
        lines.extend(wrap(raw))
    pages = paginate(lines)

    # Object numbering: 1 catalog, 2 pages, 3 font, then per page a page object
    # and its content stream.
    n_pages = len(pages)
    first_page_obj = 4
    page_ids = [first_page_obj + 2 * i for i in range(n_pages)]
    content_ids = [first_page_obj + 2 * i + 1 for i in range(n_pages)]

    objects = {}
    kids = b" ".join(b"%d 0 R" % pid for pid in page_ids)
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % n_pages
    objects[3] = (
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        b"/Encoding /WinAnsiEncoding >>"
    )
    for i, page_lines in enumerate(pages):
        stream = content_stream(page_lines)
        objects[page_ids[i]] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>"
            % (PAGE_W, PAGE_H, content_ids[i])
        )
        objects[content_ids[i]] = (
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
        )

    # Serialise, recording each object's byte offset for the xref table. This is
    # the part the hand-written fixtures got wrong the moment anyone edited them.
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num + objects[num] + b"\nendobj\n"

    xref_at = len(out)
    count = max(objects) + 1
    out += b"xref\n0 %d\n" % count
    out += b"0000000000 65535 f \n"
    for num in range(1, count):
        out += b"%010d 00000 n \n" % offsets[num]
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % count
    out += b"startxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        text = fh.read()
    with open(sys.argv[2], "wb") as fh:
        fh.write(build(text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
