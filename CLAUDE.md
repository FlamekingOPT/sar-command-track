# SAR Command & Track

## Tester feedback

Command-center has a "🐛 Feedback" page (Firestore collection `feedback`) where field testers submit bug reports and feature requests, optionally with a screen recording attached. At the start of a session working on this repo, check that collection (via the Feedback page in the app, or query Firestore directly) for new (`status: 'new'`) reports and factor them into what to work on — treat them as a live backlog, not just Jack's own requests.
