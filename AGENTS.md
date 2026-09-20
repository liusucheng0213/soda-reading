# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable Soda Reading decisions

- Use the selected combined mock at `reference-reader.png` as the reader source of truth.
- Day mode uses warm ivory paper, charcoal text, and muted mint accents; night mode uses deep ink navy, warm gray text, and restrained cyan accents.
- A tapped word, or a short dragged phrase, shows its Chinese contextual gloss directly underneath as an interlinear annotation using CSS ruby (`ruby-position: under`). The gloss must reserve line space and must not overlay the next English line. While dragging, keep each word in place and only underline the range; collapse the phrase after the pointer is released. If the common dictionary sense differs, show it as a quieter second line labeled 常见. Pronouns and demonstratives (`it`, `those`, `these`) show only what they refer to in the text, labeled 文中指代; do not show a dictionary 常见义 for these or other tiny function words. Never use a popover, tooltip, card, drawer, or bottom sheet for word translation.
- The desktop study panel labels 语境义 or 文中指代, and 常见义 only when a content word’s dictionary sense clearly differs; it complements the interlinear gloss and does not replace it.
- Word translation defaults to DeepSeek. Admins may add cheaper OpenAI-compatible endpoints in the model router, with fill-in help text. Keys stay in `backend/data/provider_overrides.json`.
- Collection (采集) fetches licensed originals; validation (验证) is automatic license/language/length/freshness checks, not a human review queue. Show 通过/抓取 on the admin home ingest card. Small refreshes use a fast source set and publish to the feed.
- Chinese Wikipedia featured excerpts may be translated into CEFR-controlled accurate English and shown as reading texts.
- Do not keep an unused 人工复核队列 on the admin surface. Admin sidebar tabs must switch panels; the 返回阅读端 control stays visible on mobile.
- A tapped sentence-ending marker inserts the Chinese sentence translation immediately beneath that English sentence; tapping again hides it.
- Do not put a source disclaimer footer under the article body.
- The home feed shows a Chinese introduction for each licensed original article.
- Keep the reading surface immersive and editorial. Avoid feature-card grids, decorative bubbles, gradients, gamification, and heavy shadows.
- Homepage CEFR is a live control, not a badge. Switching A2 / B1 / B2 / C1 must change the featured article. Rank exact CEFR first; if the live pool lacks that level, inject a full-paragraph library piece of that level. Do not open a different article when the chosen piece has no body.
- Persist reading prefs locally: typeface, font scale, line height, measure, and theme (day / sepia / night). Offer continue-reading when a piece is in progress.
- Do not put pipeline, license, privacy, or CEFR-match lectures on reading surfaces (home, library, reader, profile). Collection/validation copy stays on `/admin` only.
- Reader tools stay editorial: persistent 划线, full-article read-aloud, in-article find, copy original sentence, and remaining minutes. No streaks, XP, or gamification.
