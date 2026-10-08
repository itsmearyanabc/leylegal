-- =============================================================================
-- 0022_correspondence_subsections.sql
--
-- Sub-sections in the official correspondence where the BPR&D tables give only
-- the section, and the one row the tables leave out.
--
-- ## Why (live tests of 4 and 7 October 2026)
--
-- Eleven answers named the right section and the wrong unit: "IPC 379 = BNS
-- 303" (theft is defined in 303(1) and punished in 303(2)), "IPC 406 = BNS 316"
-- (316 holds five offences; 406 is 316(2) and 409 is 316(5)), "IPC 304A = BNS
-- 106" (106(2) is the separate hit-and-run offence) - M-IPC-021, 026, 028, 029,
-- 043, 046, 049, 053, M-IEA-007, O-12. The answers were faithful to 0021: the
-- BPR&D comparison tables list the new section only, with every old section it
-- absorbed in one cell, so only 116 of the 1,275 pairs carry a sub-section.
-- scripts/corpus/parse_tables.py reads them correctly; the source is coarse.
--
-- And "IPC 143 - which section is it in the BNS?" was answered "not carried
-- into the BNS, according to the 2023 correspondence table" (M-IPC-007). The
-- table has no row for IPC 143. BNS 189(2) is its text.
--
-- ## How each row was checked
--
-- Against the Gazette text of the new section already loaded by 0021: the
-- sub-section named below says what the old section said. The words quoted are
-- the opening of that sub-section in the Gazette. Only pairs where one
-- sub-section plainly is the old section are changed; IPC 390 (robbery
-- defined, across 309(1) to (3)) and the like are left at the section.
--
-- ## Needs a lawyer's sign-off before it ships
--
-- This is legal data. Each line below should be read against the bare acts by
-- someone qualified before deploy (see the README with this patch).
--
-- ## Reversible
--
-- Every change is an UPDATE of new_section from the section to one of its
-- sub-sections, plus one INSERT. Reverting is the same statements the other
-- way round (at the end of this file, commented out).
-- =============================================================================

-- BNS 189(1) "An assembly of five or more persons is designated an "unlawful assembly" ..."
UPDATE statute_correspondence SET new_section = '189(1)' WHERE new_act = 'BNS' AND new_section = '189' AND old_act = 'IPC' AND old_section = '141';
-- BNS 189(2) "Whoever, being aware of facts which render any assembly an unlawful assembly, intentionally
-- joins that assembly, or continues in it, is said to be a member of an unlawful assembly and such member
-- shall be punished with imprisonment ... six months" - IPC 142 (member) and IPC 143 (punishment).
UPDATE statute_correspondence SET new_section = '189(2)' WHERE new_act = 'BNS' AND new_section = '189' AND old_act = 'IPC' AND old_section = '142';
INSERT INTO statute_correspondence (new_act, new_section, old_act, old_section) VALUES ('BNS', '189(2)', 'IPC', '143')
    ON CONFLICT DO NOTHING;

-- BNS 103(1) "Whoever commits murder shall be punished with death or imprisonment for life ..."
-- (103(2), murder by a group on grounds of race, caste ..., is new.)
UPDATE statute_correspondence SET new_section = '103(1)' WHERE new_act = 'BNS' AND new_section = '103' AND old_act = 'IPC' AND old_section = '302';

-- BNS 106(1) "Whoever causes death of any person by doing any rash or negligent act not amounting to
-- culpable homicide ..." (106(2), the hit-and-run offence, is new.)
UPDATE statute_correspondence SET new_section = '106(1)' WHERE new_act = 'BNS' AND new_section = '106' AND old_act = 'IPC' AND old_section = '304A';

-- BNS 115(1) "Whoever does any act with the intention of thereby causing hurt ..." (IPC 321, definition)
-- BNS 115(2) "Whoever, except in the case provided for by sub-section (1) of section 122 voluntarily causes
-- hurt, shall be punished ..." (IPC 323, punishment)
UPDATE statute_correspondence SET new_section = '115(1)' WHERE new_act = 'BNS' AND new_section = '115' AND old_act = 'IPC' AND old_section = '321';
UPDATE statute_correspondence SET new_section = '115(2)' WHERE new_act = 'BNS' AND new_section = '115' AND old_act = 'IPC' AND old_section = '323';

-- BNS 117(1) "Whoever voluntarily causes hurt, if the hurt which he intends ... is grievous hurt ..." (IPC 322)
-- BNS 117(2) "Whoever, except in the case provided for by sub-section (2) of section 122, voluntarily causes
-- grievous hurt, shall be punished ..." (IPC 325). 117(3) and 117(4) are new.
UPDATE statute_correspondence SET new_section = '117(1)' WHERE new_act = 'BNS' AND new_section = '117' AND old_act = 'IPC' AND old_section = '322';
UPDATE statute_correspondence SET new_section = '117(2)' WHERE new_act = 'BNS' AND new_section = '117' AND old_act = 'IPC' AND old_section = '325';

