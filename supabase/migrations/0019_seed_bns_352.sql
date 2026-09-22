-- =============================================================================
-- 0008_seed_bns_352.sql
-- Seed BNS Section 352 (and its IPC equivalent) into the statutes table.
-- =============================================================================

INSERT INTO statutes (
    act_code, act_name, section_number, section_title, section_text,
    punishment, is_cognizable, is_bailable, is_compoundable, triable_by,
    corresponding_act, corresponding_section, chapter
) VALUES

('BNS', 'Bharatiya Nyaya Sanhita, 2023', '352', 'Intentional insult with intent to provoke breach of peace',
 'Whoever intentionally insults, and thereby gives provocation to any person, intending or knowing it to be likely that such provocation will cause him to break the public peace, or to commit any other offence, shall be punished with imprisonment of either description for a term which may extend to two years, or with fine, or with both.',
 'Imprisonment for 2 years, or fine, or both', 'Non-cognizable', 'Bailable', 'Compoundable', 'Any Magistrate',
 'IPC', '504', 'Chapter XXII - Of Criminal Intimidation, Insult, Annoyance, Defamation, Etc'),

('IPC', 'Indian Penal Code, 1860', '504', 'Intentional insult with intent to provoke breach of the peace',
 'Whoever intentionally insults, and thereby gives provocation to any person, intending or knowing it to be likely that such provocation will cause him to break the public peace, or to commit any other offence, shall be punished with imprisonment of either description for a term which may extend to two years, or with fine, or with both.',
 'Imprisonment for 2 years, or fine, or both', 'Non-cognizable', 'Bailable', 'Compoundable', 'Any Magistrate',
 'BNS', '352', 'Chapter XXII - Of Criminal Intimidation, Insult and Annoyance')

ON CONFLICT (act_code, section_number, language) DO UPDATE SET
    section_title = EXCLUDED.section_title,
    section_text = EXCLUDED.section_text,
    punishment = EXCLUDED.punishment,
    is_cognizable = EXCLUDED.is_cognizable,
    is_bailable = EXCLUDED.is_bailable,
    is_compoundable = EXCLUDED.is_compoundable,
    triable_by = EXCLUDED.triable_by,
    corresponding_act = EXCLUDED.corresponding_act,
    corresponding_section = EXCLUDED.corresponding_section;
