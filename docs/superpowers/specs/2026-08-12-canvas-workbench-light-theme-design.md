# Canvas workbench light-theme design

## Scope

Restyle only the logged-in canvas workbench. Keep generation, provider configuration, node data, keyboard interaction, layouts, and other application pages unchanged. The existing dark theme remains functional; this work changes the light canvas theme and its canvas-local controls.

## Visual direction

The workbench follows the supplied reference: a restrained professional production tool, not a card-heavy creative dashboard. It has a slim top rail, a compact fixed generator panel on the left, an expansive centre canvas, a narrow media/history rail on the right, and floating viewport controls at bottom right. Near-white field, barely visible cool-grey dot grid, charcoal typography, paper-white controls, and soft neutral shadows create the baseline.

Accent colour is semantic and sparse:

- Selection and connection focus use a bright thin mint stroke (`#50D5BE` range), with a restrained translucent halo.
- Export and primary forward actions use warm orange (`#F36A2D` range).
- 4K/upscale settings use a violet outline (`#805AD5` range), not a filled purple control.
- Destructive/error colours retain their existing semantic red treatment.

## Components

### Canvas field

- Full-height white-to-very-light-grey surface with a dense, very low-contrast small dot grid.
- Remove the current blue/green abstract visual from local presentation surfaces in this workbench.
- Preserve pan, zoom, selection, connection, and background-mode behaviour.

### Nodes and selection

- White media cards with a light warm-grey hairline border and a broad, soft neutral shadow.
- Selected nodes use a 1.5px mint outline and small mint connection handles; do not flood node interiors with accent colour.
- Hover controls retain white surfaces and compact shadows. Their labels and icons remain dark charcoal.

### Toolbar and panels

- The header becomes a compact full-width tool rail. The project switcher and creation controls remain left-aligned; workspace and export/share controls remain right-aligned.
- The primary generation prompt/configuration panel is a fixed, compact card near the upper-left canvas edge rather than a wide bottom overlay. It contains model, prompt, ratio, quality, quantity, and generate action in a short vertical stack.
- The existing assets/history experience becomes a fixed right rail with compact tabs, filter/search header, and a dense two-column media thumbnail waterfall. It must not obstruct the centre canvas.
- Toolbar, inspector, prompt panel, and minimap controls use white surfaces, fine neutral-grey borders, 8–12px radii, and restrained shadows.
- Primary export affordance is orange. High-resolution / 4K badges or controls have a violet border and neutral fill.
- No new control is added; all changes are tokens, component styles, and asset treatment.

### Reference imagery and thumbnails

- Replace local showcase/default art used by the canvas with an apparel-oriented visual system: warm white, vermilion/orange-red garments, and restrained grey-blue secondary references.
- Right-side thumbnails use the same dense two-column arrangement and palette. User-uploaded and generated media remain untouched.

## Data and error handling

No canvas data shape, asset URL, generation payload, model choice, or error path changes. Missing or failed images continue to render their existing placeholder/error UI with the refreshed neutral shell.

## Acceptance criteria

1. Light canvas is near white with a visibly subtle grey dot grid at normal zoom.
2. Selecting an image/text/video node shows a thin mint border, not the current blue outline.
3. The top tool rail, left generator card, right asset/history rail, and bottom-right viewport controls are present without obscuring the centre canvas.
4. Canvas toolbar/panels are white with fine grey borders and soft shadows.
5. Export reads as orange and 4K/high-resolution treatment is violet-outline only.
6. Existing node creation, prompt editing, panning, zooming, selection, retry, and generation controls still work.
7. User media is not rewritten; only local/default showcase imagery changes.
8. Typecheck/build, relevant tests, and an in-app-browser visual pass succeed.
