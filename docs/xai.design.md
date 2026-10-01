---
version: alpha
name: xAI
website: "https://x.ai"
description: An inspired interpretation of xAI's design language — Elon Musk's frontier-AI company whose web surface is a strict near-black canvas broken only by white pill outlines, occasional warm sunset / dusk gradient accents, a custom geometric sans (Universal Sans) for display, and an uppercase tracked monospace caption face; the whole system reads as engineered-cosmic, unmarketed.

seo:
  title: "xAI Design System for React — #0a0a0a canvas, Universal Sans, 28 components"
  metaDescription: "xAI's design system as a DESIGN.md file. Canvas #0a0a0a, Universal Sans + Geist Mono, 17 colors, 28 components. For React, Next.js, and AI tools."
  highlights:
    - "Single near-black canvas — #0a0a0a edge-to-edge, with no light-mode counterpart anywhere on the marketing surface"
    - "Pill is the entire interactive shape — every button uses rounded 9999px with a 1px translucent-white border"
    - "Display sits at weight 400 with -2.4px tracking at 96px — the brand never bolds anywhere in the type ladder"
    - "Two-face contrast — Universal Sans sentence-case display paired with Geist Mono uppercase eyebrows at 1.4px tracking"
    - "Hairline borders carry all elevation — no drop shadows exist anywhere in the 28-component system"
  tags:
    - "AI & LLM Platforms"
  lastUpdated: "2026-05-12"
  author:
    name: "Dov Azencot"
    url: "https://x.com/dovazencot"
  opening: |
    xAI is Elon Musk's frontier-AI lab, and the marketing surface wears that posture with engineered restraint. The base canvas is a single near-black #0a0a0a edge-to-edge, broken only by white outline pills and the occasional warm sunset-orange or dusk-purple accent inside product illustrations. There is no gradient hero, no atmospheric backdrop, no product screenshot — the site reads as a research lab announcing its work rather than a SaaS marketing page. The shape language is even more austere than the palette: every interactive element is a 9999px pill with a 1px translucent-white border, and cards are tight 8px rectangles in #191919 with hairline #212327 dividers. No shadows exist in the system. Display headlines render in Universal Sans at weight 400 with aggressive -2.4px tracking at 96px, while uppercase Geist Mono carries every section eyebrow at 14px with positive 1.4px tracking. The two-face contrast is the brand voice.

    This page packages the system into a single DESIGN.md file in the Google Labs format. Inside: 17 color tokens grouped into surface, text, hairline, and a muted accent palette (sunset #ff7a17, dusk #7c3aed, twilight #c4b5fd, breeze #a0c3ec, midnight #0d1726); 11 typography tokens covering display-xl through caption-mono-sm at one weight (400); a 4-step radius scale (0, 8px, 9999px pill, 9999px full); a 9-step spacing system from 2px to 64px; and 28 components covering buttons, cards, inputs, navigation, hero/content bands, and 10 illustrative example surfaces (pricing tiers, app shell rows, data-table cells, auth cards, modals, toasts). Every value is quoted, every reference uses the DESIGN.md token-substitution syntax.

    Feed the file to Claude, Cursor, or GitHub Copilot and the agent reproduces xAI's restraint — the dark canvas, the outline pills, the weight-400 display with negative tracking — rather than generating a generic dark theme with bolded headings and filled buttons. Reference the tokens directly in Tailwind config or CSS variables when you want the engineered-cosmic posture without the chrome of a conventional SaaS marketing site. The system is worth studying because it commits hard to one shape (the pill), one weight (400), and one surface (#0a0a0a) — the discipline of refusing every easy decorative escape hatch is what makes the brand read as a research lab.
  related:
    - href: "https://github.com/google-labs-code/design.md"
      title: "The DESIGN.md specification"
      description: "Google Labs' open spec for machine-readable design system files — the format this page is built on."
    - href: "/design"
      title: "Browse all design systems"
      description: "The full directory of DESIGN.md files on shadcn.io, with live mockups for each."
    - href: "/blocks"
      title: "React blocks for shadcn/ui"
      description: "Production-ready hero, pricing, CTA, and dashboard sections built with Tailwind + shadcn primitives."
  questions:
    - id: "primary-color"
      title: "What is xAI's primary brand color?"
      answer: "xAI's signature is white #ffffff on near-black #0a0a0a — the brand uses no chromatic primary on the marketing surface. White carries every display headline, every outline-pill border, and the rare filled CTA on Sign Up. A muted accent palette of sunset-orange #ff7a17, dusk-purple #7c3aed, twilight #c4b5fd, and breeze-blue #a0c3ec exists in the tokens but appears only inside product illustrations and icons, never as a primary CTA tone."
    - id: "dark-mode"
      title: "Does xAI's design system have a light mode?"
      answer: "No — xAI is dark-canvas only. Every public marketing surface uses #0a0a0a as the page floor, with a slightly lighter #1a1c20 for hover states and #191919 for card fills. The DESIGN.md file does not document a light-mode counterpart because none exists on the brand's public web. Introducing one would break the engineered-cosmic posture the system is built around."
    - id: "typography"
      title: "What typography does xAI use, and what should I use if Universal Sans isn't available?"
      answer: "xAI runs Universal Sans, a proprietary geometric sans, for every display and body role at weight 400 only. Geist Mono handles uppercase section eyebrows and metric counters at 14px with 1.4px positive tracking. The brand never bolds — negative letter-spacing (-2.4px at 96px down through the display ladder) does the emphasis work instead. Inter at weight 400 with -0.04em to -0.02em tracking is the closest open-source substitute for the display face; Geist Mono itself is open source and used as documented."
    - id: "pill-shape"
      title: "Why is every button a pill on xAI's site?"
      answer: "The 9999px pill (token rounded.pill) is the brand's universal interactive shape — every button, every nav CTA, every Read anchor uses the same translucent-white outline pill with a 1px border. There is one exception: the Sign Up CTA renders as a rare white-filled pill instead of outlined. The commitment to one shape across 'Try Grok', 'Read announcement', 'Custom Voices', and every action link is the visual signature of the system — varying the shape would dilute it."
    - id: "use-in-project"
      title: "Can I use this DESIGN.md to build my own React AI product?"
      answer: "Yes — the file is designed to be fed into Claude, Cursor, or any AI tool that reads structured design tokens. The agent will reproduce xAI's restraint (dark canvas, outline pills, weight-400 display, no shadows) rather than a generic dark theme. You can also reference the tokens directly: every color, typography style, radius, and spacing value is a quoted value you can paste into Tailwind config, CSS variables, or your own component library."
    - id: "known-gaps"
      title: "What's missing from this DESIGN.md spec?"
      answer: "A handful of items, documented in the Known Gaps section: the runtime translucent-white border color on outline pills (the spec stores hairline #212327, but the live site uses rgba(255,255,255,0.25) at render); the precise sunset-to-dusk gradient stops used inside product illustrations; loading states and skeleton screens; the Universal Sans variable-font axes; and the focus-ring treatment on text inputs. The spec captures the marketing surface posture but not every nested product canvas (Grok chat, API console)."

colors:
  primary: "#ffffff"
  on-primary: "#0a0a0a"
  ink: "#ffffff"
  ink-hover: "#fafaf7"
  body: "#dadbdf"
  body-mid: "#7d8187"
  mute: "#7d8187"
  hairline: "#212327"
  canvas: "#0a0a0a"
  canvas-soft: "#1a1c20"
  canvas-card: "#191919"
  canvas-mid: "#363a3f"
  accent-sunset: "#ff7a17"
  accent-sunset-soft: "#ffc285"
  accent-dusk: "#7c3aed"
  accent-twilight: "#c4b5fd"
  accent-breeze: "#a0c3ec"
  accent-midnight: "#0d1726"

typography:
  display-xl:
    fontFamily: universalSans, Inter, system-ui, -apple-system, sans-serif
    fontSize: 96px
    fontWeight: 400
    lineHeight: 96px
    letterSpacing: -2.4px
  display-lg:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 72px
    fontWeight: 400
    lineHeight: 72px
    letterSpacing: -1.8px
  display-md:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 48px
    fontWeight: 400
    lineHeight: 48px
    letterSpacing: -1.2px
  display-sm:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 32px
    fontWeight: 400
    lineHeight: 36px
    letterSpacing: -0.6px
  display-xs:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 20px
    fontWeight: 400
    lineHeight: 28px
  body-lg:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 18px
    fontWeight: 400
    lineHeight: 28px
  body-md:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  body-sm:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  caption-mono:
    fontFamily: GeistMono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 1.4px
  caption-mono-sm:
    fontFamily: GeistMono, ui-monospace, SFMono-Regular, Menlo, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 1.2px
  button-md:
    fontFamily: universalSans, Inter, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px

rounded:
  none: 0px
  sm: 8px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  4xl: 64px

components:
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    padding: "{spacing.md} {spacing.xl}"
  nav-link:
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    borderColor: "{colors.primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.pill}"
    padding: "{spacing.xs} {spacing.md}"
  button-outline-on-dark:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.button-md}"
    rounded: "{rounded.pill}"
    padding: "{spacing.sm} {spacing.lg}"
  button-outline-sm:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.button-md}"
    rounded: "{rounded.pill}"
    padding: "{spacing.xs} {spacing.md}"
  text-input:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md} {spacing.lg}"
  card-content:
    backgroundColor: "{colors.canvas-card}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  card-feature-product:
    backgroundColor: "{colors.canvas-card}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  hero-band:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-xl}"
    padding: "{spacing.4xl} {spacing.xl}"
  content-band:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-md}"
    padding: "{spacing.4xl} {spacing.xl}"
  eyebrow-mono:
    textColor: "{colors.ink}"
    typography: "{typography.caption-mono}"
  divider-hairline:
    borderColor: "{colors.hairline}"
  footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    padding: "{spacing.3xl} {spacing.xl}"

  # ─── Examples (illustrative) — auto-derived; resolve any TO_FILL markers below ───
  ex-pricing-tier:
    description: "Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface."
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  ex-pricing-tier-featured:
    description: "Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode)."
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  ex-product-selector:
    description: "What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery)."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  ex-cart-drawer:
    description: "Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart)."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
    item-divider: "{colors.hairline}"
  ex-app-shell-row:
    description: "Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator."
    backgroundColor: "{colors.canvas}"
    activeIndicator: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md} {spacing.lg}"
  ex-data-table-cell:
    description: "Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm."
    headerBackground: "{colors.canvas-soft}"
    headerTypography: "{typography.caption-mono}"
    bodyTypography: "{typography.body-sm}"
    cellPadding: "{spacing.md} {spacing.lg}"
    rowBorder: "{colors.hairline}"
  ex-auth-form-card:
    description: "Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  ex-modal-card:
    description: "Modal dialog surface — same chrome as feature-card with elevated shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xl}"
  ex-empty-state-card:
    description: "Empty-state illustration frame."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.sm}"
    padding: "{spacing.3xl}"
    captionTypography: "{typography.body-md}"
  ex-toast:
    description: "Toast notification surface — feature-card shape + medium shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md} {spacing.lg}"
    typography: "{typography.body-sm}"

