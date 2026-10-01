"""
Parse the BPR&D correspondence tables (BNS<->IPC, BNSS<->CrPC, BSA<->IEA) into
(new section, old section) pairs.

Column boundaries come from each table's own header row ("BNS Subject IPC
Summary", "BSA IEA Subject Summary" - the BSA table orders its columns
differently). A row starts at a section reference in the new-code column; its
cells run until the next row starts. Old-code cells are read for section
references only: "230 to 232, 246 to 249, 255, 489A", "171-I", "2(a)]", "New".
Anything that is not a recognisable reference is reported, never guessed.
"""
import difflib, json, re, sys
from collections import defaultdict
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).parent))
from parse_acts import lines_of  # noqa: E402

TABLES = {
    # new code: (file, new header, old header, old code, last old section, last new section)
    "BNS": ("table-bns-ipc.pdf", "BNS", "IPC", "IPC", 511, 358),
    "BNSS": ("table-bnss-crpc.pdf", "BNSS", "CrPC", "CRPC", 484, 531),
    "BSA": ("table-bsa-iea.pdf", "BSA", "IEA", "IEA", 167, 170),
}
ROW_REF = re.compile(r"^(\d{1,3})((?:\([0-9A-Za-z]{1,4}\))*)$")
FOOTER = re.compile(r"Anil Kishore Yadav|CAPT Bhopal")
RAW = Path(__file__).parent / "raw"
OUT = Path(__file__).parent / "out"


def columns(pdf, new_head, old_head):
    """x0 of each column, read from the header row on page 1."""
    for line in lines_of(pdf.pages[0].extract_words(x_tolerance=1.5, y_tolerance=2)):
        texts = [w["text"] for w in line["words"]]
        if "Subject" in texts and "Summary" in texts:
            pos = {w["text"]: w["x0"] for w in line["words"]}
            return {"new": pos[new_head], "old": pos[old_head], "subject": pos["Subject"], "summary": pos["Summary"]}
    raise SystemExit("header row not found")


def column_of(x0, cols):
    order = sorted(cols.items(), key=lambda kv: kv[1])
    name = order[0][0]
    for col, start in order:
        if x0 >= start - 6:
            name = col
    return name


WORDS_IN_OLD_CELLS = {"new", "newly", "added", "ipc", "crpc", "iea", "sections", "section", "interpretation",
                      "interpret", "ation", "clause", "proviso", "explanation", "explanat", "ion", "illustration"}


def old_refs(text, last_old):
    """Section references in an old-code cell. Returns (refs, leftovers).

    Sub-divisions are not sections: "3, para 1" is paragraph 1 of section 3 and
    "23 Clause-1" clause 1 of section 23 - read naively, each would add a false
    "section 1". Parenthesised parts ("376(1)", "2(c )", "228A (1)/(2)") are
    dropped to their section; "171-I" is section 171I.
    """
    t = text.replace("–", "-").replace("—", "-").replace("]", " ")
    t = re.sub(r"\s*\([^)]*\)", "", t)                                   # 376(1) -> 376
    t = re.sub(r"\b(para|Clause|Explanat\s*ion|Explanation)[\s-]*\d+\b", " ", t, flags=re.I)
    t = re.sub(r"\b(\d{1,3})-([A-Z])\b", r"\1\2", t)                      # 171-I -> 171I
    refs, leftovers = [], []
    for chunk in re.split(r"[,;&/]|\band\b", t):
        chunk = chunk.strip(" .")
        if not chunk:
            continue
        rng = re.fullmatch(r"(\d{1,3})([A-Z]{0,3})\s+to\s+(\d{1,3})([A-Z]{0,3})", chunk)
        if rng:
            a, asuf, b, bsuf = int(rng.group(1)), rng.group(2), int(rng.group(3)), rng.group(4)
            if not asuf and not bsuf and a < b <= a + 60:
                refs += [str(n) for n in range(a, b + 1)]
            elif a == b and len(asuf) == len(bsuf) == 1 and asuf < bsuf:
                refs += [f"{a}{chr(c)}" for c in range(ord(asuf), ord(bsuf) + 1)]
            else:
                leftovers.append(chunk)
            continue
        for token in chunk.split():
            if re.fullmatch(r"\d{1,3}[A-Z]{0,3}", token):
                refs.append(token)
            elif token.lower().strip(".-") not in WORDS_IN_OLD_CELLS and token not in ("-",):
                leftovers.append(token)
    bad = [r for r in refs if not (1 <= int(re.match(r"\d+", r).group(0)) <= last_old)]
    return [r for r in refs if r not in bad], leftovers + [f"out-of-range:{b}" for b in bad]