-- BNS 118(1) "... voluntarily causes hurt by means of any instrument for shooting, stabbing or cutting ..." (IPC 324)
-- BNS 118(2) "... voluntarily causes grievous hurt by any means referred to in sub-section (1) ..." (IPC 326)
UPDATE statute_correspondence SET new_section = '118(1)' WHERE new_act = 'BNS' AND new_section = '118' AND old_act = 'IPC' AND old_section = '324';
UPDATE statute_correspondence SET new_section = '118(2)' WHERE new_act = 'BNS' AND new_section = '118' AND old_act = 'IPC' AND old_section = '326';

-- BNS 124(1) "Whoever causes permanent or partial damage or deformity to ... by throwing acid ..." (IPC 326A)
-- BNS 124(2) "Whoever throws or attempts to throw acid on any person or attempts to administer acid ..." (IPC 326B)
UPDATE statute_correspondence SET new_section = '124(1)' WHERE new_act = 'BNS' AND new_section = '124' AND old_act = 'IPC' AND old_section = '326A';
UPDATE statute_correspondence SET new_section = '124(2)' WHERE new_act = 'BNS' AND new_section = '124' AND old_act = 'IPC' AND old_section = '326B';

-- BNS 303(1) "Whoever, intending to take dishonestly any movable property ..." (IPC 378, theft defined)
-- BNS 303(2) "Whoever commits theft shall be punished ..." (IPC 379)
UPDATE statute_correspondence SET new_section = '303(1)' WHERE new_act = 'BNS' AND new_section = '303' AND old_act = 'IPC' AND old_section = '378';
UPDATE statute_correspondence SET new_section = '303(2)' WHERE new_act = 'BNS' AND new_section = '303' AND old_act = 'IPC' AND old_section = '379';

-- BNS 309(4) "Whoever commits robbery shall be punished with rigorous imprisonment ... ten years" (IPC 392)
-- BNS 309(5) "Whoever attempts to commit robbery shall be punished ... seven years" (IPC 393)
-- BNS 309(6) "If any person, in committing or in attempting to commit robbery, voluntarily causes hurt ..." (IPC 394)
UPDATE statute_correspondence SET new_section = '309(4)' WHERE new_act = 'BNS' AND new_section = '309' AND old_act = 'IPC' AND old_section = '392';
UPDATE statute_correspondence SET new_section = '309(5)' WHERE new_act = 'BNS' AND new_section = '309' AND old_act = 'IPC' AND old_section = '393';
UPDATE statute_correspondence SET new_section = '309(6)' WHERE new_act = 'BNS' AND new_section = '309' AND old_act = 'IPC' AND old_section = '394';

-- BNS 316(1) "Whoever, being in any manner entrusted with property ... dishonestly misappropriates ..." (IPC 405)
-- BNS 316(2) "Whoever commits criminal breach of trust shall be punished ... five years" (IPC 406)
-- BNS 316(3) "Whoever, being entrusted with property as a carrier, wharfinger or warehouse-keeper ..." (IPC 407)
-- BNS 316(4) "Whoever, being a clerk or servant or employed as a clerk or servant ..." (IPC 408)
-- BNS 316(5) "Whoever, being in any manner entrusted with property ... in his capacity of a public servant or
-- in the way of his business as a banker, merchant ..." (IPC 409)
UPDATE statute_correspondence SET new_section = '316(1)' WHERE new_act = 'BNS' AND new_section = '316' AND old_act = 'IPC' AND old_section = '405';
UPDATE statute_correspondence SET new_section = '316(2)' WHERE new_act = 'BNS' AND new_section = '316' AND old_act = 'IPC' AND old_section = '406';
UPDATE statute_correspondence SET new_section = '316(3)' WHERE new_act = 'BNS' AND new_section = '316' AND old_act = 'IPC' AND old_section = '407';
UPDATE statute_correspondence SET new_section = '316(4)' WHERE new_act = 'BNS' AND new_section = '316' AND old_act = 'IPC' AND old_section = '408';
UPDATE statute_correspondence SET new_section = '316(5)' WHERE new_act = 'BNS' AND new_section = '316' AND old_act = 'IPC' AND old_section = '409';

-- BNS 324(1) "Whoever with intent to cause, or knowing that he is likely to cause, wrongful loss or damage ..." (IPC 425)
-- BNS 324(2) "Whoever commits mischief shall be punished ... six months" (IPC 426)
UPDATE statute_correspondence SET new_section = '324(1)' WHERE new_act = 'BNS' AND new_section = '324' AND old_act = 'IPC' AND old_section = '425';
UPDATE statute_correspondence SET new_section = '324(2)' WHERE new_act = 'BNS' AND new_section = '324' AND old_act = 'IPC' AND old_section = '426';

