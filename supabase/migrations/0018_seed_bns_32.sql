-- =============================================================================
-- 0007_seed_bns_32.sql
-- Seed BNS Section 32 (and its IPC equivalent) into the statutes table.
-- =============================================================================

INSERT INTO statutes (
    act_code, act_name, section_number, section_title, section_text,
    punishment, is_cognizable, is_bailable, is_compoundable, triable_by,
    corresponding_act, corresponding_section, chapter
) VALUES

('BNS', 'Bharatiya Nyaya Sanhita, 2023', '32', 'Act of child under seven years of age',
 'Nothing is an offence which is done by a child under seven years of age. This provision replaces section 82 of the Indian Penal Code, 1860.',
 NULL, NULL, NULL, NULL, NULL,
 'IPC', '82', 'Chapter III - General Exceptions'),

('IPC', 'Indian Penal Code, 1860', '82', 'Act of a child under seven years of age',
 'Nothing is an offence which is done by a child under seven years of age.',
 NULL, NULL, NULL, NULL, NULL,
 'BNS', '32', 'Chapter IV - General Exceptions')

ON CONFLICT (act_code, section_number, language) DO NOTHING;
