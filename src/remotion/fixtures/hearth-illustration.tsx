// Production MVP Wave C1 -- the deterministic media fixture the first composition renders inside its
// MediaFrame.
//
// SOURCE-CONTROLLED AND DRAWN, not photographed. Three reasons, in order of importance:
//
//   1. DETERMINISM. Every coordinate below is a literal. There is no fetch, no staticFile(), no
//      decode of a binary whose bytes could differ between checkouts, and nothing that varies with
//      the machine. The same commit draws the same pixels.
//
//   2. ARTIFACT HYGIENE. A committed JPEG would be a binary fixture in a repository that has no
//      binary-fixture policy. This is 60 lines of source that diff, review and merge like source.
//
//   3. IT IS NOT PRETENDING. Wave C1 is a Production Engine proof, and the brief says so plainly:
//      product-photo realism is not the thing being proved. A drawn plate states honestly that the
//      picture is a stand-in, where a stock photograph would invite the render to be judged as
//      finished creative.
//
// C2 replaces this with a real <CanvasImage> or <Video> inside the same MediaFrame. The frame takes
// children and does not know what it holds, so that swap touches this file and nothing else.
//
// The line quality is deliberately imperfect -- the arcs are asymmetric and the strokes are round-
// capped and slightly uneven -- because the creative direction asks for a handmade character, and a
// mathematically perfect circle is the fastest way to lose it.

export function HearthIllustration() {
  return (
    <svg viewBox="0 0 800 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="presentation">
      {/* Morning light. Sits behind everything and is cropped by the frame on purpose. */}
      <circle cx="404" cy="352" r="238" fill="#E9C99C" />
      <circle cx="404" cy="352" r="238" fill="none" stroke="#2E2117" strokeOpacity="0.07" strokeWidth="3" />

      {/* The table line. One stroke, slightly off-level, which is what stops the plate floating. */}
      <path d="M 42 742 C 268 733, 546 736, 762 745" fill="none" stroke="#2E2117" strokeOpacity="0.16" strokeWidth="4" strokeLinecap="round" />

      {/* A scored bun, set back and to the left. */}
      <path
        d="M 176 700 C 128 700, 104 668, 108 636 C 113 596, 152 570, 198 570 C 246 570, 284 597, 287 637 C 290 670, 264 700, 216 701 Z"
        fill="#D9A469"
        stroke="#2E2117"
        strokeOpacity="0.22"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path d="M 152 640 C 178 622, 214 621, 244 637" fill="none" stroke="#B4551F" strokeOpacity="0.55" strokeWidth="5" strokeLinecap="round" />
      <path d="M 162 668 C 186 653, 218 652, 240 664" fill="none" stroke="#B4551F" strokeOpacity="0.38" strokeWidth="4" strokeLinecap="round" />

      {/* The cup. Handle first so the body overlaps it, which reads as drawn rather than assembled. */}
      <path
        d="M 566 592 C 622 584, 648 612, 640 646 C 632 680, 596 690, 566 682"
        fill="none"
        stroke="#2E2117"
        strokeOpacity="0.62"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="M 398 570 L 578 570 C 574 640, 562 692, 546 716 C 522 726, 452 727, 428 716 C 412 691, 401 639, 398 570 Z"
        fill="#FBF4E9"
        stroke="#2E2117"
        strokeOpacity="0.62"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      {/* The coffee itself: an ellipse seen from just above the rim. */}
      <ellipse cx="488" cy="574" rx="88" ry="17" fill="#4A2C16" />
      <path d="M 424 570 C 452 562, 528 562, 553 570" fill="none" stroke="#FBF4E9" strokeOpacity="0.5" strokeWidth="4" strokeLinecap="round" />

      {/* Saucer. */}
      <ellipse cx="488" cy="732" rx="132" ry="24" fill="#F2E6D4" stroke="#2E2117" strokeOpacity="0.45" strokeWidth="6" />

      {/* Two crumbs. The whole point of them is that a perfectly clean table is not a bakery. */}
      <circle cx="654" cy="762" r="7" fill="#B4551F" fillOpacity="0.5" />
      <circle cx="686" cy="776" r="4" fill="#B4551F" fillOpacity="0.35" />
    </svg>
  );
}