---

## Overview

xAI is Elon Musk's frontier-AI lab, and the website wears that posture with engineered restraint: a near-black canvas `{colors.canvas}` (`#0a0a0a`) edge-to-edge, white outline pills as every interactive element, and a single proprietary geometric sans `Universal Sans` carrying every display headline at weight 400. There is no gradient hero, no atmospheric backdrop, no product screenshot. The brand reads as confidently sparse — a research lab announcing its work rather than a SaaS marketing site.

Type is the second decisive voice. `Universal Sans` carries every display at weight 400 (regular) with aggressive negative tracking (`-2.4px` at 96px, scaling down through the display ladder). For technical labels, eyebrows, and metric counters, the brand pairs `Geist Mono` (uppercase, 1.4px positive tracking) — every section eyebrow reads as a code comment more than a marketing label.

Every interactive element is a pill (`{rounded.pill}` 9999px) with a 1px white-translucent border `rgba(255, 255, 255, 0.25)`. The button shape never varies — the same translucent-white pill carries "Try Grok", "Read announcement", "Custom Voices", "Sign up now", and every "Read" anchor. The pill is the entire shape system.

**Key Characteristics:**
- A single near-black canvas (`{colors.canvas}` `#0a0a0a`) with white outline pills as the entire interactive vocabulary.
- Universal Sans weight 400 for display, Geist Mono uppercase tracked for labels — the two-face contrast IS the brand voice.
- Every button is a `{rounded.pill}` outline with translucent-white border. The brand never uses filled CTAs except for one variant (white-filled pill on Sign Up).
- Cards are tight `{rounded.sm}` 8px rectangles in a slightly-lighter `{colors.canvas-card}` (`#191919`) fill with hairline border. No shadows.
- A muted accent palette of sunset-orange `#ff7a17` / dusk-purple `#7c3aed` / twilight-violet `#c4b5fd` / breeze-blue `#a0c3ec` lives in the design tokens but appears rarely on the main marketing surface — reserved for product illustrations / icons.
- Massive negative letter-spacing on display headlines (`-2.4px` at 96px) gives the typography a precise, gathered look.

