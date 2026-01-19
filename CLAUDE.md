# Project Instructions

## UI Components

**Always use latest Shopify Polaris web components** for all UI elements in this project.

### Polaris Web Components to Use:
- `<s-page>` - Page layout
- `<s-section>` - Content sections
- `<s-button>` - Buttons (with `variant="primary|secondary|tertiary"` and `tone="critical"`)
- `<s-select>` with `<s-option>` - Dropdowns
- `<s-text-field>` - Text and number inputs
- `<s-checkbox>` - Checkboxes
- `<s-stack>` - Layout stacking (`direction="inline|block"`)
- `<s-box>` - Container with padding/borders
- `<s-text>` - Text display
- `<s-badge>` - Status badges
- `<s-card>` - Card containers

### Event Handling:
- Use `onInput={(e: Event) => ...}` for input changes
- Cast targets: `(e.target as HTMLInputElement).value` or `(e.target as HTMLSelectElement).value`
- Use `onChange` for checkboxes

### Type Definitions:
- Custom Polaris type definitions are in `app/types/polaris.d.ts`

### Do NOT use:
- Native HTML `<button>`, `<select>`, `<option>`, `<input>` elements for forms
- Exception: `<input type="color">` is allowed (no Polaris equivalent)
- Exception: `<input type="datetime-local">` is allowed (no Polaris datetime picker)
- Exception: Preview components may use native inputs to demonstrate customer-facing UI
