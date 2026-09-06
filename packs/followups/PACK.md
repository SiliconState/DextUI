---
name: followups
description: Who owes you a reply, a document or a payment, most overdue first — with reminder drafts you send yourself. Overdue invoices are pulled in automatically. Nothing is ever sent for you.
ui-title: Follow-ups
ui-starter-prompt: Who owes me a reply, a payment or a document? Show the list and draft the reminders — I'll send them myself
ui-artifact: table
ui-time-to-first-artifact: 30
ui-requires: [approval:auto-write]
ui-gallery: true
ui-tags: [clients, tasks]
ui-icon: followup
ui-personas: [business]
---

# Follow-ups

State: `.followups/items.csv` (`id,who,what,due,status,source,note`).
Overdue unpaid invoices in `.invoices/register.csv` become payment follow-ups on
every list (source `invoice:<number>`), so nothing slips between packs.

## Workflow

1. `list_followups` — read the overdue ones first, plainly ("Acme is 12 days late on €400").
2. When the user mentions something owed to them in conversation ("she said she'd
   send the contract by Friday"), `add_followup` with who / what / due.
3. `draft_reminders` (tone polite | friendly | firm, `sign_as` the user's name)
   produces one draft per overdue item as plain text blocks. The **user** copies
   and sends; you never send anything, and you say so.
4. After they send: `mark_followup` status=sent; when resolved: done.

Dates are the runtime's; do not compute "days late" yourself.
