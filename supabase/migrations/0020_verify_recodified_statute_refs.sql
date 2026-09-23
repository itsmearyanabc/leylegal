-- =============================================================================
-- 0020_verify_recodified_statute_refs.sql
--
-- "One or more references could not be verified against the case law database
-- and were removed" - under an answer about IPC 307 whose only removed
-- reference was "Section 109 of the BNS", which is exactly right.
--
-- ## Why it was removed
--
-- verify_statute_refs, the statutory half of the citation guardrail, only
-- accepted a section that is a row of its own. BNS 109 is not a row. It is the
-- equivalent recorded on IPC 307's row, in corresponding_act /
-- corresponding_section - the same mapping 0017 taught search_statutes to read.
-- The guardrail was never taught, so the database that knew BNS 109 was real
-- struck it from the answer as fabricated.
--
-- It also struck "BNS 103": the row is stored as "103(1)", and the comparison
-- was exact, so the section every advocate cites for murder under the BNS
-- failed on its own sub-clause.
--
-- ## What changes
--
-- A reference is verified if it is a row of its own or the recorded equivalent
-- of one. Nothing is added to what the database knows; the mapping was already
-- there and already relied on by search.
--
-- Sub-clauses: "103" and "103(1)" are the same section when either side names
-- no sub-clause - an advocate writing "BNS 103" cites a real section. Two
-- different sub-clauses ("103(2)" against a stored "103(1)") still do not
-- match, because nothing here says the other one exists.
--
-- Signature unchanged, so CREATE OR REPLACE is enough and the caller does not
-- move.
-- =============================================================================

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
        ) c
       ORDER BY c.preference
       LIMIT 1
  ) m ON TRUE;
$$;

COMMENT ON FUNCTION verify_statute_refs IS
    'Citation guardrail for statutes. A reference is real if it is a row of its own or the recodified equivalent recorded on a row (corresponding_act/corresponding_section), so BNS 109 verifies through IPC 307.';
