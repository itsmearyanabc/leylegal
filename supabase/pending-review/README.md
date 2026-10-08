# Migrations waiting for review

Files here are **not applied**. `scripts/deploy.sh` runs `npm run db:migrate`, which applies every file in `supabase/migrations/` - so a migration that must not run yet is kept here instead.

## 0022_correspondence_subsections.sql

Sub-sections in the official IPC/IEA → BNS/BSA correspondence (24 rows), IEA 27 → BSA 23(2) proviso, and the missing IPC 143 → BNS 189(2). It is legal data and needs a lawyer's sign-off against the bare acts before it ships.

Checked mechanically on 8 Oct 2026 against `0021_official_statute_text.sql`: every row it updates exists there, and each target sub-section of the Gazette text opens with the words the file quotes. That is not a legal review.

The code that uses it is already live and works without it: until it is applied, those answers name the section rather than the sub-section.

**To apply after sign-off:** move the file into `supabase/migrations/`, commit, and deploy. It runs in one transaction and checks itself (26 pairs present, 1,276 rows in all); a failed check changes nothing. The revert statements are at the end of the file.
