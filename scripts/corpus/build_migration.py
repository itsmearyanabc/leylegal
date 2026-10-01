"""Write supabase/migrations/0021_official_statute_text.sql from the verified JSONL."""
import json
import re
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).parent / "out"
TARGET = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "0021_official_statute_text.sql"
EXPECTED = {"BNS": 358, "BNSS": 531, "BSA": 170}


def q(value):
    if value is None:
        return "NULL"
    assert "\x00" not in value
    return "'" + value.replace("'", "''") + "'"


sections = {code: [json.loads(l) for l in open(OUT / f"{code.lower()}.jsonl", encoding="utf-8")] for code in EXPECTED}
pairs = []
for code in EXPECTED:
    pairs += [json.loads(l) for l in open(OUT / f"map-{code.lower()}.jsonl", encoding="utf-8")]

# One row per official pair; the table repeats a pair when a section spans rows.
unique_pairs = sorted({(p["new_act"], p["new_section"], p["old_act"], p["old_section"]) for p in pairs},
                      key=lambda t: (t[0], int(re.match(r"\d+", t[1]).group(0)), t[1], t[2], t[3]))
olds_by_new = defaultdict(set)
for new_act, new_section, old_act, old_section in unique_pairs:
    olds_by_new[(new_act, new_section.split("(")[0])].add((old_act, old_section))

for code, n in EXPECTED.items():
    assert [int(s["section_number"]) for s in sections[code]] == list(range(1, n + 1)), code

bns = {s["section_number"]: s for s in sections["BNS"]}
sub_103_1 = bns["103"]["section_text"].split("\n")[0]
assert sub_103_1.startswith("103. (1) Whoever commits murder")
sub_103_1 = sub_103_1[len("103. "):]
sub_318_4 = bns["318"]["section_text"].split("\n")[-1]
assert sub_318_4.startswith("(4) Whoever cheats and thereby dishonestly induces")

lines = []
w = lines.append
w("""-- =============================================================================
-- 0021_official_statute_text.sql
--
-- The complete Bharatiya Nyaya Sanhita (358 sections), Bharatiya Nagarik
-- Suraksha Sanhita (531) and Bharatiya Sakshya Adhiniyam (170), in their
-- enacted text, and the official old-to-new section correspondence.
--
-- ## Why
--
-- 0006 said it plainly: its section_text values were "ABRIDGED summaries, not
-- the enacted text", to be replaced before production. They never were, and
-- the corpus held ~28 sections. A question about any other section was
-- answered from the model's memory: "Section 520 BNSS" came back as disposal
-- of property pending appeal; it is "Trials before High Courts". And 0018
-- seeded BNS 32 with the text of BNS 20 ("child under seven years") mapped to
-- IPC 82; BNS 32 is "Act to which a person is compelled by threats" (IPC 94).
--
-- ## Sources (downloaded 2026-10-01)
--
--   Text: the Gazette of India copies published by the Ministry of Home Affairs
--     BNS  mha.gov.in/sites/default/files/250883_english_01042024.pdf   (sha256 c9da896e7a16c481...)
--     BNSS mha.gov.in/sites/default/files/250884_2_english_01042024.pdf (sha256 5e60e2afe30d0fe7...)
--     BSA  mha.gov.in/sites/default/files/250882_english_01042024.pdf   (sha256 13e2b6eb66add222...)
--   Correspondence: Bureau of Police Research & Development tables
--     bprd.nic.in "COMPARISON SUMMARY BNS to IPC", "Comparison summary BNSS to
--     CrPC", "Comparison Summary BSA to IEA"
--
-- ## How it was checked
--
--   - Every section 1..N present once, titled, in order (only the next expected
--     number can start a section).
--   - Word for word against Indian Kanoon's text of the same Acts (India Code):
--     BNSS 514/531 and BSA 148/170 identical; every difference explained
--     (Kanoon inlines margin citations and headings; Kanoon errors in BNSS 35,
--     170, 234). Kanoon carries no BNS body text; BNS checked word for word
--     against an independent PDF extraction.
--   - Titles: 1,038 identical to Kanoon; 10 differ only in Kanoon's formatting.
--   - Mappings: all 35 hand-written mappings in 0006/0018/0019 agree with the
--     official tables except BNS 32 / IPC 82, which 0018 had wrong.
--
-- ## Deliberate omissions and corrections
--
--   - BNSS 359's two tables (offence / BNS section / who may compound it) are
--     replaced by a note: their cells are printed at heights that do not
--     match their rows, and pairing an offence with the wrong section would
--     be worse than leaving the table out.
--   - BNSS 480(2): the Gazette PDF prints the "n" of "on" at the end of a later
--     line; the enacted wording "Court, on the execution" is restored.
--   - punishment / cognizable / bailable / compoundable / triable_by are not
--     set here (the First Schedule cannot be read reliably). Values already on
--     BNS 64, 85, 352, 103(1) and 318(4) are hand-entered in 0006/0019 and are
--     left as they were.
--
-- The whole file runs as one transaction and checks itself before it ends:
-- if any count or anchor mapping is wrong, it raises and nothing is changed.
-- =============================================================================
""")

