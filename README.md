# CV Builder

The app is English by default; use the EN / BS toggle in the header for Bosnian (the choice is saved). The language also controls what the AI writes (tailored CV, analysis, search finds).

1. **Profile**: import an existing CV (PDF, Word, text, image; you review before it is added) or write everything about yourself (education, experience, projects, research, awards, skills, other).
2. **Positions**: paste a posting (internship, job, research position) with its deadline and date posted, or track one from **Discover**.
3. **Tailor**: the AI builds a CV for that position from your profile, with a fit score, what is missing and how to fix it.
4. **Discover**: a daily collector (GitHub lists, Greenhouse, Lever, Recruitee, Workable, EURAXESS) plus an on-demand AI search for internships, research positions, grants and spring weeks. Filter by type and region; expired postings are hidden.

Results are saved to `results/<id>.json` in the app storage.

Export: when tailoring, the AI attaches a PDF and an editable Word file (.docx) via `cv-cli.mjs`. User data lives in app storage, not in the source, so the app can be shared.

## Notes for new users

- Fill in **Citizenship / work authorisation** in your Profile so visa checks are accurate. Without it the AI will not assume anything.
- The Discover region filter is currently Balkan-first (BiH, Serbia, Croatia, Balkans, Europe, Asia, Americas, Remote). Add your own companies under **Sources**.
- AI is only used when you press Tailor CV, Check visa or AI search.

License: MIT.
