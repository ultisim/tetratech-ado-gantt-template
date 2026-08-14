# Video Walkthrough Script (Loom, ~5 min)

A rough script for recording the demo Loom that ships with this repo. Adjust to your voice — this is a starting point, not a script to read.

**What to record on:** the finished dashboard, ideally your live Force Account instance so the data feels real. Screen record + webcam + mic. Landscape.

**Recording setup:**
- Have `<SITE_URL>` open in one tab
- Have `<SITE_URL>/setup.html` open in a second tab
- Have `https://dev.azure.com/<YOUR_ORG>/<PROJECT>/_boards/board` open in a third tab
- Signed in as an admin

---

## Opening (0:00 – 0:30)

> "Hi — I'm Linda, and this is a quick walkthrough of the ADO Gantt Dashboard template. It's a self-hosted dashboard that renders your Azure DevOps projects as an interactive Gantt chart, timeline, and sprint review view. You host it in your own Azure — no dependency on us."

> "It syncs live from ADO every five minutes. Every ADO project you add appears in a dropdown at the top. Let me show you what it looks like."

---

## The dashboard tour (0:30 – 2:30)

**Show the Gantt view.**

> "This is the Gantt chart for one project. Green bars are done, blue are in progress, grey are pending. The red vertical line is today. And this purple bar with the lightning bolt — that's the critical path, computed automatically from ADO dependency links."

**Hover over a critical path item.**

> "Hovering shows what it depends on and what it's blocking, so you can see at a glance what's holding up the plan."

**Click ▶ on an Epic to expand.**

> "The hierarchy expands from Epic to Feature to Product Backlog Item to Task, all the way down."

**Switch to Sprint Review.**

> "The Sprint Review view is what I actually use to prep for sprint retros. Pick a sprint, and it lists every backlog item and its child tasks with completion status. There are Copy as Email and Download as Word buttons — I paste the email straight into Outlook for stakeholders who want the status without opening ADO."

**Switch projects in the header dropdown.**

> "And I can flip between all my ADO projects here in the header. Each one gets its own Gantt, its own critical path, its own sprint review."

---

## Managing projects (2:30 – 3:30)

**Switch to the setup.html tab.**

> "Adding a project is quick. This is the admin page — Manage Projects — anyone with the admin role in Azure Static Web Apps can access it."

**Click Add a project.**

> "Fill in a slug, display name, ADO org, ADO project, and a Personal Access Token. The dashboard tests the token against ADO before saving anything — if the token doesn't work, you get an error immediately instead of a broken dashboard later."

**Point at the admin secret field.**

> "This admin secret is optional. If you set it, you unlock the bulk-migration endpoints — moving 50 items to a different sprint in one API call, closing all code reviews after a sprint, importing items from a CSV. The runbook has curl examples for all of that."

---

## Install (3:30 – 4:30)

> "How you get here: click 'Use this template' on the GitHub repo. That gives you your own copy under your own account. Then you run one command locally — `npm run setup` — and a wizard walks you through Azure sign-in, resource provisioning, and Entra app registration. Ten minutes end to end."

**Optionally show the setup wizard UI briefly (localhost:3000).**

> "The wizard provisions a Static Web App, a Key Vault, and a Storage Account, all in your subscription. Your PATs live in Key Vault — never in code, never in git. The wizard invites you as the first admin. After that, you never need the wizard again — you add projects through the setup page inside the deployed dashboard."

---

## Wrap (4:30 – 5:00)

> "Everything runs in your Azure — you own the data, the auth, the whole stack. The dashboard is MIT-licensed, so fork it, rebrand it, ship it. All the operational how-tos are in the RUNBOOK.md in the repo."

> "Questions? [contact info]. Have fun."

---

## Post-recording checklist

- [ ] Trim silence at the start and end
- [ ] Add captions (Loom auto-generates — review and fix)
- [ ] Set the thumbnail to the Gantt view at ~0:35 (most visually striking)
- [ ] Link the Loom in the README below the "Get started in 15 minutes" section
