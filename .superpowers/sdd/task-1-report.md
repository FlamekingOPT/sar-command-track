# Task 1 Report: Firestore Rules — `zoneRequests` Collection

## Status: DONE_WITH_CONCERNS

## What Was Completed

1. **File Edit**: Successfully edited `firestore.rules` to add the `zoneRequests` collection rule block:
   - Location: Top-level match block, between `searcherLinks` and `searches`
   - Rules added:
     - `allow read: if true;` (picker page polls its own request doc)
     - `allow create: if true;` (open trust model, same as tracks/markers)
     - `allow update: if false;` (only bot via Admin SDK can update)

2. **Syntax Verification**: The updated file matches the task brief specification exactly:
   - File: `C:\Users\Jack\dev\sar-command-track\firestore.rules`
   - Structure is valid Firestore rules syntax
   - Rule block placement is correct (top-level, not nested)

3. **Commit**: Committed just the `firestore.rules` change.
   - Commit: `5eb28b1` — "feat: firestore rule for zoneRequests collection"
   - The `.superpowers/sdd/task-1-brief.md` and `task-1-report.md` workspace files were deliberately excluded from the commit (scratch/workspace files, not part of the codebase).

## What Was NOT Completed (Deferred, Not a Failure)

**Firebase Deploy**: `firebase deploy --only firestore:rules` was not run in this task.

Per the controller's decision, this step is **deferred** — it will be bundled with other deploys and run later, right before the plan's final Task 15 smoke test. This is an intentional sequencing decision by the user, not a blocker or failure of this task:

- Firebase CLI is not authenticated on this machine and requires an interactive browser login.
- The user will perform `firebase login` themselves later, on their own machine/schedule.
- The rule change is verified correct and is committed to the repo, ready to deploy whenever the bundled deploy happens.

## Concern for Downstream Tasks

The `zoneRequests` Firestore rule exists in code and is committed, but is **not yet live** in the Firebase project (`sar-trackhatzolah`). Any task that depends on this rule being enforced in production/staging Firestore should account for the fact that deployment is still pending until the bundled deploy before Task 15's smoke test.

## Files Modified

- `firestore.rules`: Modified, verified correct, and committed (`5eb28b1`). Deploy deferred per user decision.

## Self-Review

The file edit is correct and complete:
- Rule syntax is valid Firestore rules v2
- Placement matches brief specification exactly
- Comments are included as specified
- File structure is preserved and correct

The only remaining step — deploying to Firebase — is intentionally deferred by the controller's decision, to be bundled with other deploys ahead of the final smoke test.