w("""-- ---------------------------------------------------------------------------
-- The official correspondence, one row per (new section, old section) pair.
-- Many-to-one is common: BNS 318 replaces IPC 415, 417, 418 and 420.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS statute_correspondence (
    new_act     VARCHAR(20) NOT NULL,   -- BNS | BNSS | BSA
    new_section VARCHAR(20) NOT NULL,   -- as the table gives it: '318(4)', '144'
    old_act     VARCHAR(20) NOT NULL,   -- IPC | CRPC | IEA
    old_section VARCHAR(20) NOT NULL,   -- '420', '41A'
    PRIMARY KEY (new_act, new_section, old_act, old_section)
);

CREATE INDEX IF NOT EXISTS idx_correspondence_old
    ON statute_correspondence (upper(old_act), split_part(upper(old_section), '(', 1));
CREATE INDEX IF NOT EXISTS idx_correspondence_new
    ON statute_correspondence (upper(new_act), split_part(upper(new_section), '(', 1));

-- Public law, like the statutes themselves (0005).
ALTER TABLE statute_correspondence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS statute_correspondence_public_read ON statute_correspondence;
CREATE POLICY statute_correspondence_public_read
    ON statute_correspondence FOR SELECT
    TO anon, authenticated
    USING (true);

COMMENT ON TABLE statute_correspondence IS
    'Official section correspondence, BNS/BNSS/BSA to IPC/CrPC/IEA, from the BPR&D comparison tables. One row per pair.';
""")

w("INSERT INTO statute_correspondence (new_act, new_section, old_act, old_section) VALUES")
w(",\n".join(f"    ({q(a)}, {q(b)}, {q(c)}, {q(d)})" for a, b, c, d in unique_pairs))
w("ON CONFLICT DO NOTHING;\n")

w("""-- ---------------------------------------------------------------------------
-- Every section of the three Acts. Existing rows (BNS 32, 64, 85, 352) take
-- the enacted text; their classification columns are not touched.
-- corresponding_* is set where the official mapping is one-to-one; the full
-- mapping, many-to-one included, is in statute_correspondence.
-- ---------------------------------------------------------------------------""")
w("INSERT INTO statutes (act_code, act_name, section_number, section_title, section_text, chapter, source_url, corresponding_act, corresponding_section, language) VALUES")
rows = []
for code in EXPECTED:
    for s in sections[code]:
        olds = sorted(olds_by_new.get((code, s["section_number"]), set()))
        c_act, c_sec = (olds[0][0], olds[0][1]) if len(olds) == 1 else (None, None)
        rows.append(f"    ({q(code)}, {q(s['act_name'])}, {q(s['section_number'])}, {q(s['section_title'])}, "
                    f"{q(s['section_text'])}, {q(s['chapter'])}, {q(s['source_url'])}, {q(c_act)}, {q(c_sec)}, 'en')")
