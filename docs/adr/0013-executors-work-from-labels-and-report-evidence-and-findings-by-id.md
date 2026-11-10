# Executors work from entail's labels and report evidence and findings by id

entail and an executor share no API. They meet on the issue and the PR, in the same way on GitHub and GitLab. entail marks the issue and posts what it requires. The executor links its PR to the issue and reports **evidence** per criterion, or posts **findings** per investigation question. entail trusts those reports as honest and verifies what the forge itself reports. Nothing in the contract is specific to firstmate, which is one executor among others. VISION.md says entail works with or without firstmate and prefers mechanical checks wherever a criterion allows one.

## The contract

1. **Marking.** An issue carries at most one `entail:` label, matching the ticket's state:
   - `entail:cleared` while the ticket is cleared or landing, because its criteria are in force;
   - `entail:investigate` while it is being investigated;
   - `entail:raised` while it is on the board, waiting for the owner (see the amendment below).

   entail removes the label when the ticket leaves that state: to the board, back to deciding, declined, cancelled or merged. An executor can trust the label alone. entail does not react to anyone else adding or removing its labels, because its records are the authority (ADR-0005).
2. **What entail requires.** The intake comment (ADR-0007) lists criteria C1…Cn, or, for an investigation, the questions Q1…Qn that the investigation must establish. Its second section ends with one fixed line telling any executor how to report, so no executor needs an integration to learn the contract.
3. **Who counts: anyone, by default** (owner). Any PR linking a cleared issue, and any findings comment on an issue being investigated, is checked, whoever posted it. A PR that meets its criteria merges whoever opened it. The owner's reason: "I said Anyone because my projects are not popular rn... If it looks like anybody is using it, I'll change it perhaps." So this is a per-repo setting, **anyone** by default. Its alternative, **owner plus listed executors**, counts only the owner's own account and accounts listed for the repo. Under it, entail does not check another account's PR or findings and comments once that it lands work only from the repo's executors. Tightening a repo is then a settings change, not a redesign. The safeguards stay in both modes:
   - the landing check still verifies the ticket's criteria and the repo's generic criteria at the pinned head (point 8);
   - a diff that touches a pinned path still goes to the owner, and VISION.md is pinned in every repo (ADR-0004, ADR-0011).