## Colors

### Brand & Accent
- **White** (`{colors.primary}` — `#ffffff`): The brand's primary "color" — used as button outline, button-primary fill, all display text. The brand's signature is white-on-near-black.
- **Sunset Orange** (`{colors.accent-sunset}` — `#ff7a17`): A warm orange used inside product illustrations and accent moments.
- **Sunset Soft** (`{colors.accent-sunset-soft}` — `#ffc285`): The lighter variant of the sunset accent.
- **Dusk Purple** (`{colors.accent-dusk}` — `#7c3aed`): Deep purple used inside product illustrations.
- **Twilight** (`{colors.accent-twilight}` — `#c4b5fd`): Soft violet — illustrative accent.
- **Breeze Blue** (`{colors.accent-breeze}` — `#a0c3ec`): Soft blue — illustrative accent.
- **Midnight** (`{colors.accent-midnight}` — `#0d1726`): Deep blue-black for illustrative backgrounds.

### Surface
- **Canvas** (`{colors.canvas}` — `#0a0a0a`): The default near-black page background. The brand's only true surface.
- **Canvas Soft** (`{colors.canvas-soft}` — `#1a1c20`): A slightly lighter dark fill used for hovered nav items and tooltips.
- **Canvas Card** (`{colors.canvas-card}` — `#191919`): The charcoal card fill used inside product-feature cards.
- **Canvas Mid** (`{colors.canvas-mid}` — `#363a3f`): A mid-dark used for nested surfaces and code mockup backgrounds.
- **Hairline** (`{colors.hairline}` — `#212327`): 1px solid dividers on dark surfaces.

