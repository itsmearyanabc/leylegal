"""
Parse the Gazette PDFs of the BNS, BNSS and BSA (Ministry of Home Affairs copies)
into one record per section: number, title, text, chapter.

Layout facts this relies on (measured on all three PDFs, 2026-10-01):
  - Page header (Gazette line, rule, page number) lies above y=75 on every page.
  - The body column runs x=114..482. A section starts with "N." at x=138..148.
  - Section titles are marginal notes: left margin (x1<=113.5) on odd page
    indexes, right margin (x0>=481) on even page indexes. The opposite margin
    holds citations of other Acts ("10 of 1897.") - never titles.
  - Words need x_tolerance=0.8: the PDF stores no spaces, so words are split
    by gap. Measured: gaps inside a word <= 0.51pt; between words >= 1.44pt,
    except beside a capital "A", which the font sets tighter (1.10-1.16pt) -
    "Afinds", "ClausesAct" at 1.2. pdfplumber's default (3) glues everything.

Every word on every page is classified; anything that fits no region is
reported, not guessed. A section starts only when the number is the next one
expected, so a stray "12." in body text can never split a section.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pdfplumber

ACTS = {
    "BNS": ("bns-2023.pdf", "Bharatiya Nyaya Sanhita, 2023", 358,
            "https://www.mha.gov.in/sites/default/files/250883_english_01042024.pdf"),
    "BNSS": ("bnss-2023.pdf", "Bharatiya Nagarik Suraksha Sanhita, 2023", 531,
             "https://www.mha.gov.in/sites/default/files/250884_2_english_01042024.pdf"),
    "BSA": ("bsa-2023.pdf", "Bharatiya Sakshya Adhiniyam, 2023", 170,
            "https://www.mha.gov.in/sites/default/files/250882_english_01042024.pdf"),
}

WORD_GAP = 0.8
# Marginal notes are justified line by line, so letter spacing changes from
# line to line: 0.26pt in "committed;if" (word gap 3.5), 0.89 in "on", 0.90 in
# "not", while "disease dangerous" has a word gap of only 0.99. No fixed gap
# separates letters from words; each line's own median gap (letters far
# outnumber word breaks) does: a break is a gap clearly above it.
MARGIN_BREAK_OVER_MEDIAN = 0.45
MARGIN_BREAK_MIN = 0.6
# BSA groups chapters into Parts: "PART III" / "ON PROOF" / "CHAPTER III".
PART = re.compile(r"^PART\s*[IVX]+$")
HEADER_BOTTOM = 75
# Positions on a standard page. Each page's own offset is measured (BSA page 1
# sits 5pt to the right) and added to every one of these.
BODY_MIN_X0 = 114
RIGHT_MARGIN_MIN_X0 = 481
BODY_MAX_X1 = 482.5
SECTION_X0 = (138, 148)
CONTINUATION_X0 = 118
# Small capitals ("P" + "RELIMINARY") sit ~3pt apart vertically; body lines are 12pt apart.
LINE_TOLERANCE = 4
CITATION = re.compile(r"^\d+\s+of\s+\d{4}\.?$")
# Printed spaced, extracted as "THEFIRSTSCHEDULE" - spaces optional.
SCHEDULE = re.compile(r"^THE\s*(FIRST\s*|SECOND\s*)?SCHEDULE$")
# The centred rule before the signatory ("—————", then "DIWAKAR SINGH, Joint
# Secretary") ends the Act; it occurs nowhere inside a section.
END_RULE = re.compile(r"^[—–_\-]{3,}$")
# A marginal note is one block of lines ~9pt apart; a larger gap ends it.
MARGIN_GAP = 14
CHAPTER = re.compile(r"^CHAPTER\s*[IVXLC]+[A-Z]?$")
PARAGRAPH_START = re.compile(r"^(\((\d+[A-Z]?|[a-z]{1,2}|[ivxl]+|[A-Z])\)|Explanations?\b|Illustrations?\b|Provided\b|Exceptions?\b|[A-Z]\.\s*—)")
# "192.Whoever": the number and the first word are printed with no gap.
GLUED_NUMBER = re.compile(r"^(\d{1,3}\.)(\S.*)$")

# Typesetting faults in the Gazette PDF itself, each confirmed against the
# official text and applied exactly once - a correction that does not match
# fails the run rather than passing silently.
CORRECTIONS = [
    ("BNSS", "480",
     "Court, o the execution by him of a bond for his appearance as hereinafter provided. n",
     "Court, on the execution by him of a bond for his appearance as hereinafter provided.",
     "the PDF prints the 'n' of 'on' at the end of a later line; wording per indiankanoon.org/doc/172895630"),
]

# BNSS 359 holds two tables (offence / BNS section / who may compound it) whose
# cells are printed at different heights from their rows, so no row can be
# rebuilt with certainty. Pairing an offence with the wrong section would be
# worse than leaving the table out, so it is replaced by this note.
TABLE_NOTE = ("[Table of the offences under the Bharatiya Nyaya Sanhita, 2023 to which this "
              "sub-section applies, with the person by whom each may be compounded - not "
              "reproduced here; see the official text of this section.]")
TABLES_EXPECTED = {("BNSS", "359"): 2}

RAW = Path(__file__).parent / "raw"
OUT = Path(__file__).parent / "out"


def lines_of(words):
    """Group words into lines by vertical position, each line sorted left to right."""
    lines = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(w["top"] - lines[-1]["top"]) <= LINE_TOLERANCE:
            lines[-1]["words"].append(w)
        else:
            lines.append({"top": w["top"], "words": [w]})
    for line in lines:
        line["words"].sort(key=lambda w: w["x0"])
        line["x0"] = line["words"][0]["x0"]
        line["x1"] = line["words"][-1]["x1"]
        # Words closer than the word-split tolerance were only separated by a
        # baseline shift (small capitals), so they join without a space.
        text = line["words"][0]["text"]
        for prev, w in zip(line["words"], line["words"][1:]):
            text += ("" if w["x0"] - prev["x1"] < WORD_GAP else " ") + w["text"]
        line["text"] = text
    return lines


def margin_rows(page, off):
    """Margin lines built from characters, splitting words by each line's own spacing."""
    chars = [c for c in page.chars if c["top"] >= HEADER_BOTTOM and c["text"].strip()
             and (c["x0"] < BODY_MIN_X0 + off or c["x0"] >= RIGHT_MARGIN_MIN_X0 + off)]
    rows = []
    for c in sorted(chars, key=lambda c: (c["top"], c["x0"])):
        side = "left" if c["x0"] < BODY_MIN_X0 + off else "right"
        if rows and rows[-1]["side"] == side and abs(c["top"] - rows[-1]["top"]) <= LINE_TOLERANCE / 2:
            rows[-1]["chars"].append(c)
        else:
            rows.append({"top": c["top"], "side": side, "chars": [c]})
    for row in rows:
        cs = sorted(row["chars"], key=lambda c: c["x0"])
        gaps = [b["x0"] - a["x1"] for a, b in zip(cs, cs[1:])]
        median = sorted(gaps)[len(gaps) // 2] if gaps else 0
        cut = max(median + MARGIN_BREAK_OVER_MEDIAN, MARGIN_BREAK_MIN)
        text = cs[0]["text"]
        for g, c in zip(gaps, cs[1:]):
            text += (" " if g > cut else "") + c["text"]
        row.update(text=text, x0=cs[0]["x0"])
    return rows


def join_lines(parts):
    """Join wrapped lines with a space - except after a line-end hyphen, where
    the line broke inside a compound word ("house-" + "breaking"). All 17
    such breaks in the three Acts are compounds; an em dash is not a hyphen."""
    out = ""
    for part in parts:
        out = part if not out else (out + part if out.endswith("-") else out + " " + part)
    return out


SMALL_WORDS = {"of", "the", "and", "or", "to", "in", "for", "by", "as", "at", "on", "with", "a", "an", "under", "from"}


def chapter_name(lines):
    """['CHAPTERVI', 'OF OFFENCES AFFECTING THE HUMAN BODY'] -> 'Chapter VI - Of Offences Affecting the Human Body'
    - the shape the hand-written seed rows already use."""
    numeral = re.sub(r"^CHAPTER\s*", "", lines[0])
    words = " ".join(lines[1:]).lower().split()
    title = " ".join(w if (i and w in SMALL_WORDS) else w[:1].upper() + w[1:] for i, w in enumerate(words))
    return f"Chapter {numeral}" + (f" - {title}" if title else "")


def page_offset(words):
    """The page's horizontal shift: most common line start near the continuation indent, minus 118."""
    starts = Counter()
    rows = {}
    for w in words:
        rows.setdefault(round(w["top"] / 3), []).append(w["x0"])
    for xs in rows.values():
        x = round(min(xs))
        if 105 <= x <= 135:
            starts[x] += 1
    return (starts.most_common(1)[0][0] - CONTINUATION_X0) if starts else 0


def split_glued_numbers(words, offset):
    out = []
    for w in words:
        m = GLUED_NUMBER.match(w["text"])
        if m and SECTION_X0[0] + offset <= w["x0"] <= SECTION_X0[1] + offset:
            out.append({**w, "text": m.group(1)})
            out.append({**w, "text": m.group(2), "x0": w["x0"] + 1})
        else:
            out.append(w)
    return out


def parse(code):
    filename, act_name, expected_count, source_url = ACTS[code]
    sections, anomalies, stats = [], [], Counter()
    current = None
    expected = 1
    chapter = None
    pending_chapter = None
    in_part = False
    stopped = False

    with pdfplumber.open(RAW / filename) as pdf:
        for index, page in enumerate(pdf.pages):
            if stopped:
                break
            title_side = "right" if index % 2 == 0 else "left"
            body, title_margin = [], []
            words = page.extract_words(x_tolerance=WORD_GAP, y_tolerance=2)
            off = page_offset([w for w in words if w["top"] >= HEADER_BOTTOM])
            stats[f"offset{off:+d}"] += 1
            for w in split_glued_numbers(words, off):
                if w["top"] < HEADER_BOTTOM:
                    stats["header"] += 1
                    continue
                if w["x0"] < BODY_MIN_X0 + off or w["x0"] >= RIGHT_MARGIN_MIN_X0 + off:
                    continue  # margins are read below, at their own word gap
                if w["x1"] <= BODY_MAX_X1 + off:
                    body.append(w)
                    stats["body"] += 1
                else:
                    stats["unclassified"] += 1
                    anomalies.append(("unclassified-word", index + 1, round(w["x0"]), round(w["top"]), w["text"]))
            for line in margin_rows(page, off):
                if line["side"] == title_side:
                    title_margin.append(line)
                    stats["title-margin"] += 1
                else:
                    stats["citation-margin"] += 1

            margin_lines = [l for l in title_margin if not CITATION.match(l["text"])]
            body_lines = lines_of(body)

            for i, line in enumerate(body_lines):
                text = line["text"]
                first = line["words"][0]

                if current and (SCHEDULE.match(text) or (END_RULE.match(text) and line["x0"] >= 200 + off)):
                    stopped = True
                    break

                # A Part heading and its capitals title ("PART III" / "ON PROOF")
                # sit above a chapter heading; neither is section text.
                if PART.match(text):
                    in_part = True
                    continue
                if in_part and not CHAPTER.match(text) and text.upper() == text:
                    continue
                in_part = False

                # Chapter heading, and the all-capitals title line(s) under it.
                if CHAPTER.match(text):
                    pending_chapter = [text]
                    continue
                if pending_chapter is not None and text.upper() == text and re.search(r"[A-Z]", text):
                    pending_chapter.append(text)
                    continue
                if pending_chapter is not None:
                    chapter = chapter_name(pending_chapter)
                    pending_chapter = None

                number = re.fullmatch(r"(\d{1,3})\.", first["text"])
                starts = number and SECTION_X0[0] + off <= first["x0"] <= SECTION_X0[1] + off
                if starts and int(number.group(1)) == expected:
                    if current:
                        sections.append(current)
                    nxt = next((l["top"] for l in body_lines[i + 1:]
                                if re.fullmatch(r"\d{1,3}\.", l["words"][0]["text"])
                                and SECTION_X0[0] + off <= l["words"][0]["x0"] <= SECTION_X0[1] + off
                                and int(l["words"][0]["text"][:-1]) == expected + 1), 10_000)
                    title_words, last_top = [], None
                    for m in margin_lines:
                        if not (line["top"] - 4 <= m["top"] < nxt - 4):
                            continue
                        if last_top is not None and m["top"] - last_top > MARGIN_GAP:
                            break
                        title_words.append(m["text"])
                        last_top = m["top"]
                    current = {
                        "act_code": code, "act_name": act_name, "section_number": str(expected),
                        "section_title": join_lines(title_words), "chapter": chapter, "page": index + 1,
                        "source_url": source_url, "paragraphs": [text],
                    }
                    expected += 1
                    continue
                if starts and current and int(number.group(1)) > expected:
                    anomalies.append(("number-skipped", index + 1, expected, text[:60]))

                if not current:
                    continue  # the Gazette preamble before section 1

                # A centred line followed by the next section start is a heading
                # between sections ("Of offences affecting life"), not text.
                # Centred on the column (114..482, centre ~298) - not merely indented:
                # "used for any religious purpose." (BNS 294) starts at 166 but is
                # clause text, centre 228; real headings sit within a few points of 298.
                column_centre = (BODY_MIN_X0 + BODY_MAX_X1) / 2 + off
                centred = (line["x0"] >= 160 + off and abs((line["x0"] + line["x1"]) / 2 - column_centre) <= 20
                           and not text.startswith("(") and not re.match(r"Illustrations?\.|Explanation", text))
                following = body_lines[i + 1] if i + 1 < len(body_lines) else None
                if centred and following is not None:
                    f = following["words"][0]
                    if re.fullmatch(r"\d{1,3}\.", f["text"]) and SECTION_X0[0] + off <= f["x0"] <= SECTION_X0[1] + off:
                        stats["subheading"] += 1
                        current.setdefault("_dropped_headings", []).append(text)
                        continue

                # A new paragraph starts at a marker - "(2)", "(a)", "(ii)",
                # Explanation, Illustration(s), Provided, Exception, "A.—" - or at the
                # first-line indent (142) when the line above ended a sentence and
                # this one opens with a capital. Indentation alone is not enough:
                # a sub-section wraps from 142 to 118, but a clause "(a)" starts at
                # 166 and wraps to 142, so 142 is also a continuation indent.
                first_indent = SECTION_X0[0] + off <= line["x0"] <= SECTION_X0[1] + off
                ended = re.search(r"[.:–—]$", current["paragraphs"][-1])
                if PARAGRAPH_START.match(text) or (first_indent and ended and text[:1].isupper()):
                    current["paragraphs"].append(text)
                else:             # continuation of the paragraph above
                    current["paragraphs"][-1] = join_lines([current["paragraphs"][-1], text])
        if current:
            sections.append(current)

    for s in sections:
        kept, tables, in_table = [], 0, False
        for p in s.pop("paragraphs"):
            p = p.strip()
            if p in ("TABLE", "Table"):
                in_table, tables = True, tables + 1
                kept.append(TABLE_NOTE)
                continue
            if in_table and not re.match(r"^\(\d+\)", p):
                continue
            in_table = False
            kept.append(p)
        if tables != TABLES_EXPECTED.get((code, s["section_number"]), 0):
            anomalies.append(("unexpected-table", s["section_number"], tables))
        s["section_text"] = "\n".join(kept)
        for act, number, before, after, why in CORRECTIONS:
            if (act, number) == (code, s["section_number"]):
                if s["section_text"].count(before) != 1:
                    raise SystemExit(f"correction for {act} {number} did not match exactly once")
                s["section_text"] = s["section_text"].replace(before, after)
                s["corrected"] = why
        title = re.sub(r"\s+", " ", s["section_title"]).strip()
        # The marginal note's closing full stop goes; an abbreviation's stays ("etc.").
        if title.endswith(".") and not re.search(r"\b(etc|Govt|viz|i\.e|e\.g)\.$", title):
            title = title[:-1].rstrip()
        s["section_title"] = title
    return sections, anomalies, stats, expected_count


def main(codes):
    OUT.mkdir(exist_ok=True)
    ok = True
    for code in codes:
        sections, anomalies, stats, expected_count = parse(code)
        numbers = [int(s["section_number"]) for s in sections]
        untitled = [s["section_number"] for s in sections if not s["section_title"]]
        short = [s["section_number"] for s in sections if len(s["section_text"]) < 40]
        bad_chars = [s["section_number"] for s in sections if "�" in s["section_text"] + s["section_title"]]
        print(f"== {code}: {len(sections)} sections (expected {expected_count}); words {dict(stats)}")
        print(f"   contiguous 1..N: {numbers == list(range(1, len(numbers) + 1))}; untitled: {untitled[:20]}; very short: {short[:20]}; replacement chars: {bad_chars[:20]}")
        print(f"   anomalies: {len(anomalies)} {anomalies[:12]}")
        if len(sections) != expected_count or untitled or bad_chars:
            ok = False
        with open(OUT / f"{code.lower()}.jsonl", "w", encoding="utf-8") as f:
            for s in sections:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
    print("ALL CHECKS PASSED" if ok else "CHECKS FAILED")


if __name__ == "__main__":
    main(sys.argv[1:] or list(ACTS))
