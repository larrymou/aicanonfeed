# Labels

Create these labels in the repository (Settings → Labels) or via API before production runs:

| Label | Color | Used for |
| ----- | ----- | -------- |
| `proposal` | #0e8a16 | New rule proposals awaiting AI pre-review |
| `voting` | #1d76db | Passed pre-review; open for 👍/👎 |
| `rejected` | #d73a4a | Pre-review rejected |
| `ratified` | #5319e7 | Vote passed **and** rule PR merged |
| `ratified_pending_merge` | #a876c9 | Vote passed; PR open — rule not active until merge |
| `defeated` | #b60205 | Settlement failed vote |
| `expired_no_quorum` | #fbca04 | Not enough approve votes |
| `do-not-merge` | #000000 | Maintainer kill switch for rule PRs |

## State machine

```
proposal → voting → ratified | ratified_pending_merge | defeated | expired_no_quorum
proposal → rejected
```

`ratified_pending_merge` means votes passed but the rule file is not on `main` yet (stars &lt; 200 human-merge gate, kill switch, or merge failure). Each governance cycle reconciles these: merged PR → `ratified` and close; PR closed without merge → `rejected` and close; open PR below `AUTO_MERGE_MIN_STARS` stays pending until a maintainer merges.

When transitioning, **remove** the previous label. Never leave `proposal` and `voting` on the same issue.
