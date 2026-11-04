---
name: ux-design
description: 'UX design guidance: user flows, information architecture, interaction states, error/empty/loading behaviour, accessibility, and usability heuristics. Use when designing or reviewing how a feature behaves for the user: new flows, screens, onboarding, sharing/joining flows, settings, or any change to what the user does step by step. Pairs with ui-design for the visual layer.'
---

# UX design

UX decides **what the user does and how the product responds**. Visual styling
is `ui-design`'s job. Project decisions in `docs/conventions.md` and
`docs/decisions/` override anything here.

## Process
1. **Who and why.** Name the user (from the spec's stories), their goal, and
   their context: device, attention, connectivity, how often they do this.
2. **Map the flow** as numbered steps, including every branch:
   happy path → validation errors → network/permission errors → cancel/back →
   resume later. Mark the step where the goal is achieved.
3. **List the screens/components each step needs.** Reuse existing ones first.
4. **Define every state** for each: initial, loading, empty, partial, success,
   error (recoverable vs not), disabled, offline/reconnecting.
5. **Write the microcopy** for buttons, errors and empty states. Short, specific,
   and saying what to do next ("Can't reach the group. Retrying…", not "Error").
6. **Check against the heuristics below** and the acceptance criteria.

## Heuristics (check each flow)
- **Visibility of status:** the user always knows what's happening
  (connected? synced? whose page is this?).
- **Match the real world:** the user's words, not internal terms (say "group
  code", not "room ID").
- **Control and undo:** easy exit, back, cancel, and undo for destructive actions.
- **Consistency:** same action, same name, same place everywhere.
- **Error prevention over error messages:** constrain inputs, confirm only the
  truly destructive.
- **Recognition over recall:** show options; don't make users remember codes or
  steps across screens.
- **Minimal steps:** count taps/clicks to the goal; remove any that don't earn
  their place.

## Realtime / shared-session patterns
- Show **who's in control** (e.g. the group owner) and **who's connected**.
- Joining by code/PIN: large readable code, copy/share action, clear failure
  message for wrong or expired codes, no hint whether a code exists.
- Connection loss: keep the user's current content visible, show a
  non-blocking "reconnecting" state, and resync automatically without
  surprising jumps. If the view must jump, say why ("Following the host to page 12").
- Leaving: say what happens to the group and to the other members.

## Accessibility (part of UX, not an extra)
- Every action reachable by keyboard; logical focus order; visible focus.
- Every interactive element has an accessible name; icons-only buttons get labels.
- Don't rely on colour alone for state; announce live changes (ARIA live
  regions for "page changed", "connection lost").
- Respect reduced-motion and text-size settings; touch targets ≥ 44×44 px.

## Output (into design.md)
Flows (numbered), screen/component list, state table per component, microcopy,
accessibility notes, a mapping from acceptance criteria to screens, open questions.