w(",\n".join(rows))
w("""ON CONFLICT (act_code, section_number, language) DO UPDATE SET
    act_name              = EXCLUDED.act_name,
    section_title         = EXCLUDED.section_title,
    section_text          = EXCLUDED.section_text,
    chapter               = EXCLUDED.chapter,
    source_url            = EXCLUDED.source_url,
    corresponding_act     = EXCLUDED.corresponding_act,
    corresponding_section = EXCLUDED.corresponding_section,
    updated_at            = NOW();
""")

w(f"""-- ---------------------------------------------------------------------------
-- The two sub-section rows 0006 seeded keep their classification and their
-- IPC mapping (302, 420 - both official); their abridged text becomes the
-- enacted sub-section.
-- ---------------------------------------------------------------------------
UPDATE statutes
   SET section_text = {q(sub_103_1)},
       chapter = {q(bns['103']['chapter'])}, source_url = {q(bns['103']['source_url'])}, updated_at = NOW()
 WHERE act_code = 'BNS' AND section_number = '103(1)' AND language = 'en';

UPDATE statutes
   SET section_text = {q(sub_318_4)},
       chapter = {q(bns['318']['chapter'])}, source_url = {q(bns['318']['source_url'])}, updated_at = NOW()
 WHERE act_code = 'BNS' AND section_number = '318(4)' AND language = 'en';

-- 0018 recorded IPC 82 (child under seven) as BNS 32. It is BNS 20.
UPDATE statutes
   SET corresponding_section = '20', updated_at = NOW()
 WHERE act_code = 'IPC' AND section_number = '82' AND language = 'en'
   AND corresponding_act = 'BNS' AND corresponding_section = '32';
""")

