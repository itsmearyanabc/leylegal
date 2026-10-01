"""
Complete independent check: every parsed section of the BNS, BNSS and BSA
against Indian Kanoon's "Entire Act" page for the same Act (India Code text) -
title and text, word for word. Kanoon's editorial remarks are excluded.
"""
import difflib, html, json, re, sys
from html.parser import HTMLParser

PAGES = {"BNS": "entire-bns.html", "BNSS": "entire-bnss.html", "BSA": "entire-bsa.html"}
TABLE_NOTE_START = "[Table of the offences under the Bharatiya Nyaya Sanhita"


def words(text):
    text = html.unescape(text).lower().replace("—", " ").replace("–", " ")
    return re.findall(r"[a-z0-9]+", text)


class Act(HTMLParser):
    """Every top-level akn-section: {number: (heading, body)}, remarks dropped."""
    def __init__(self):
        super().__init__()
        self.sections = {}; self.current = None
        self.depth = 0; self.remark = 0; self.in_h3 = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs); cls = a.get("class", "") or ""
        if tag == "section" and "akn-section" in cls and self.depth == 0 and re.fullmatch(r"section_\d+", a.get("id", "")):
            self.current = a["id"].split("_")[1]; self.sections[self.current] = [[], []]; self.depth = 1
        elif tag == "section" and self.depth:
            self.depth += 1
        elif self.depth and tag == "span" and ("akn-remark" in cls or self.remark):
            self.remark += 1
        elif self.depth == 1 and tag == "h3":
            self.in_h3 = True
    def handle_endtag(self, tag):
        if tag == "section" and self.depth:
            self.depth -= 1
            if self.depth == 0: self.current = None
        elif tag == "span" and self.remark:
            self.remark -= 1
        elif tag == "h3":
            self.in_h3 = False
    def handle_data(self, data):
        if self.current and not self.remark:
            self.sections[self.current][0 if self.in_h3 else 1].append(data)


def main():
    grand = {"sections": 0, "text-identical": 0, "text-differs": 0, "title-differs": 0, "missing-on-kanoon": 0}
    for code, page in PAGES.items():
        p = Act(); p.feed(open(page, encoding="utf-8", errors="replace").read())
        ours = [json.loads(l) for l in open(f"out/{code.lower()}.jsonl", encoding="utf-8")]
        differs, titles = [], []
        for s in ours:
            n = s["section_number"]; grand["sections"] += 1
            if n not in p.sections:
                grand["missing-on-kanoon"] += 1; differs.append((n, "not on Kanoon page", "")); continue
            heading, body = (" ".join(x) for x in p.sections[n])
            hw = words(heading); hw = hw[1:] if hw and hw[0] == n else hw
            if hw != words(s["section_title"]):
                grand["title-differs"] += 1; titles.append((n, s["section_title"], heading.strip()))
            text = "\n".join(par for par in s["section_text"].split("\n") if not par.startswith(TABLE_NOTE_START))
            ow = words(text); ow = ow[1:] if ow and ow[0] == n else ow
            kw = words(body)
            sm = difflib.SequenceMatcher(a=ow, b=kw, autojunk=False)
            d = [(t, " ".join(ow[i1:i2])[:80], " ".join(kw[j1:j2])[:80]) for t, i1, i2, j1, j2 in sm.get_opcodes() if t != "equal"]
            if d:
                grand["text-differs"] += 1; differs.append((n, len(ow), d[:3]))
            else:
                grand["text-identical"] += 1
        print(f"== {code}: {len(ours)} ours, {len(p.sections)} on Kanoon; text differs in {len(differs)}; titles differ in {len(titles)}")
        for x in differs[:25]: print("   TEXT ", x)
        for x in titles[:25]: print("   TITLE", x)
    print("\nGRAND TOTAL", grand)


if __name__ == "__main__":
    main()
