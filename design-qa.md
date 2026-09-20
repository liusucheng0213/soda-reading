# 苏打阅读响应式网页设计 QA

## Evidence

- Source visual truth: `reference-reader.png`
- Mobile implementation: `qa-mobile-reader-day-new.png`, `qa-mobile-reader-night-new.png`
- Desktop implementation: `qa-web-home-1440.png`, `qa-web-reader-final-1440.png`
- Tablet implementation: `qa-web-home-1024-clip.png`
- Full-view normalized comparison: `qa-mobile-comparison-new.png`
- Focused word comparison: `qa-word-focus-responsive.png`
- Source pixels: `853×1844`; normalized to `390×844`
- Mobile implementation pixels/CSS viewport: `390×844`, DPR 1
- Desktop CSS viewport: `1440×900`; captured content `1439×855` because the in-app browser reserves its own chrome
- Desktop measured tracks: `224px / 916px / 300px`; text column `760px`
- State: day and night reader; selected word `seeking`; expanded sentence translation; provider-unavailable retry state

## Findings

No actionable P0/P1/P2 visual or interaction findings remain.

- Fonts and typography: Newsreader remains the reading face and Inter the interface face. Mobile preserves the source hierarchy; desktop increases body text to `22px / 37.4px` within a measured `760px` column.
- Spacing and layout rhythm: mobile retains the source’s compact header and editorial paragraph rhythm. Desktop uses the approved three-column layout without horizontal overflow; tablet collapses the right panel and narrows navigation.
- Colors and visual tokens: day mode retains warm ivory, charcoal, and muted mint. Night mode retains deep ink navy, warm gray, and restrained cyan with readable contrast.
- Image quality and assets: the reference contains no content imagery that needs recreation. Phosphor icons remain crisp UI assets; no placeholder illustrations or improvised SVG assets were added.
- Copy and content: product copy stays concise and reading-focused. The unverified Hangzhou quotation in the source mock remains intentionally excluded, matching the prior content-safety decision.
- Word and sentence interaction: word meaning stays directly beneath the selected word; sentence translation stays directly beneath its sentence. Desktop adds details in the right panel without replacing either inline interaction.

## Comparison History

1. Initial P1: desktop browsers were constrained to the `390px` phone frame.
   - Fix: replaced the fixed frame with responsive app and reader grids.
   - Evidence: `qa-web-home-1440.png`, `qa-web-reader-final-1440.png`; measured body scroll width equals the `1440px` viewport.
2. Initial P1: an unknown word could display “语境释义” as if translation succeeded.
   - Fix: introduced loading, contextual, basic, and retryable-error states; removed placeholder success.
   - Evidence: browser flow showed one visible “重试翻译” action for an unknown word and no console errors.
3. Initial P2: a slower previous request could overwrite a newly selected word.
   - Fix: added per-request cancellation and stale-response guards for word and sentence translation.
   - Evidence: repeated selection and toggle flows completed without stale UI or browser errors.
4. Post-fix comparison:
   - Word translation “寻求” appeared both beneath `seeking` and in the desktop study panel.
   - Clicking `seeking` again reduced exact “寻求” matches from two to zero; selecting it again restored both.
   - Sentence translation “独立书店不只是买书的地方。” appeared exactly once beneath its source sentence.

## Browser Verification

- Primary interactions tested: open daily article, select/hide/reselect word, expand sentence translation, show unknown-word retry, switch day/night mode, return to home.
- Responsive states checked: `390×844`, `1024×768`, `1440×900`.
- Desktop computed geometry: left navigation `224px`, center `916px`, right study panel `300px`, reading column `760px`.
- Browser console warnings/errors: none.
- Automated verification: frontend build passed, 5 frontend tests passed, 7 backend tests passed.

## Follow-up Polish

- P3: real provider responses may produce longer Chinese glosses than the local corpus; review interlinear wrapping after production keys are configured.

final result: passed