w("""-- ---------------------------------------------------------------------------
-- search_statutes: two more ways to find a section. Signature unchanged.
--   EXACT on the section without its sub-clause ("103" finds "103(1)").
--   The official correspondence: "IPC 420" finds BNS 318, "BNSS 144" finds
--   the CrPC 125 row, whether or not the row records the mapping itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_statutes(
    p_query_text     TEXT,
    p_section_number TEXT    DEFAULT NULL,
    p_act_code       TEXT    DEFAULT NULL,
    p_limit          INTEGER DEFAULT 5
)
RETURNS TABLE (
    id                    UUID,
    act_code              VARCHAR(20),
    act_name              VARCHAR(200),
    section_number        VARCHAR(20),
    section_title         VARCHAR(400),
    section_text          TEXT,
    punishment            TEXT,
    is_cognizable         BOOLEAN,
    is_bailable           BOOLEAN,
    is_compoundable       BOOLEAN,
    triable_by            VARCHAR(160),
    corresponding_act     VARCHAR(20),
    corresponding_section VARCHAR(20),
    match_type            TEXT,
    score                 DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
WITH candidates AS (
    -- 1. Exact section number.
    SELECT s.*, 'EXACT'::TEXT AS match_type, 1000.0::DOUBLE PRECISION AS score
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND upper(s.section_number) = upper(p_section_number)
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))

    UNION ALL

    -- 1b. The same section, one side naming a sub-clause ("103" / "103(1)").
    SELECT s.*, 'EXACT'::TEXT, 990.0::DOUBLE PRECISION
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND split_part(upper(s.section_number), '(', 1) = split_part(upper(p_section_number), '(', 1)
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))

    UNION ALL

    -- 2. The recodified equivalent recorded on a row (0017).
    SELECT s.*, 'RECODIFIED'::TEXT, 900.0::DOUBLE PRECISION
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND p_act_code IS NOT NULL
       AND s.corresponding_act IS NOT NULL
       AND upper(s.corresponding_act) = upper(p_act_code)
       AND split_part(upper(s.corresponding_section), '(', 1)
           = split_part(upper(p_section_number), '(', 1)

    UNION ALL

    -- 2b. The official correspondence, old code asked: the new section's text.
    SELECT s.*, 'RECODIFIED'::TEXT, 950.0::DOUBLE PRECISION
      FROM statute_correspondence c
      JOIN statutes s
        ON upper(s.act_code) = upper(c.new_act)
       AND split_part(upper(s.section_number), '(', 1) = split_part(upper(c.new_section), '(', 1)
     WHERE p_section_number IS NOT NULL
       AND p_act_code IS NOT NULL
       AND upper(c.old_act) = upper(p_act_code)
       AND split_part(upper(c.old_section), '(', 1) = split_part(upper(p_section_number), '(', 1)

    UNION ALL

    -- 2c. The official correspondence, new code asked: the old section's row, if held.
    SELECT s.*, 'RECODIFIED'::TEXT, 900.0::DOUBLE PRECISION
      FROM statute_correspondence c
      JOIN statutes s
        ON upper(s.act_code) = upper(c.old_act)
       AND split_part(upper(s.section_number), '(', 1) = split_part(upper(c.old_section), '(', 1)
     WHERE p_section_number IS NOT NULL
       AND p_act_code IS NOT NULL
       AND upper(c.new_act) = upper(p_act_code)
       AND split_part(upper(c.new_section), '(', 1) = split_part(upper(p_section_number), '(', 1)

    UNION ALL

    -- 3. Full text.
    SELECT s.*, 'FULLTEXT'::TEXT,
           (ts_rank_cd(s.search_vector, q.query) * 10.0)::DOUBLE PRECISION
      FROM statutes s,
           websearch_to_tsquery('english', p_query_text) AS q(query)
     WHERE s.search_vector @@ q.query
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))

    UNION ALL

    -- 4. Fuzzy section number, for typos and odd formatting.
    SELECT s.*, 'FUZZY'::TEXT,
           similarity(s.section_number, p_section_number)::DOUBLE PRECISION
      FROM statutes s
     WHERE p_section_number IS NOT NULL
       AND s.section_number % p_section_number
       AND (p_act_code IS NULL OR upper(s.act_code) = upper(p_act_code))
),
-- Same section can surface from several strategies; keep its best score.
deduped AS (
    SELECT DISTINCT ON (c.id)
           c.*
      FROM candidates c
     ORDER BY c.id, c.score DESC
)
SELECT d.id, d.act_code, d.act_name, d.section_number, d.section_title,
       d.section_text, d.punishment, d.is_cognizable, d.is_bailable,
       d.is_compoundable, d.triable_by, d.corresponding_act,
       d.corresponding_section, d.match_type, d.score
  FROM deduped d
 ORDER BY d.score DESC
 LIMIT p_limit;
$$;

COMMENT ON FUNCTION search_statutes IS
    'Statute lookup. Matches a section exactly or without its sub-clause, and across the 2023 recodification through corresponding_* on the row and the official statute_correspondence table.';

-- ---------------------------------------------------------------------------
-- verify_statute_refs: a reference is also real if the official
-- correspondence names it - "IPC 415" is a real section even though this
-- corpus holds no IPC 415 row. Signature unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_statute_refs(p_refs TEXT[])
RETURNS TABLE (
    ref            TEXT,
    found          BOOLEAN,
    act_code       VARCHAR(20),
    section_number VARCHAR(20),
    section_title  VARCHAR(400)
)
LANGUAGE sql
STABLE
AS $$
SELECT r.ref,
       m.act_code IS NOT NULL AS found,
       m.act_code,
       m.section_number,
       m.section_title
  FROM unnest(p_refs) AS r(ref)
 CROSS JOIN LATERAL (
      -- 'BNS 103(1)' -> act 'BNS', section '103(1)', base '103'
      SELECT upper(split_part(trim(r.ref), ' ', 1))                   AS act,
             upper(split_part(trim(r.ref), ' ', 2))                   AS section,
             split_part(upper(split_part(trim(r.ref), ' ', 2)), '(', 1) AS base
  ) p
  LEFT JOIN LATERAL (
      SELECT c.act_code, c.section_number, c.section_title
        FROM (
            -- 1. A row of its own.
            SELECT s.act_code, s.section_number, s.section_title, 1 AS preference
              FROM statutes s
             WHERE upper(s.act_code) = p.act
               AND split_part(upper(s.section_number), '(', 1) = p.base
               AND (upper(s.section_number) = p.section
                    OR strpos(s.section_number, '(') = 0
                    OR strpos(p.section, '(') = 0)

            UNION ALL

            -- 2. The recorded equivalent of a row in the other code.
            SELECT s.corresponding_act, s.corresponding_section, s.section_title, 2
              FROM statutes s
             WHERE s.corresponding_act IS NOT NULL
               AND upper(s.corresponding_act) = p.act
               AND split_part(upper(s.corresponding_section), '(', 1) = p.base
               AND (upper(s.corresponding_section) = p.section
                    OR strpos(s.corresponding_section, '(') = 0
                    OR strpos(p.section, '(') = 0)

            UNION ALL

            -- 3. Named by the official correspondence, on either side.
            SELECT x.act, x.section, NULL::VARCHAR(400), 3
              FROM (
                  SELECT c.old_act AS act, c.old_section AS section FROM statute_correspondence c
                  UNION ALL
                  SELECT c.new_act, c.new_section FROM statute_correspondence c
              ) x
             WHERE upper(x.act) = p.act
               AND split_part(upper(x.section), '(', 1) = p.base
        ) c
       ORDER BY c.preference
       LIMIT 1
  ) m ON TRUE;
$$;
""")