def parse(code):
    filename, new_head, old_head, old_code, last_old, last_new = TABLES[code]
    rows, current = [], None
    with pdfplumber.open(RAW / filename) as pdf:
        cols = columns(pdf, new_head, old_head)
        for index, page in enumerate(pdf.pages):
            for line in lines_of(page.extract_words(x_tolerance=1.5, y_tolerance=2)):
                if FOOTER.search(line["text"]):
                    continue
                cells = defaultdict(list)
                for w in line["words"]:
                    cells[column_of(w["x0"], cols)].append(w["text"])
                first_new = cells["new"][0] if cells["new"] else None
                if first_new and ROW_REF.match(first_new.rstrip(".")):
                    if current:
                        rows.append(current)
                    current = {"new": first_new.rstrip("."), "subject": [], "old": [], "page": index + 1}
                    cells["new"] = cells["new"][1:]
                if current is None:
                    continue  # title and header rows
                current["subject"] += cells["new"] + cells["subject"]
                current["old"] += cells["old"]
        if current:
            rows.append(current)

    pairs, problems, subjects = [], [], {}
    for r in rows:
        base = ROW_REF.match(r["new"]).group(1)
        subject = " ".join(r["subject"]).strip()
        subjects.setdefault(base, subject)
        refs, leftovers = old_refs(" ".join(r["old"]), last_old)
        for ref in refs:
            pairs.append({"new_act": code, "new_section": r["new"], "new_base": base, "old_act": old_code, "old_section": ref})
        if leftovers:
            problems.append((r["new"], " ".join(r["old"]), leftovers))
    return rows, pairs, problems, subjects, last_new


def main():
    OUT.mkdir(exist_ok=True)
    titles = {c: {json.loads(l)["section_number"]: json.loads(l)["section_title"] for l in open(OUT / f"{c.lower()}.jsonl", encoding="utf-8")} for c in TABLES}
    for code in TABLES:
        rows, pairs, problems, subjects, last_new = parse(code)
        bases = sorted({int(p) for p in subjects}, key=int)
        missing = [n for n in range(1, last_new + 1) if str(n) not in subjects]
        out_of_range_new = [b for b in bases if b > last_new]
        weak = []
        for n, subj in subjects.items():
            if n in titles[code]:
                ratio = difflib.SequenceMatcher(a=re.sub(r"\W+", " ", subj.lower()), b=re.sub(r"\W+", " ", titles[code][n].lower())).ratio()
                if ratio < 0.8:
                    weak.append((n, round(ratio, 2), subj[:70], titles[code][n][:70]))
        print(f"== {code}: {len(rows)} rows, {len(pairs)} pairs, {len({p['new_base'] for p in pairs})} new sections with an old equivalent")
        print(f"   new sections missing from table: {missing[:30]} | out of range: {out_of_range_new[:10]}")
        print(f"   unparsed old-cells: {len(problems)} {problems[:12]}")
        print(f"   subject vs Gazette title below 0.8 similarity: {len(weak)}")
        for w in weak[:15]:
            print("     ", w)
        with open(OUT / f"map-{code.lower()}.jsonl", "w", encoding="utf-8") as f:
            for p in pairs:
                f.write(json.dumps(p) + "\n")


if __name__ == "__main__":
    main()
