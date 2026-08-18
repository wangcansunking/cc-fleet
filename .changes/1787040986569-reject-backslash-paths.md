---
bump: patch
---
Fleet apply now refuses backslashes in profile paths on every platform. A path like `..\evil.md` escapes the skill directory on Windows but is an ordinary contained filename on Linux, so one profile would have produced two different layouts across a mixed fleet — and the traversal guard would have held on only one of them.