4. **Linking a PR.** The PR closes the issue with the forge's own closing keyword (`Fixes #n` or `Closes #n`). entail reads the link from the forge's linked-issue data: closing issue references on GitHub, and the issues a merge request closes on GitLab. It does not parse the text. A PR that only mentions the issue is not the ticket's PR. A PR linking an issue with no criteria in force (deciding, on the board or investigating) is not checked; entail comments once that the issue has no criteria yet.
5. **Evidence.** The PR carries an **evidence** section under the heading `entail evidence`, with one entry per criterion id: `C1: <what was run or done> — <result>`. The section may be in the PR description or in a PR comment by the PR's author, because some executors' pipelines rewrite the description on every push. If several sections exist, the latest one at the checked head counts. Mechanical checks are verified from forge data first, and evidence feeds only the graded part, quoted word for word (ADR-0005). A criterion with no entry is not met. The repo's generic criteria take entries the same way, under the ids the landing check gives them.
6. **Findings.** An executor reports an investigation as a **findings** comment on the issue under the heading `entail findings`, with one entry per question id. entail decides the ticket again on the first findings comment posted after the investigate comment, whoever posted it, because a ticket is investigated at most once (ADR-0006). Later findings comments are ignored. A question with no entry stays unknown, so the ticket needs the owner.
7. **No pickup signal.** entail neither asks for nor reads a sign that an executor has taken an issue. Who picks up what is work management, which belongs to a separate utility, and VISION.md resists work-management traffic on the board. Executors may coordinate among themselves, for example by assigning the issue; entail ignores it.
8. **Trust.** Claims in evidence and findings are taken as honest, and entail never redoes an executor's validation. Before merging, entail reads the forge's own state live at a pinned head: the PR is open, not a draft, mergeable and conflict-free; every check is green at that head; and every check the forge requires has reported. The merge is pinned to that head, so a later push makes it fail (owner, modelled on firstmate's merge guard).

## Considered options

- **Only the owner's account and executors listed per repo** as the fixed rule: not the default, because the owner chose anyone. A public `entail:cleared` label is an open offer, the criteria and generic criteria are checked either way, and pins still bring a touched path to the owner. It stays available as the per-repo alternative, so a repo that gains users can tighten without a redesign.
- **Only accounts with write access**: rejected. It is neither the open offer the owner chose nor a list the owner controls.
- **A firstmate-specific hand-off** (an inbox note or a task API): rejected by the owner. It would make entail depend on firstmate, which VISION.md resists.
- **Evidence only in the PR description**: rejected, because a pipeline that owns the description would overwrite it.
- **Parsing issue references from PR text**: rejected in favour of the forge's own link data, which both forges expose and which is what closes the issue on merge.
- **A "taken" label or assignment that entail tracks**: rejected as work management.

## Consequences

- The intake comment gains the fixed reporting line, and the investigate comment numbers its questions Q1…Qn.
- The same contract applies to any executor, including a person.
- The "who counts" setting and its executor list are set where the other per-repo settings are, decided on [How is a repo enrolled, and what per-repo settings exist?](https://github.com/omkarbhale/entail/issues/25).
- Several PRs for one ticket and generic criteria ids are decided in ADR-0014, on [How does entail verify a landed PR's evidence, and how is a failing PR routed?](https://github.com/omkarbhale/entail/issues/22). Routing a failing PR beyond a comment is a later effort.
- Decided on [What is the contract between entail and any executor?](https://github.com/omkarbhale/entail/issues/30).

## Amendment: a PR linking an issue whose ticket ended

Point 4's one comment for a PR linking an issue with no criteria in force also covers an issue whose latest ticket is final as declined or cancelled. The PR is not checked or merged. The comment names the end state, links the comment that gave its reason, and says the issue has no criteria in force unless the owner pulls it in again (ADR-0020) and it is cleared. If that happens, the PR links the new ticket and is checked against its criteria. A PR linking a merged ticket gets ADR-0014's "already merged" comment instead. Under "owner plus listed executors", another account's PR gets only point 3's comment, as before. Each PR gets the comment once per ticket.

Settled after the MVP-1 spec was assembled, as an engineering call the owner delegated (open point 7 of `docs/spec/mvp-1.md`). The executor's question is the same as for a ticket with no criteria yet, why the PR is not checked, so one existing comment answers it. Staying silent was passed over, because an executor would be left waiting on a check that never comes.

## Amendment: `entail:raised` marks a ticket on the board

An issue whose ticket is on the board, waiting for the owner, carries `entail:raised`. entail adds it when it raises the ticket, after removing any label the ticket carried before, such as `entail:cleared` when a re-check or a touched pin at landing raises it. entail removes it with the call that takes the ticket off the board: an answer (going ahead, "don't go ahead" or "Merge this PR as it is"), a withdrawal (an issue edit, a vision or pin change, or a new push) or a cancel (the issue closed, or the repo unenrolled). Where the ticket then has criteria in force, `entail:cleared` replaces it, never beside it. A ticket going ahead returns to deciding with no label until its criteria clear it.

The label only marks state. It carries no question text, and adding or removing it by hand answers nothing: the question and its answer stay on the board (ADR-0008, ADR-0012), and entail does not react to anyone else changing its labels. It tells an executor that the issue is not ready for work because it waits for the owner.

Decided on [I want entail to mark issues not just cleared, but raised as well.](https://github.com/omkarbhale/entail/issues/168), which entail cleared as unopposed: the vision says nothing about labelling issues on the forge, and a label with no question text moves neither the question nor its answer off the board.