### Text
- **Ink** (`{colors.ink}` — `#ffffff`): Default text on canvas — pure white.
- **Ink Hover** (`{colors.ink-hover}` — `#fafaf7`): Slightly off-white used for hover states (filtered out per no-hover policy in component specs).
- **Body** (`{colors.body}` — `#dadbdf`): Secondary body text — supporting copy in lighter weight.
- **Body Mid / Mute** (`{colors.body-mid}` — `#7d8187`): Mid-emphasis body and mute text — captions, fine print.

### Semantic
The brand doesn't surface a separate semantic palette on the marketing site. Validation cues use the white-on-canvas hierarchy.

## Typography

### Font Family
Two faces ladder the system:
1. **universalSans** — proprietary geometric sans used for every display, body, button, and link role. Weight 400 only on the marketing surface (the brand's restraint is part of the voice). Negative letter-spacing at display sizes is the visual signature.
2. **GeistMono** — used for uppercase section eyebrows, label captions, and metric counters. Positive tracking (1.2 – 1.4px) at 12 – 14px.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-xl}` | 96px | 400 | 96px | -2.4px | Maximum hero scale. |
| `{typography.display-lg}` | 72px | 400 | 72px | -1.8px | Sub-hero displays. |
| `{typography.display-md}` | 48px | 400 | 48px | -1.2px | Section headlines. |
| `{typography.display-sm}` | 32px | 400 | 36px | -0.6px | Card-cluster headings. |
| `{typography.display-xs}` | 20px | 400 | 28px | 0 | Inline displays. |
| `{typography.body-lg}` | 18px | 400 | 28px | 0 | Lead paragraphs. |
| `{typography.body-md}` | 16px | 400 | 24px | 0 | Default body. |
| `{typography.body-sm}` | 14px | 400 | 20px | 0 | Secondary body. |
| `{typography.caption-mono}` | 14px | 400 | 20px | 1.4px | Section eyebrow (GeistMono uppercase). |
| `{typography.caption-mono-sm}` | 12px | 400 | 16px | 1.2px | Small mono labels. |
| `{typography.button-md}` | 14px | 400 | 20px | 0 | Button label. |

### Principles
- **Weight 400 for everything.** The brand never bolds. Negative tracking + size hierarchy do the emphasis work.
- **Tight negative tracking on display sizes.** Reverting to neutral tracking loses the precision feel.
- **GeistMono uppercase for eyebrows.** Tracked positively (1.4px) to make the mono read as a code comment.

### Note on Font Substitutes
universalSans is proprietary. Open-source substitutes:
- **Display + body** — *Inter* weight 400 with `-0.04em` to `-0.02em` letter-spacing at display sizes comes closest. *Geist* is the second-best option.
- **Mono** — *Geist Mono* is the documented brand companion; *JetBrains Mono* or *IBM Plex Mono* are alternates.

## Layout

### Spacing System
- **Base unit**: 4px.
- **Tokens**: `{spacing.xxs}` 2px · `{spacing.xs}` 4px · `{spacing.sm}` 8px · `{spacing.md}` 12px · `{spacing.lg}` 16px · `{spacing.xl}` 24px · `{spacing.2xl}` 32px · `{spacing.3xl}` 48px · `{spacing.4xl}` 64px.
- **Section padding**: hero / content bands at `{spacing.4xl}` 64px on desktop.
- **Card interior padding**: `{spacing.xl}` 24px.

### Grid & Container
- Marketing content centres at ~1200px.
- Product / announcement card grid: 2-up at desktop, 1-up at mobile.

### Responsive Strategy

#### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 768px | Hero scales 96 → 48px; grids 1-up; hamburger nav. |
| Desktop | ≥ 768px | Full hero + 2-up grids. |

#### Touch Targets
Buttons render ~32 – 40px tall (8 vertical padding + 20 line). Mobile inflates touch area to meet WCAG 44 × 44px.

#### Image Behavior
The brand uses sparse SVG illustrations for product moments (Grok, Voice, API). No photography on the marketing surface.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Level 0 — Flat | No shadow, no border. | Default. |
| Level 1 — Hairline | 1px solid `{colors.hairline}` border. | Card chrome, button outlines (with translucent white). |

The brand uses no shadows. Hairline borders carry all elevation cues.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed bands. |
| `{rounded.sm}` | 8px | Card chrome (the brand's `--radius` value). |
| `{rounded.pill}` | 9999px | Every button — the brand's universal interactive shape. |
| `{rounded.full}` | 9999px | Circular icon containers. |

## Components

### Buttons

**`button-primary`** — the rare white-filled pill (used on a single Sign Up CTA).
- Background `{colors.primary}` white `#ffffff`, text `{colors.on-primary}` near-black `#0a0a0a`, 1px solid white border, label `{typography.button-md}`, padding `{spacing.xs} {spacing.md}`, shape `{rounded.pill}` 9999px.

