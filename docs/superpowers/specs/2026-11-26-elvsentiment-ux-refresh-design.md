# ELVsentiment UI and UX Refresh

The refresh makes Cari sekarang comfortable on phones and faster to scan on desktop. The second release connects a result to a deliberate review decision in an existing Pantau project.

## Visual and interaction direction

- Retain ELVsentiment blue, Inter, and the Indonesian interface. Use soft neutral surfaces, fewer card borders, 16 px base reading text, and restrained metadata. Give the query, post, and next action the strongest hierarchy.
- Below 768 px, use one content column and keep the query and filter entry point within reach. At 1,024 px and above, use a secondary summary column when evidence exists. At widths from 320 px through desktop, the page fits without horizontal scrolling.
- Interactive targets in the redesigned areas have a 44 by 44 px minimum hit area. Focus remains visible and unobscured. Dialogs restore focus and support Escape. Convey source and sentiment states with text as well as color.
- Use CSS motion from 150 to 250 ms, with 180 ms as the default. Count and bar changes, newly visible cards, and disclosure transitions can animate once per change. Reduced motion removes these effects. Feedback remains visible as text.
- Verify at 320, 390, 768, and 1,280 px, with keyboard navigation and reduced motion included.

## Cari search experience

1. Fit the page and shared shell to phone widths. Use a single reading column with a compact mobile header and a drawer for the existing navigation.
2. Keep a compact search form reachable on the result page. Open Tanggal, Urutkan, and Bahasa in one mobile filter sheet. Show removable chips for nondefault choices and a reset. Apply changed filters to the next submitted search and continue showing the saved filters on the current receipt.
3. Apply the shared visual system to Cari, Riwayat, and the shared workspace shell. Extend the same treatment to the Pantau review screens in the second release.
4. Lead progress with matched posts and source completion. Show the first available posts during collection and make detailed coverage optional after results arrive. Keep source, comment, and summary progress distinct.
5. Use motion for source counts and bars, newly revealed results, and reply or summary disclosures. Focus and scroll position survive polling.
6. Use consistent result cards with clearly labeled original-post links, platform, author, date, engagement, and replies. Keep internal citation anchors available when the permalink is missing or unsafe.
7. Place Cari lagi beside each eligible platform in source details and the selected platform header. Preserve its position while pending, keep the current scroll anchor on append, and announce the number of newly matched posts.
8. Show one summary takeaway and evidence links, with expandable themes, platform analysis, and verbatim quotes. Reuse existing evidence validation and support internal links to a cited post or reply.
9. Distinguish an empty search, limited index coverage, a source failure, and an interrupted connection. Use existing recovery actions with explicit user initiation. Offer source-specific retry only if an existing action supports it in that state.

## Pantau review experience

10. Add Tinjau to supported Cari results. Show the retained post and any existing complaint judgment with its supporting evidence. In an eligible active project, allow a manual choice of Perlu perhatian or Belum yakin, with Undo and continued access to the search at the same scroll position. Use the existing active project and safe import rules. When the post or project cannot be admitted, explain why and offer project onboarding where it applies.

## Release boundaries

- Release 1 is a web UI update. Preserve current search filters, billing, provider requests, polling, saved history, and original-link validation.
- Release 2 writes a customer-scoped manual routing choice tied to the project mention. Keep that decision distinct from the automatic judgment. Undo restores the prior manual choice or the automatically derived queue.
- Keep X provider investigation outside these releases. Use deterministic fixtures before any explicitly initiated live staging smoke test.
