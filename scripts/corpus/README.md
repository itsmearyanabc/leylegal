# Statute corpus: BNS, BNSS, BSA and the official correspondence

These scripts produced `supabase/migrations/0021_official_statute_text.sql`. They
are offline tooling (Python 3.11, `pdfplumber`, `pdftotext`) - nothing here runs in
the app.

## Sources

Put these in `scripts/corpus/raw/` (git-ignored) under the names shown:

| File | Source | sha256 (first 16) |
|---|---|---|
| `bns-2023.pdf` | Gazette copy, Ministry of Home Affairs: `mha.gov.in/sites/default/files/250883_english_01042024.pdf` | `c9da896e7a16c481` |
| `bnss-2023.pdf` | `mha.gov.in/sites/default/files/250884_2_english_01042024.pdf` | `5e60e2afe30d0fe7` |
| `bsa-2023.pdf` | `mha.gov.in/sites/default/files/250882_english_01042024.pdf` | `13e2b6eb66add222` |
| `table-bns-ipc.pdf` | BPR&D: `bprd.nic.in/uploads/pdf/COMPARISON%20SUMMARY%20BNS%20to%20IPC%20.pdf` | `3ad875b6162deb9d` |
| `table-bnss-crpc.pdf` | BPR&D: `bprd.nic.in/uploads/pdf/Comparison%20summary%20BNSS%20to%20CrPC.pdf` | `aa3e49147cf88141` |
| `table-bsa-iea.pdf` | BPR&D: `bprd.nic.in/uploads/pdf/Comparison%20Summary%20BSA%20to%20IEA.pdf` | `7693f293acb11ae5` |

India Code (indiacode.nic.in) refuses scripted downloads; the Home Ministry
publishes the same Gazette text.

## Steps

```
python scripts/corpus/parse_acts.py      # raw/*.pdf -> out/{bns,bnss,bsa}.jsonl, with counts and anomaly report
python scripts/corpus/parse_tables.py    # raw/table-*.pdf -> out/map-*.jsonl, subject-vs-title cross-check
python scripts/corpus/verify_full.py     # optional: word-for-word against Indian Kanoon "Entire Act" pages saved as entire-{bns,bnss,bsa}.html
python scripts/corpus/build_migration.py # out/*.jsonl -> the migration
```

`parse_acts.py` documents every layout fact it relies on (all measured on these
PDFs): the page header band, the body column, the alternating margin for section
titles, the per-page offset (BSA page 1), word gaps (0.8pt in the body; per line in
the margins), and where the Acts end (Schedules; the rule before the signatory).
A section starts only at the next expected number, and every word is classified -
anything that fits no region is reported, never guessed.

## Known, deliberate departures from the PDF

- **BNSS 359**: its two tables are replaced by a note. Their cells are printed at
  heights that do not match their rows; pairing an offence with the wrong section
  would be worse than leaving the table out.
- **BNSS 480(2)**: the PDF prints the "n" of "on" at the end of a later line; the
  enacted wording "Court, on the execution by him of a bond" is restored (checked
  against India Code via Indian Kanoon).
- Classification (punishment, cognizable, bailable, triable by) is not taken from
  the BNSS First Schedule: that table cannot be read reliably either.