**`button-outline-on-dark`** — the canonical white-outline pill, used for every non-primary CTA.
- Background `{colors.canvas}` (transparent in practice — `rgba(0,0,0,0)`), text `{colors.ink}` white, 1px solid `{colors.hairline}` `#212327` border (translucent white at runtime), same typography / padding scale / shape.

**`button-outline-sm`** — the smaller outline pill used in card-cluster CTAs.
- Same as `button-outline-on-dark` with tighter padding `{spacing.xs} {spacing.md}`.

### Cards & Containers

**`card-content`** — the default content card.
- Background `{colors.canvas-card}` (`#191919`), text `{colors.ink}`, 1px solid `{colors.hairline}` border, padding `{spacing.xl}`, shape `{rounded.sm}` 8px.

**`card-feature-product`** — the product-feature card (Grok / Voice / API).
- Same chrome as `card-content`. Hosts an SVG illustration + headline + body + outline pill CTA.

### Inputs & Forms

**`text-input`** — the standard text input on dark.
- Background `{colors.canvas-soft}` `#1a1c20`, text `{colors.ink}`, 1px solid `{colors.hairline}`, body in `{typography.body-md}`, padding `{spacing.md} {spacing.lg}`, shape `{rounded.sm}` 8px.

### Navigation

**`nav-bar`** — the sticky top nav.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.md} {spacing.xl}`.

**`nav-link`** — link items inside nav.
- Text `{colors.ink}`, set in `{typography.body-sm}`.

**`footer`** — the footer band.
- Background `{colors.canvas}`, text `{colors.body}` `#dadbdf`, padding `{spacing.3xl} {spacing.xl}`. Body in `{typography.body-sm}`.

