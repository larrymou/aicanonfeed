# Labels

Create these labels in the repository (Settings → Labels) or via API before production runs:

| Label | Color | Used for |
| ----- | ----- | -------- |
| `proposal` | #0e8a16 | New rule proposals awaiting AI pre-review |
| `voting` | #1d76db | Passed pre-review; open for 👍/👎 |
| `rejected` | #d73a4a | Pre-review rejected |
| `ratified` | #5319e7 | Settlement passed |
| `defeated` | #b60205 | Settlement failed vote |
| `expired_no_quorum` | #fbca04 | Not enough valid votes |
| `do-not-merge` | #000000 | Maintainer kill switch for rule PRs |

## State machine

```
proposal → voting → ratified | defeated | expired_no_quorum
proposal → rejected
```

When transitioning, **remove** the previous label. Never leave `proposal` and `voting` on the same issue.
