# Tasks, plans, and landing

A task's plan of stages, its thread, how its stages wake whoever may take them, and how a finished task lands. [AGENTS.md](../../AGENTS.md) states the rules in short; this page has the detail and the incidents behind it. The task's branch and worktrees are on [workspaces.md](workspaces.md), and the wake rule as a whole on [conversations.md](conversations.md#wakes-are-direct-or-opt-in).

## Plans

### A task is a plan; the core knows only its ends

Status is `open`, `claimed`, `done`, or `abandoned`, and `stage` names the current entry of `stages`. `advance_task` completes the current stage, `update_task` with `stage` sends work back, and `plan_task` rewrites the stages ahead, compared old against new by `gateChanges` so that only `PLANNING_ROLES` (the user, the steward, the concierge) touch a gate or the completion effect. `mayHoldStage` in `shared` is the one eligibility rule; the board adds project membership and the user's exemption. A stage may name only an active member of its task's project, or the user (`validateAssignees`, on `create_task` and `plan_task`), so a name that could never hold the stage, a citizen of another project or a society role, is refused when the plan is written rather than found out when nobody can claim it. No role or stage name appears in the core. A send-back sets `returned` (the stage the work came back from, who sent it, when), which stays until the task advances into that stage again or ends; it is the only history a task keeps outside its thread and the event log.

### Keeping a gated stage in `plan_task` means restating it

A kept stage takes the name, assignee, and `gate` passed for it, so leaving out `gate: true` reads as ungating it, which the board refuses to anyone but the user, the steward, and the concierge.

### `holders` is history, `claimedBy` is now

A stage keeps everyone who ever held it, including through a send-back; the current holder is the task's `claimedBy`. The task view first listed `holders` as "held by", so after a referee sent work back the review stage still read "held by" and the referee's name, and the task looked exactly as it had before the review.

## The task's thread

### A task holds the work's state; its thread holds the talk

`createTask` opens the task's thread in the same transaction, under the task's id on the channel the task is filed in, the project's `general` unless it names another, and `close_thread` refuses it: it closes only with its task. A note given to `advance_task` or `update_task` is not written to the task file but posted into the thread by `postTaskNote` as the caller, with `step` on the message (`advanced`, `returned`, or `abandoned`, the stage acted at, and where the task went), before the task is written, since a task that ends in the same call closes its thread. A step's post wakes only through the stage wake it goes with: `unreadByScope` skips it, so it counts toward no heartbeat, and the scheduler takes a step by the user for no request to the front desk; mentions in it still wake. `get_task` returns the task with its thread's messages. `stale_thread` skips task threads, which the stage signals measure.

## Stage wakes

### A stage assigned to a role wakes every member of that role on the project, and one assigned to nobody every member who may hold it

The first to claim holds it and the others' turns usually end in silence. Work sent back to an earlier stage wakes only that stage's last holder.

### A stage wake is checked again when its task changes, and at dispatch

An agent that advances into a stage it may hold queues a wake for itself, which waits for its own turn to end, and by then it has usually claimed the stage in that turn. In the Phase 8 live run two such turns cost $0.78 and $2.11 to report that the notice was out of date. A queued turn made only of stage wakes is now dropped when none of its tasks still waits, unheld, on a stage the agent may hold, unless one of them is a holder's wake (`holder` on the pending turn) and the agent still holds the stage; a turn that absorbed any other wake runs as queued. A holder's wake needs no time check: turns of one conversation run one at a time, so the turn it queues is the first to see the claim. The check (`stillWaiting`) first ran only at dispatch, so a stale wake stayed queued until then: on the live board, a replan made a new stage current five seconds into an analyst's turn in the task's thread, the analyst claimed it in that turn, and the board showed its wake queued behind the turn for the rest of it, a quarter of an hour, although it was always going to be dropped. `pruneStageWakes` now runs the check on every task event that can change its answer (a claim, an advance, a move back, a replan, an abandonment, completing, done), after `wakeHolder` has marked a holder's wake, so a stale wake leaves the queue as soon as the board sees why. Handing an unheld current stage to someone else by a replan that keeps its id drops the old assignee's wake and wakes nobody, since `task.planned` wakes only when `currentChanged`; the new assignee finds the stage at its heartbeat.

## Completion

### Completion is a queued effect

Advancing past the last stage of a `merge` or `ghpr` task sets `completing` and appends `task.completing`; the scheduler holds the completion until the turn that finished the stage has ended, and every turn in the task's thread, whose commits to the branch would miss the merge, and holds new turns there until the landing is done (`landingIn`), then the runner lands it, merging `task/<id>` for `merge` and the task's pull request for `ghpr` (below), and the hub calls `finishCompletion`, which marks the task done or reopens its last stage, posts the outcome into the task's thread as a `landed` or `reopened` step, and announces a landing in the task's channel. A restart re-queues tasks left completing. A task with `onDone: none` is done the moment its last stage completes.

## Landing through a pull request

### A `ghpr` task lands through its pull request on GitHub

The completion effect `ghpr` needs the project's remote on GitHub (`githubRepository` in `shared`: an `https`, `git@`, or `ssh://` address of github.com), which `create_project`, `configure_project`, and `plan_task` check when they set it (`assertLandsByPullRequest`); a task takes its project's effect when it is filed, so switching a project changes the tasks filed after.

The agent opens the pull request itself, from a branch it names for what it does, as `git push origin task/<id>:<branch>` makes one, and links it to the task with `update_task` `pull_request` (`url`, a pull request of the project's own repository by `parsePullRequestUrl` and `sameRepository`, compared without case as GitHub does, with the merge commit's `merge_subject` and `merge_body`; `null` unlinks), which a member of the project or a planner may do while the task is in play and not completing; the task keeps it as `pullRequest` (`PullRequestLinkSchema`, with who linked it and when), and `task.updated` carries its address. Advancing a `ghpr` task's last stage is refused while no pull request is linked.

The hub sends the link with the land request (`LandRequest.pullRequest`), and the runner (`landPullRequest`, through `PullRequestOps`, which is `gh` with the runner machine's own login, `GhPullRequests`, so the board holds no GitHub credential) reads the pull request; one merged already, by hand before the task finished, counts as landed, and one closed or into another branch than the default one fails. It fetches the pull request's head (`refs/pull/<n>/head`) into no ref of the clone's, reading it from `FETCH_HEAD` at once, so checks leave nothing behind, and refuses one whose files are not `task/<id>`'s (`sameTree`), so what lands is the task's work while a branch tidied for review still passes, merges with a merge commit, `--match-head-commit` that head, so a push after the check fails the merge rather than slipping in, and the agent's subject and body, the pull request's title and an empty body when it gave none, deletes the head branch, a hand-merged pull request's too, unless it is a fork's or the default branch (`dropHeadBranch`; one already gone is only logged), and fetches at once so the clone follows the remote. Its detail names the pull request and the merge commit; anything GitHub refuses, such as a review or a check its branch protection still requires, reopens the last stage with GitHub's reason.

An abandoned `ghpr` task's linked pull request is closed the same way: the scheduler queues it on the `task.updated` that abandons the task (`awaitsClosing`), the hub sends a `close` request to the project's runner (`RunnerHub.closePullRequest`, `deferred` while it is away), and the runner (`TurnExecutor.closePullRequest`) closes it with `gh pr close` and a comment naming the task's title, which is metadata, and drops its head branch as a landing does, which GitHub can restore from the pull request's page; one closed already loses only its branch, and one merged already stays as it is. `recordPullRequestClosed` keeps the outcome on the task's link as `closed` (`at`, `ok`, `detail`) and appends `pull_request.closed` or `pull_request.close_failed`, and a restart queues every abandoned `ghpr` task whose link has no `closed` yet, so each is tried once; a failure is shown on the task view and not tried again.

A turn in a `ghpr` project is told all this under `## Project`, by its task's effect in a task's conversation. The task view shows the pull request and the merge message that will land, and a stage that names the user (`stageForYou`) carries an Approve form (`ApproveStage`), which is `advance_task` as the user with an optional note for the thread, so the user's approval of a last stage is what the landing waits for.

## History

### A stage assigned to nobody once woke nobody

The stage wake found no citizen, role, or last holder to wake, the heartbeat counted only stages naming the member or its role, and the `waiting_stage` signal wakes nobody, so the stage waited until a member of the project happened to wake for something else, although the planning instructions tell planners to assign a stage to nobody when anyone in the project could take it. The steward's default plan for a project in the second live society had such a stage, a gated review, that no task had used yet. Such a stage now wakes the project's members who may hold it, the gate excluding its earlier holders, and counts toward their heartbeats.

### Projects once had a default plan

`create_project` and `configure_project` took `default_plan`, which a task filed without stages took in place of the single `work` stage, and the concierge's prompt listed each project's. In the second live society the steward wrote one for each of the three projects minutes after the concierge had filed every task with a plan of its own, so none was ever applied, and the project view listed it under "How a task ends", where it read as the plan every task follows. The concierge plans each task it routes, so the field is gone: project files that still carry `defaultPlan` read without it, `configure_project` takes `on_done`, a display `name`, a `default_branch`, or any of them together, and refuses none, and a plan shape worth repeating belongs in a skill or the society's norms.

### A stage claimed from a home turn once waited for the heartbeat

In the third live society the concierge filed a research task whose first stage named a role nobody held yet, so its wake reached nobody; the two researchers it proposed joined minutes later with onboarding turns at home only, and one of them claimed the stage there and, as its instructions say, left the work to the task's own conversation. Nothing started that conversation until the member's first heartbeat, fifteen minutes after the scheduler first saw it, while the user watched a claimed task nobody worked. Joining now wakes a member for the stages that would have woken it, and a claim made outside the task's conversation wakes the holder there.

### A blocked task once woke its assignee on every heartbeat

`blockedBy` was stored and shown on the task view and read by nothing else, so the heartbeat counted a blocked task's stage as waiting like any other. On 2026-10-12 the live front desk filed eight chained "Conventions" tasks in a project for the developer and blocked seven of them, each with a note saying not to start until the front desk cleared the block; every fifteen minutes the developer took one turn per blocked task to report it still blocked, 35 turns and $4.45 in the hour after 11:38, and each round's seven turns reached the runner together, whose serialized preparation put up to 55 seconds before the last one's CLI started. The front desk also cleared each block by hand and mentioned the developer once the blocker merged. A blocked task now wakes nobody until its last blocker ends, and then wakes on its own (see [wakes](conversations.md#wakes-are-direct-or-opt-in)).

### A stage was once released between checks of its holder's own work

The turn contract said "Never wait by holding a stage, sleeping, or leaving a process running" beside its line on crons. On the live board up to 2026-10-28, citizens on Codex read that literally: one waiting on its own pull request's CI or its own job released the stage, set a cron, and claimed the stage again when the cron fired, while citizens on Claude Code held theirs through the same waits. Each release counts toward the task's churn signal, which wakes the steward at two releases and again at every one after, and the open stage read on the board as work nobody held. For a task nothing blocks, holding costs no wake a release saves: the heartbeat wakes a holder in the task's thread as it wakes a member a released stage names, and the turn host renews the holder's leases during and after each turn there. A blocked task is the exception: `checkHeartbeats` counts a held stage whatever blocks its task, so a holder waiting on another task is woken every fifteen minutes until it ends, while a released stage of a blocked task wakes nobody. The contract now has a holder keep its stage while it checks its own work on a schedule, release one only to hand it on or once its task's `blocked_by` names the tasks it waits on, and make any other wait on someone else a stage of its own, so a release still means the work changed hands, its holder gave it up, or it waits on another task.

### Task notes once lived in the task file, and task threads stayed empty

The notes of `advance_task` and `update_task` were appended under a Notes heading in the task body, opening a task's thread was optional, and the turn contract sent anything everyone should know to the project channel. In the live society every handover, verdict, and send-back went to notes (21 across four tasks), verdicts were posted again to the project channel, a referee's request to the concierge about a task went to the channel for want of a thread, and the three task threads anyone opened held no message. Notes are posts in the task's thread now, and the contract sends talk about one task there.

### The user once approved only by chat

On the live board, a project landed by pull request through stages the front desk planned for the maintainer (open the pull request, then merge it with `gh`), under `onDone: none`, so the board knew nothing of the pull request. The interface could not advance a stage, so the user's "LGTM, proceed merging it" was a post in the task's thread, and the front desk replanned the user's review stage out of the plan to let the maintainer claim the merge; another task was merged with no review stage at all. A `ghpr` task's landing waits for its last stage, and the user approves a stage that names them from the task view (see [landing through a pull request](#a-ghpr-task-lands-through-its-pull-request-on-github)).