### Signature Components

**`hero-band`** — the dark hero with massive display headline.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.4xl} {spacing.xl}`. Headline in `{typography.display-xl}` (96px weight 400 with `-2.4px` tracking).

**`content-band`** — the standard content section.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.4xl} {spacing.xl}`. Section headline in `{typography.display-md}` preceded by a `{typography.caption-mono}` UPPERCASE GeistMono eyebrow.

**`eyebrow-mono`** — the uppercase tracked GeistMono label above every section headline.
- Text `{colors.ink}`, set in `{typography.caption-mono}`. The brand's signature label style.

**`divider-hairline`** — the 1px line between section bands.
- 1px solid `{colors.hairline}` `#212327`.

### Examples (illustrative)

> Auto-derived kit-mirror demonstration surfaces (`scripts/derive-examples-block.mjs`). Each `ex-*` entry references brand-native primitives so downstream consumers (`/preview-design`, `/generate-kit`) re-skin the same 10 surfaces consistently.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface.
- Properties: `backgroundColor`, `textColor`, `borderColor`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode).
- Properties: `backgroundColor`, `textColor`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery).
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-cart-drawer`** — Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart).
- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator.
- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm.
- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — same chrome as feature-card with elevated shadow.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.
- Properties: `backgroundColor`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — feature-card shape + medium shadow.
- Properties: `backgroundColor`, `rounded`, `padding`, `typography`

## Do's and Don'ts

### Do
- Reserve `{colors.canvas}` (`#0a0a0a`) as the only page surface. The brand is dark-canvas only.
- Set hero headlines in `{typography.display-xl}` Universal Sans weight 400 with `-2.4px` tracking. The precision IS the voice.
- Use `{rounded.pill}` 9999px on every interactive element. The pill is the brand.
- Pair Universal Sans (sentence-case) with GeistMono UPPERCASE (eyebrows, labels, metric counters).
- Use white-translucent borders for outline buttons — the brand never uses solid white borders on its outline pill.

### Don't
- Don't introduce a light-mode counterpart. xAI is dark-canvas only.
- Don't bold display headlines. Weight 400 is the entire scale.
- Don't use filled buttons broadly. The brand uses outline pills almost exclusively; one Sign Up white-filled pill is the rare exception.
- Don't drop a drop-shadow on cards. Hairline borders carry elevation.
- Don't substitute Universal Sans with a generic geometric sans without adjusting letter-spacing. The negative tracking is part of the brand.

## Known Gaps

- **Runtime border color:** the spec stores `{colors.hairline}` `#212327` for outline-pill borders, but the live site renders translucent white `rgba(255, 255, 255, 0.25)` at runtime — the file does not document the alpha-channel translation.
- **Gradient illustration stops:** the sunset-to-dusk gradients used inside product illustrations (Grok, Voice) are not captured token-by-token; only the discrete accent colors (`{colors.accent-sunset}`, `{colors.accent-dusk}`) are documented.
- **Loading states / skeleton screens:** not captured from the marketing surface.
- **Universal Sans variable-font axes:** the proprietary face supports more weight axes than the marketing site exposes; only weight 400 is documented because that's the only weight the brand uses publicly.
- **Focus rings:** text-input and button focus-ring treatment is not visible on the captured surfaces. The brand likely uses a 1px white outline at full opacity, but precise extraction was not reliable.
- **Nested product canvases:** the Grok chat interface, API console, and developer documentation surfaces likely extend the system with code-block and tool-display primitives that this spec does not capture.
