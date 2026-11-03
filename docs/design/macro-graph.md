# Macro graph editor (n8n-style)

Status: proposed, 2026-11-04

## Goal
Replace the step-list / flow editor with a canvas of connectable node cards, like n8n or Node-RED.
- Triggers start a run; data and control flow along wires.
- Users can use premade "recipes", build their own graphs, and save groups of nodes as reusable custom nodes.

## Model (stored in `macros.json`, version 3)
```
Graph { id, name, version: 3, nodes: Node[], edges: Edge[], vars: VarDecl[], meta }
Node  { id, kind, params, position: {x,y}, label?, disabled? }
Edge  { id, from: {node, port}, to: {node, port} }
```
- **Ports.** Each node kind declares typed ports in the contract:
  - Control ports: `in`, `out`, `true`/`false`, `each`/`done`, `error`.
  - Value ports: `number`, `string`, `item`, `entity`, `position`, `any`.
- **Wiring rules.** Control wires decide what runs next. A value wire feeds a parameter; it replaces the typed-in value.
- **Migration.** v2 linear macros convert to graphs mechanically: the trigger node is followed by the steps chained in order, and `if`/`loop` become branch and loop nodes. The engine keeps running v2 too, so nothing breaks.

## Node catalogue (from the existing contract, plus additions)
- **Triggers:** manual, on join, world change, timer/cron, chat match, player appears, health/food below, inventory full, item picked up, macro finished, webhook/Discord command.
- **Flow:** if, switch, loop N, while, for-each (items, players, entities), wait, wait-until, parallel, merge/join, stop, try/catch.
- **Actions:** chat, command, move/goto, look, jump/sneak/sprint, click/attack/use, autoclick, select hotbar, hold item, drop, deposit, open/use GUI, close GUI, reconnect, disconnect, notify (Discord/Telegram), run macro.
- **Data:** get inventory count, get entity count/nearest, read lore, read position/health/food, regex extract, math, compare, text format, set/get variable (run, account, persistent), random.
- **Custom:** a "group" node whose inner graph has its own input and output ports. Users can save it to their library and share it with the existing share links.

## Premade recipes (shipped as read-only templates; duplicate to edit)
- Auto-sell when inventory is full.
- AFK fishing with an auto-repair check.
- Player-nearby alert with a screenshot, then log out.
- Timed `/kit` claim.
- Mob farm: attack loop plus deposit.
- Server restart: rejoin and run `/server towny`.
- Eat and totem safety net (UI over the new engine safety settings).
- Daily vote reminder.

## Editor UX
- **Canvas:** pan and zoom, a minimap, snap-to-grid, and box-select.
- **Cards:**
  - Each node is a card with a colored category header, an icon and a one-line parameter summary.
  - Ports are dots on the card edges. Drag from a port to connect.
  - Incompatible ports are greyed out while you drag.
- **Palette:** searchable, grouped like today's palette. Dragging a node onto a wire inserts it into that wire.
- **Inspector panel:** the right-hand side shows the selected node's form, generated from the contract schema (reusing the forms built for item 10).
- **Live run view:**
  - The node that is currently running is highlighted, and wires show the last value that passed along them.
  - Errors are pinned to the node that failed.
- **Validation:** shown before a run can start. It flags unconnected required inputs, cycles that have no wait in them, and missing triggers.
- **Other tools:** undo/redo, copy/paste (as JSON), keyboard access, and a JSON view.

## Engine
- **Runner:** a graph interpreter over the existing facade and action implementations, so behaviour stays identical to v2.
- **Execution model:**
  - A "token" walks along the control wires, and value ports are evaluated lazily.
  - Each node gets a step budget and the run gets a total time limit.
  - The existing input-ownership rules and the all-accounts stop conditions are reused.
- **Scope:** the same per-account isolation and targets (accounts or tags) as v2.

## Build stages
1. Contract: port and type declarations for every node kind, the graph model with validation and v2→v3 migration, and the interpreter. Fully tested headless.
2. Canvas editor: cards, wiring, inspector and palette (vanilla JS, no new dependencies).
3. Recipes library and custom group nodes, plus share links for graphs.
4. Live run view, and Discord/webhook triggers.
5. Mobile: read-only viewer with run/stop. Editing stays desktop-only at first.