w(f"""-- ---------------------------------------------------------------------------
-- Self-check. Any failure raises, and the whole file is rolled back.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
    n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM statutes WHERE act_code = 'BNS'  AND language = 'en' AND section_number ~ '^[0-9]+$';
    IF n <> 358 THEN RAISE EXCEPTION 'BNS: % whole sections, expected 358', n; END IF;
    SELECT count(*) INTO n FROM statutes WHERE act_code = 'BNSS' AND language = 'en' AND section_number ~ '^[0-9]+$';
    IF n <> 531 THEN RAISE EXCEPTION 'BNSS: % whole sections, expected 531', n; END IF;
    SELECT count(*) INTO n FROM statutes WHERE act_code = 'BSA'  AND language = 'en' AND section_number ~ '^[0-9]+$';
    IF n <> 170 THEN RAISE EXCEPTION 'BSA: % whole sections, expected 170', n; END IF;

    SELECT count(*) INTO n FROM statute_correspondence;
    IF n <> {len(unique_pairs)} THEN RAISE EXCEPTION 'correspondence: % pairs, expected {len(unique_pairs)}', n; END IF;

    IF NOT EXISTS (SELECT 1 FROM statute_correspondence WHERE new_act = 'BNSS' AND new_section = '144' AND old_act = 'CRPC' AND old_section = '125')
        THEN RAISE EXCEPTION 'missing CrPC 125 -> BNSS 144'; END IF;
    IF NOT EXISTS (SELECT 1 FROM statute_correspondence WHERE new_act = 'BNS' AND split_part(new_section, '(', 1) = '318' AND old_act = 'IPC' AND old_section = '420')
        THEN RAISE EXCEPTION 'missing IPC 420 -> BNS 318'; END IF;
    IF NOT EXISTS (SELECT 1 FROM statute_correspondence WHERE new_act = 'BSA' AND new_section = '63' AND old_act = 'IEA' AND old_section = '65B')
        THEN RAISE EXCEPTION 'missing IEA 65B -> BSA 63'; END IF;

    IF (SELECT section_title FROM statutes WHERE act_code = 'BNSS' AND section_number = '520' AND language = 'en') <> 'Trials before High Courts'
        THEN RAISE EXCEPTION 'BNSS 520 title wrong'; END IF;
    IF (SELECT section_title FROM statutes WHERE act_code = 'BNS' AND section_number = '32' AND language = 'en') <> 'Act to which a person is compelled by threats'
        THEN RAISE EXCEPTION 'BNS 32 not corrected'; END IF;
    IF (SELECT section_text FROM statutes WHERE act_code = 'BNSS' AND section_number = '480' AND language = 'en') NOT LIKE '%Court, on the execution by him of a bond%'
        THEN RAISE EXCEPTION 'BNSS 480 correction missing'; END IF;
END
$check$;
""")

TARGET.write_text("\n".join(lines), encoding="utf-8", newline="\n")
print(f"wrote {TARGET} ({TARGET.stat().st_size // 1024} KB): {sum(len(v) for v in sections.values())} sections, {len(unique_pairs)} pairs")