-- BSA 23(2), proviso: "Provided that when any fact is deposed to as discovered in consequence of information
-- received from a person accused of any offence ..." (IEA 27). The main words of 23(2) bar a confession made
-- in police custody (IEA 26), the opposite rule; "IEA 27 = BSA 23(2)" pointed to it (M-IEA-007).
UPDATE statute_correspondence SET new_section = '23(2) proviso' WHERE new_act = 'BSA' AND new_section = '23(2)' AND old_act = 'IEA' AND old_section = '27';

-- ---------------------------------------------------------------------------
-- Check, and change nothing unless every row above landed.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
    n INTEGER;
    expected TEXT[][] := ARRAY[
        ['BNS', '189(1)', 'IPC', '141'], ['BNS', '189(2)', 'IPC', '142'], ['BNS', '189(2)', 'IPC', '143'],
        ['BNS', '103(1)', 'IPC', '302'], ['BNS', '106(1)', 'IPC', '304A'],
        ['BNS', '115(1)', 'IPC', '321'], ['BNS', '115(2)', 'IPC', '323'],
        ['BNS', '117(1)', 'IPC', '322'], ['BNS', '117(2)', 'IPC', '325'],
        ['BNS', '118(1)', 'IPC', '324'], ['BNS', '118(2)', 'IPC', '326'],
        ['BNS', '124(1)', 'IPC', '326A'], ['BNS', '124(2)', 'IPC', '326B'],
        ['BNS', '303(1)', 'IPC', '378'], ['BNS', '303(2)', 'IPC', '379'],
        ['BNS', '309(4)', 'IPC', '392'], ['BNS', '309(5)', 'IPC', '393'], ['BNS', '309(6)', 'IPC', '394'],
        ['BNS', '316(1)', 'IPC', '405'], ['BNS', '316(2)', 'IPC', '406'], ['BNS', '316(3)', 'IPC', '407'],
        ['BNS', '316(4)', 'IPC', '408'], ['BNS', '316(5)', 'IPC', '409'],
        ['BNS', '324(1)', 'IPC', '425'], ['BNS', '324(2)', 'IPC', '426'],
        ['BSA', '23(2) proviso', 'IEA', '27']
    ];
    i INTEGER;
BEGIN
    FOR i IN 1 .. array_length(expected, 1) LOOP
        IF NOT EXISTS (
            SELECT 1 FROM statute_correspondence
             WHERE new_act = expected[i][1] AND new_section = expected[i][2] AND old_act = expected[i][3] AND old_section = expected[i][4]
        ) THEN
            RAISE EXCEPTION 'missing % % -> % %', expected[i][3], expected[i][4], expected[i][1], expected[i][2];
        END IF;
    END LOOP;

    -- No old section above may still also map to the bare section.
    SELECT count(*) INTO n FROM statute_correspondence c
     WHERE (c.old_act, c.old_section) IN (('IPC','141'),('IPC','142'),('IPC','302'),('IPC','304A'),('IPC','321'),('IPC','323'),
                                          ('IPC','322'),('IPC','325'),('IPC','324'),('IPC','326'),('IPC','326A'),('IPC','326B'),
                                          ('IPC','378'),('IPC','379'),('IPC','392'),('IPC','393'),('IPC','394'),('IPC','405'),
                                          ('IPC','406'),('IPC','407'),('IPC','408'),('IPC','409'),('IPC','425'),('IPC','426'))
       AND c.new_section !~ '\(';
    IF n <> 0 THEN RAISE EXCEPTION '% old sections still map to a bare section', n; END IF;

    SELECT count(*) INTO n FROM statute_correspondence;
    IF n <> 1276 THEN RAISE EXCEPTION 'correspondence: % pairs, expected 1276 (1275 + IPC 143)', n; END IF;
END
$check$;

-- ---------------------------------------------------------------------------
-- To revert (run by hand):
--   DELETE FROM statute_correspondence WHERE new_act = 'BNS' AND new_section = '189(2)' AND old_act = 'IPC' AND old_section = '143';
--   UPDATE statute_correspondence SET new_section = split_part(new_section, '(', 1)
--    WHERE (new_act, old_act, old_section) IN (('BNS','IPC','141'), ('BNS','IPC','142'), ('BNS','IPC','302'), ('BNS','IPC','304A'),
--          ('BNS','IPC','321'), ('BNS','IPC','323'), ('BNS','IPC','322'), ('BNS','IPC','325'), ('BNS','IPC','324'), ('BNS','IPC','326'),
--          ('BNS','IPC','326A'), ('BNS','IPC','326B'), ('BNS','IPC','378'), ('BNS','IPC','379'), ('BNS','IPC','392'), ('BNS','IPC','393'),
--          ('BNS','IPC','394'), ('BNS','IPC','405'), ('BNS','IPC','406'), ('BNS','IPC','407'), ('BNS','IPC','408'), ('BNS','IPC','409'),
--          ('BNS','IPC','425'), ('BNS','IPC','426'));
--   UPDATE statute_correspondence SET new_section = '23(2)' WHERE new_act = 'BSA' AND new_section = '23(2) proviso';
-- ---------------------------------------------------------------------------
